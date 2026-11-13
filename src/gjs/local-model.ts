import { Gio, GLib, Gtk } from "./gi.js";
import { type Gateway, HttpError } from "./gateway.js";
import { flag, type Present } from "./mcp-server.js";
import { type SettingsDocument, object, ownerHeaders } from "./settings-write.js";
import { button, column, confirm, errorText, label, sheet } from "./ui.js";

const path = "/api/local-model";
const inputs = {
  source: ["LOCAL_MODEL_SOURCE", "Путь к GGUF на шлюзе или репозиторий Hugging Face", ""],
  filename: ["LOCAL_MODEL_FILENAME", "Имя файла в репозитории", ""],
  port: ["LOCAL_MODEL_PORT", "Порт", "8766"],
  n_gpu_layers: ["LOCAL_MODEL_N_GPU_LAYERS", "Слоёв на GPU (−1 — все)", "-1"],
  n_ctx: ["LOCAL_MODEL_CONTEXT_LENGTH", "Длина контекста (0 — авто)", "0"],
  chat_format: ["LOCAL_MODEL_CHAT_FORMAT", "Формат чата", ""],
} as const;
const routes: Record<string, string> = {
  USE_LOCAL_MAIN: "Основная", USE_LOCAL_LIGHT: "Лёгкая", USE_LOCAL_CONSCIOUSNESS: "Фоновая",
  USE_LOCAL_FALLBACK: "Резервная", USE_LOCAL_HEAVY: "Тяжёлая (совместимость)",
};
export const localKeys = new Set([...Object.values(inputs).map(([key]) => key), ...Object.keys(routes)]);
type Input = keyof typeof inputs;

interface Status {
  status: string;
  error?: string;
  model_path?: string | null;
  model_name?: string;
  context_length?: number;
  port?: number;
  download_progress?: number | null;
  runtime_status?: string;
  runtime_install_log?: string;
  settings_application?: { pending_keys?: string[]; unknown_keys?: string[]; summary?: string };
}

const states: Record<string, string> = {
  offline: "Остановлена", downloading: "Скачивается", loading: "Загружается", ready: "Готова", error: "Ошибка",
};
const runtimes: Record<string, string> = {
  unknown: "Состояние рантайма неизвестно", ok: "Рантайм доступен", missing: "Рантайм отсутствует",
  installing: "Рантайм устанавливается", install_ok: "Рантайм установлен", install_error: "Ошибка установки рантайма",
};

export class LocalModel {
  private dialog?: any;
  private snapshot?: Status;
  private poll = 0;
  private reading?: { dialog: any };
  private action?: "start" | "stop" | "test" | "install";
  private unknownStart = false;
  private starting = false;
  private installing = false;

  constructor(private readonly gateway: Gateway, private readonly present: Present) {}

  show(settings: SettingsDocument, stage: (patch: SettingsDocument) => void, setup = false): void {
    if (this.dialog) return;
    const content = column(10);
    const dialog = sheet("Локальная модель", content);
    dialog.set_content_width(650);
    this.dialog = dialog;
    this.snapshot = undefined;
    const cancel = new Gio.Cancellable();
    const form = column(4);
    const fields = {} as Record<Input, any>;
    for (const key of Object.keys(inputs) as Input[]) {
      const [setting, title, fallback] = inputs[key];
      const field = new Gtk.Entry({ text: String(settings[setting] ?? fallback), placeholder_text: title });
      field.set_name(`local-model-${key}`);
      form.append(label(title));
      form.append(field);
      fields[key] = field;
    }
    const switches = (setup ? [] : Object.entries(routes))
      .filter(([key]) => key !== "USE_LOCAL_HEAVY" || Object.hasOwn(settings, key))
      .map(([key, title]) => [key, new Gtk.CheckButton({ label: title, active: flag(settings[key]) })] as const);
    const routeBox = column(4);
    for (const [, item] of switches) routeBox.append(item);
    if (!setup) form.append(new Gtk.Expander({ label: "Использовать локальную модель для…", child: routeBox }));
    const status = label("Читаю состояние шлюза…", "dim-label");
    status.set_name("local-model-status");
    status.set_selectable(true);
    const operation = label("", "dim-label");
    operation.set_name("local-model-operation");
    operation.set_selectable(true);
    const progress = new Gtk.ProgressBar({ show_text: true, visible: false });
    const log = label("");
    log.set_selectable(true);
    const runtimeLog = new Gtk.Expander({ label: "Журнал установки рантайма", child: log, visible: false });
    const current = () => this.dialog === dialog;
    const formBody = (start: boolean) => {
      const number = (key: "port" | "n_gpu_layers" | "n_ctx", min: number, max = Number.MAX_SAFE_INTEGER): number => {
        const text = fields[key].get_text().trim();
        const value = Number(text || inputs[key][2]);
        if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Укажите допустимое целое значение поля «${inputs[key][1]}».`);
        return value;
      };
      const source = fields.source.get_text().trim();
      const filename = fields.filename.get_text().trim();
      if (start && !source) throw new Error("Укажите источник модели.");
      return { source, filename, port: number("port", 1, 65535), n_gpu_layers: number("n_gpu_layers", -1),
        n_ctx: number("n_ctx", 0), chat_format: fields.chat_format.get_text().trim() };
    };
    const flow = new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.NONE, column_spacing: 6, row_spacing: 6 });
    const sync = () => {
      const state = this.snapshot?.status;
      const runtime = this.snapshot?.runtime_status;
      const active = this.starting || this.installing || state === "downloading" || state === "loading" || runtime === "installing";
      start.set_sensitive(Boolean(this.snapshot && !this.action && !active && state !== "ready"));
      install.set_visible(runtime === "missing" || runtime === "install_error");
      install.set_sensitive(!this.action && !active);
      test.set_sensitive(!this.action && state === "ready");
      stop.set_sensitive(!this.action && !this.starting && state !== "downloading"
        && (this.installing || state === "ready" || state === "loading" || runtime === "installing"));
    };
    const refresh = async (force = false) => {
      if (!current() || (!force && this.reading?.dialog === dialog)) return;
      const read = { dialog };
      this.reading = read;
      try {
        const data = await this.gateway.json<Status>("GET", `${path}/status`, undefined, {}, false, cancel);
        if (!current() || this.reading !== read) return;
        if (!data || !Object.hasOwn(states, data.status)) throw new Error("Шлюз не вернул пригодное состояние локальной модели.");
        this.snapshot = data;
        if (data.status === "loading" || data.status === "ready") this.unknownStart = false;
        if (data.runtime_status && data.runtime_status !== "installing") this.installing = false;
        const app = data.settings_application;
        status.set_label([states[data.status] ?? data.status, runtimes[data.runtime_status ?? "unknown"] ?? data.runtime_status, data.error,
          data.model_name || data.model_path, data.status === "ready" && data.port ? `порт ${data.port}` : "",
          data.status === "ready" && data.context_length ? `контекст ${data.context_length}` : "", app?.summary,
          app?.pending_keys?.length ? `Ожидают применения · ${app.pending_keys.join(", ")}` : "",
          app?.unknown_keys?.length ? `Текущие значения неизвестны · ${app.unknown_keys.join(", ")}` : "",
        ].filter(Boolean).join("\n"));
        runtimeLog.set_visible(Boolean(data.runtime_install_log));
        log.set_label(data.runtime_install_log ?? "");
        const fraction = data.download_progress;
        progress.set_visible(data.status === "downloading" && typeof fraction === "number");
        if (typeof fraction === "number") progress.set_fraction(Math.max(0, Math.min(1, fraction)));
      } catch (error) {
        if (current() && this.reading === read) {
          this.snapshot = undefined;
          status.set_label(errorText(error));
        }
      } finally {
        if (this.reading === read) this.reading = undefined;
        if (current()) sync();
      }
    };

    const perform = async (action: "start" | "stop" | "test" | "install") => {
      if (this.action || !current()) return;
      this.action = action;
      sync();
      try {
        if (action === "start") {
          const body = formBody(true);
          if (this.unknownStart && !await confirm(dialog, "Запустить модель повторно?",
            "Шлюз не подтвердил предыдущий запуск. Повтор может начать ещё одну загрузку.", "Запустить")) return;
          if (!current()) return;
          this.starting = true;
          operation.set_label("Запрос на запуск отправлен. Шлюз может скачивать файлы модели.");
          try {
            const reply = await this.gateway.json<{ status?: string }>("POST", `${path}/start`, body, ownerHeaders, true, cancel);
            this.unknownStart = reply.status !== "starting";
            if (current()) operation.set_label(this.unknownStart ? "Шлюз не подтвердил запуск. Проверьте состояние."
              : "Шлюз принял запуск. Готовность появится в состоянии модели.");
          } catch (error) {
            this.unknownStart = !(error instanceof HttpError && error.status < 500);
            if (!current()) return;
            const problem = error instanceof HttpError ? object(error.body) : {};
            operation.set_label(error instanceof HttpError && error.status === 412 && problem.error === "runtime_missing"
              ? ["На шлюзе отсутствует рантайм.", problem.hint].filter(Boolean).join("\n")
              : this.unknownStart ? `Итог запуска неизвестен. ${errorText(error)}` : errorText(error));
          } finally {
            this.starting = false;
          }
        } else if (action === "install") {
          if (!await confirm(dialog, "Установить локальный рантайм?",
            "Шлюз установит llama-cpp-python в своё рабочее окружение. Это может занять время.", "Установить") || !current()) return;
          operation.set_label("Отправляю запрос установки…");
          const reply = await this.gateway.json<{ status?: string }>("POST", `${path}/install-runtime`, {}, ownerHeaders, false, cancel);
          this.installing = reply.status === "installing" || reply.status === "already_installing";
          if (current()) operation.set_label(this.installing ? "Установка принята. Итог появится в состоянии рантайма."
            : "Шлюз не подтвердил установку. Проверьте состояние.");
        } else if (action === "stop") {
          if (!await confirm(dialog, "Остановить локальный рантайм?",
            "Шлюз остановит модель или прервёт текущую установку рантайма.", "Остановить") || !current()) return;
          const reply = await this.gateway.json<{ status?: string }>("POST", `${path}/stop`, {}, ownerHeaders, false, cancel);
          if (reply.status === "stopped") this.installing = false;
          if (current()) operation.set_label(reply.status === "stopped" ? "Шлюз принял остановку." : "Остановка не подтверждена.");
        } else {
          operation.set_label("Шлюз проверяет чат и вызов инструментов…");
          const result = await this.gateway.json<{ success: boolean; chat_ok: boolean; tool_call_ok: boolean; details?: unknown; tokens_per_sec?: number }>(
            "POST", `${path}/test`, {}, ownerHeaders, true, cancel);
          if (current()) operation.set_label([result.success ? "Проверка прошла" : "Проверка не прошла",
            `Чат · ${result.chat_ok ? "да" : "нет"}`, `Вызов инструментов · ${result.tool_call_ok ? "да" : "нет"}`,
            typeof result.tokens_per_sec === "number" ? `${result.tokens_per_sec.toFixed(1)} токенов/с` : "",
            typeof result.details === "string" ? result.details : result.details ? JSON.stringify(result.details) : "",
          ].filter(Boolean).join("\n"));
        }
      } catch (error) {
        if (current()) operation.set_label(errorText(error));
      } finally {
        if (current()) await refresh(true);
        this.action = undefined;
        if (current()) sync();
      }
    };
    const start = button("Запустить модель", () => void perform("start"));
    const stop = button("Остановить…", () => void perform("stop"));
    const test = button("Проверить модель", () => void perform("test"));
    const install = button("Установить рантайм…", () => void perform("install"));
    const apply = button("Применить к настройкам", () => {
      try {
        const patch: SettingsDocument = {};
        const values = formBody(false);
        for (const key of Object.keys(inputs) as Input[]) {
          if (setup && key === "port") continue;
          const [setting, , fallback] = inputs[key];
          if (String(values[key]) !== String(settings[setting] ?? fallback)) patch[setting] = values[key];
        }
        for (const [key, item] of switches) if (item.get_active() !== flag(settings[key])) patch[key] = item.get_active();
        stage(patch);
        dialog.close();
      } catch (error) { operation.set_label(errorText(error)); }
    });
    for (const widget of [start, stop, test, install, button("Перечитать состояние", () => void refresh())]) flow.append(widget);
    for (const widget of [status, progress, runtimeLog, flow, operation, form, apply]) content.append(widget);
    dialog.connect("closed", () => {
      this.dialog = undefined;
      cancel.cancel();
      if (this.poll) GLib.Source.remove(this.poll);
      this.poll = 0;
    });
    this.present(dialog);
    sync();
    this.poll = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
      void refresh();
      return GLib.SOURCE_CONTINUE;
    });
    void refresh();
  }
}
