import { Adw, Gio, GLib, Gtk } from "./gi.js";
import { type Gateway, HttpError } from "./gateway.js";
import type { Present } from "./mcp-server.js";
import { object, ownerHeaders } from "./settings-write.js";
import { safeLink } from "./skill-catalog.js";
import { button, clear, column, confirm, errorText, label, row, sheet } from "./ui.js";

interface Job {
  id?: string;
  state: string;
  phase?: string;
  message?: string;
  profileId?: string;
  outcome?: { reason?: string };
  terminationReconciliation?: { status?: string };
}

interface Envelope {
  job: Job;
  job_id?: string;
  sequence?: number;
  deviceCode?: { flow?: string; verificationUrl?: string; userCode?: string };
  attach_command?: string;
  attach_shell?: string;
}

interface Attempt {
  id: string;
  creationUnconfirmed?: boolean;
  result?: Envelope;
  attach?: string;
  absent?: boolean;
  inputUnavailable?: boolean;
  sequence?: number;
}

const path = "/api/claudexor/login";
const terminal = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted_unknown", "not_supported"]);
const states: Record<string, string> = {
  queued: "В очереди", running: "Выполняется", waiting_for_input: "Ждёт входа пользователя",
  succeeded: "Задание входа завершилось успешно", failed: "Задание входа завершилось ошибкой",
  cancelled: "Отмена зарегистрирована", timed_out: "Истекло время ожидания",
  interrupted_unknown: "Задание прервалось с неизвестным итогом", not_supported: "Вход этим способом недоступен",
};
const reconciliation = (job?: Job) => job?.outcome?.reason === "termination_unconfirmed" && job.terminationReconciliation?.status !== "empty";

function problem(error: unknown, sensitive = false): string {
  const body = error instanceof HttpError ? object(error.body) : {};
  const actions = Array.isArray(body.required_actions)
    ? body.required_actions.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join(", ") : "";
  const inputProblems: Record<string, string> = {
    input_not_supported: "Для этого задания передача кода недоступна. Отмените вход и выберите ручное подключение перед новой попыткой.",
    setup_input_not_applicable: "Для этого задания код больше не требуется. Перечитайте состояние.",
    setup_input_already_submitted: "Код уже передан. Перечитайте состояние задания.",
  };
  return [sensitive ? error instanceof HttpError ? `HTTP ${error.status} · ${inputProblems[error.reason ?? ""] ?? "Ответ на ввод не подтверждён."}` : "Ответ на ввод не подтверждён."
    : errorText(error), sensitive ? "" : actions].filter(Boolean).join(" · ");
}

export class AccountLogin {
  private dialog?: any;
  private attempt?: Attempt;
  private busy = false;
  private reading = false;
  private poll = 0;
  private epoch = 0;
  private paint?: () => void;
  private status?: any;
  private readCancel?: any;
  private pendingRead?: any;
  private readProblem?: string;

  constructor(private readonly gateway: Gateway, private readonly present: Present, private readonly changed: () => void) {}

  show(parent: any, initialHarness = "", initialProfile = ""): void {
    if (this.dialog) return;
    if (this.attempt && !this.active() && (initialHarness || initialProfile)) this.attempt = undefined;
    const content = column();
    const dialog = sheet("Вход в аккаунт Claudexor", content);
    this.dialog = dialog;
    const readCancel = new Gio.Cancellable();
    this.readCancel = readCancel;
    this.readProblem = undefined;
    const parentSignal = parent instanceof Adw.Dialog ? parent.connect("closed", () => dialog.force_close()) : 0;
    const harness = new Gtk.Entry({ text: initialHarness, placeholder_text: "Идентификатор инструмента, например codex" });
    const profile = new Gtk.Entry({ text: initialProfile, placeholder_text: "Имя профиля (если требуется)" });
    const transport = new Gtk.CheckButton({ label: "Запросить подключение к терминалу вручную" });
    const flow = new Gtk.Entry({ text: "device_auth", placeholder_text: "Пусто — выбор сервиса" });
    flow.set_name("account-login-flow");
    const advanced = column();
    advanced.append(label("Способ входа Codex"));
    advanced.append(flow);
    advanced.append(label("Например, device_auth или browser_redirect. Для ручного подключения способ выбирает сервис.", "dim-label"));
    const advancedPanel = new Gtk.Expander({ label: "Дополнительные параметры входа", child: advanced });
    const syncFlow = () => {
      advancedPanel.set_visible(harness.get_text().trim() === "codex");
      flow.set_sensitive(!transport.get_active());
    };
    harness.connect("changed", syncFlow);
    transport.connect("toggled", syncFlow);
    syncFlow();
    const status = label("", "dim-label");
    this.status = status;
    const current = () => this.dialog === dialog;
    const form = column();
    const details = column();
    const controls = row();
    const existing = new Gtk.Entry({ placeholder_text: "Идентификатор ранее начатого задания" });
    const start = button("Начать вход", () => {
      if (!current()) return;
      const name = harness.get_text().trim();
      const named = profile.get_text().trim();
      const loginFlow = flow.get_text().trim();
      if (!name) { status.set_label("Укажите идентификатор инструмента."); return; }
      void this.perform(async () => {
        const result = await this.gateway.json<Envelope>("POST", path,
          { harness: name, ...(name === "codex" && loginFlow ? { login_flow: loginFlow } : {}), ...(named ? { profile_id: named } : {}),
            ...(transport.get_active() ? { transport: "client_pty" } : {}) }, ownerHeaders, true, readCancel);
        if (!current()) return;
        const id = result?.job_id || result?.job?.id;
        if (typeof id !== "string" || !id.trim()) throw new Error("Шлюз не вернул идентификатор задания.");
        // A malformed snapshot cannot undo an accepted create. Retain its
        // canonical handle before validation so read/cancel remain possible.
        const attempt: Attempt = { id, creationUnconfirmed: true };
        this.attempt = attempt;
        this.accept(attempt, result);
        attempt.creationUnconfirmed = false;
        attempt.attach = result.attach_command;
      }, "Шлюз готовит задание входа…", false, true);
    });
    const attach = button("Открыть задание", () => {
      if (!current()) return;
      const id = existing.get_text().trim();
      if (!id || this.active() || this.busy || this.reading) return;
      this.attempt = { id };
      this.paint?.();
      void this.read();
    });
    const update = button("Перечитать", () => { if (current()) void this.read(); });
    const cancel = button("Отменить вход…", () => {
      if (!current()) return;
      void this.perform(async () => {
        const attempt = this.attempt;
        if (!attempt || !await confirm(dialog, "Отменить задание входа?", "Шлюз запросит остановку процесса входа.", "Отменить вход", readCancel) || !current()) return;
        const result = await this.gateway.json<Envelope>("DELETE", `${path}/${encodeURIComponent(attempt.id)}`, undefined, ownerHeaders, false, readCancel);
        if (!current()) return;
        this.accept(attempt, result);
      }, "Запрашиваю отмену…");
    });
    const reconcile = button("Проверить завершение процесса", () => {
      if (!current()) return;
      const attempt = this.attempt;
      if (!attempt) return;
      void this.perform(async () => {
        const result = await this.gateway.json<Envelope>("POST", `${path}/${encodeURIComponent(attempt.id)}/reconcile`, {}, ownerHeaders, false, readCancel);
        if (!current()) return;
        this.accept(attempt, result);
        if (result.job.terminationReconciliation?.status !== "empty") this.status?.set_label("Освобождение процесса пока не подтверждено.");
      }, "Шлюз проверяет состояние процесса…");
    });
    const code = new Gtk.PasswordEntry({ placeholder_text: "Код из браузера", show_peek_icon: true });
    code.set_name("account-login-code");
    const answer = row();
    code.set_hexpand(true);
    answer.append(code);
    answer.append(button("Передать код", () => {
      if (!current()) return;
      const value = code.get_text();
      const attempt = this.attempt;
      if (!attempt || !value || [...value].length > 1024) {
        status.set_label("Введите код длиной от 1 до 1024 символов.");
        return;
      }
      if (!this.active() || attempt.inputUnavailable || attempt.result?.deviceCode?.flow !== "oauth_url_input") return;
      void this.perform(async () => {
        try {
          const result = await this.gateway.json<Envelope>("POST", `${path}/${encodeURIComponent(attempt.id)}/input`, { value }, ownerHeaders, false, readCancel);
          if (!current()) return;
          this.accept(attempt, result);
          if (current()) code.set_text("");
        } catch (error) {
          if (current() && this.attempt === attempt && error instanceof HttpError && error.reason === "input_not_supported") {
            attempt.inputUnavailable = true;
            this.paint?.();
          }
          throw error;
        }
      }, "Передаю код шлюзу…", true);
    }));
    let paintKey = "";
    this.paint = () => {
      if (!current()) return;
      const attempt = this.attempt;
      const job = attempt?.result?.job;
      const disclosure = attempt?.result?.deviceCode;
      const active = this.active();
      form.set_sensitive(!this.busy && !active);
      controls.set_sensitive(!this.busy);
      cancel.set_visible(Boolean(attempt && !attempt.absent && (!job || !terminal.has(job.state))));
      reconcile.set_visible(Boolean(attempt && !attempt.absent && reconciliation(job)));
      update.set_visible(Boolean(attempt && !attempt.absent));
      answer.set_visible(Boolean(active && !attempt?.inputUnavailable && !reconciliation(job) && disclosure?.flow === "oauth_url_input"));
      answer.set_sensitive(!this.busy);
      if (!answer.get_visible()) code.set_text("");
      const key = JSON.stringify([attempt?.id, attempt?.absent, attempt?.inputUnavailable, attempt?.creationUnconfirmed, job, disclosure, attempt?.attach]);
      if (key === paintKey) return;
      paintKey = key;
      clear(details);
      if (!attempt) return;
      const facts = label([attempt.id, job?.profileId, job && (states[job.state] ?? job.state), job?.phase,
        attempt.creationUnconfirmed && (job ? "Исходный ответ создания не подтверждён. Текущее состояние получено отдельным чтением."
          : "Исходный ответ создания не подтверждён. Идентификатор сохранён; состояние задания ещё не проверено."),
        job?.message, job?.outcome?.reason, reconciliation(job) && "Остановка процесса не подтверждена",
        job?.terminationReconciliation?.status === "empty" && "Процесс завершён",
        attempt.absent && "Шлюз больше не возвращает это задание. Итог неизвестен."].filter(Boolean).join("\n"));
      facts.set_selectable(true);
      details.append(facts);
      if (active && attempt.inputUnavailable) details.append(label("Для этого задания передача кода недоступна. Отмените вход и выберите ручное подключение перед новой попыткой."));
      if (active && disclosure?.verificationUrl) {
        safeLink(details, "Открыть страницу провайдера", disclosure.verificationUrl);
        if (disclosure.userCode) {
          const device = label(`Код устройства · ${disclosure.userCode}`);
          device.set_selectable(true);
          details.append(device);
        }
      }
      if (active && attempt.attach && !disclosure) {
        const command = label(attempt.attach);
        command.set_selectable(true);
        details.append(new Gtk.Expander({ label: "Ручное подключение на хосте шлюза", child: command }));
      }
    };
    for (const item of [harness, profile, transport, advancedPanel, start, existing, attach]) form.append(item);
    for (const item of [update, cancel, reconcile]) controls.append(item);
    for (const item of [form, details, answer, controls, status]) content.append(item);
    let open = true;
    dialog.connect("closed", () => {
      if (!open) return;
      open = false;
      readCancel.cancel();
      this.pendingRead?.cancel();
      code.set_text("");
      clear(details);
      if (parentSignal) parent.disconnect(parentSignal);
      if (!current()) return;
      this.epoch++;
      this.reading = false;
      this.busy = false;
      this.dialog = undefined;
      this.paint = undefined;
      this.status = undefined;
      if (this.attempt?.result) this.attempt.result = { ...this.attempt.result, deviceCode: undefined };
      if (this.poll) GLib.Source.remove(this.poll);
      this.poll = 0;
    });
    this.present(dialog, parent);
    this.paint();
    this.poll = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
      if (this.active() && !reconciliation(this.attempt?.result?.job)) void this.read();
      return GLib.SOURCE_CONTINUE;
    });
    if (this.active()) void this.read();
  }

  private active(): boolean {
    return Boolean(this.attempt && !this.attempt.absent && (!this.attempt.result?.job || !terminal.has(this.attempt.result.job.state)
      || reconciliation(this.attempt.result.job)));
  }

  private accept(attempt: Attempt, result: Envelope): void {
    if (this.attempt !== attempt) return;
    const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
    const strings = (value: unknown, keys: string[]) => value == null || record(value) && keys.every(key => value[key] == null || typeof value[key] === "string");
    if (!record(result) || !record(result.job) || typeof result.job.state !== "string" || !Object.hasOwn(states, result.job.state)
      || (result.job.id !== undefined && result.job.id !== attempt.id)
      || (result.job_id !== undefined && result.job_id !== attempt.id)
      || !strings(result.job, ["phase", "message", "profileId"])
      || !strings(result.job.outcome, ["reason"]) || !strings(result.job.terminationReconciliation, ["status"])
      || !strings(result.deviceCode, ["flow", "verificationUrl", "userCode"])
      || !strings(result, ["attach_command", "attach_shell"])
      || (result.sequence != null && (!Number.isSafeInteger(result.sequence) || result.sequence < 0))) {
      throw new Error("Шлюз не подтвердил состояние выбранного задания входа.");
    }
    if (terminal.has(attempt.result?.job.state ?? "") && !terminal.has(result.job.state)) return;
    if (typeof result.sequence === "number" && typeof attempt.sequence === "number" && result.sequence < attempt.sequence) return;
    const was = attempt.result?.job.state;
    attempt.result = result;
    if (typeof result.sequence === "number") attempt.sequence = result.sequence;
    attempt.absent = false;
    this.paint?.();
    if ((was !== result.job.state && terminal.has(result.job.state)) || result.job.terminationReconciliation?.status === "empty") this.changed();
  }

  private async read(): Promise<void> {
    const attempt = this.attempt;
    if (!this.dialog || !attempt || attempt.absent || this.reading || this.busy) return;
    const epoch = this.epoch;
    this.reading = true;
    const cancel = new Gio.Cancellable();
    this.pendingRead = cancel;
    try {
      const result = await this.gateway.json<Envelope>("GET", `${path}/${encodeURIComponent(attempt.id)}`, undefined, {}, false, cancel);
      if (epoch === this.epoch) {
        this.accept(attempt, result);
        if (this.readProblem && this.status?.get_label() === this.readProblem) this.status.set_label("");
        this.readProblem = undefined;
      }
    } catch (error) {
      if (this.attempt !== attempt || epoch !== this.epoch) return;
      if (error instanceof HttpError && [404, 410].includes(error.status)) attempt.absent = true;
      this.readProblem = problem(error);
      this.status?.set_label(this.readProblem);
      this.paint?.();
    } finally {
      if (this.pendingRead === cancel) { this.pendingRead = undefined; this.reading = false; }
    }
  }

  private async perform(operation: () => Promise<void>, message: string, sensitive = false, creating = false): Promise<void> {
    if (!this.dialog || this.busy || (creating && this.active())) return;
    const dialog = this.dialog;
    this.busy = true;
    const epoch = ++this.epoch;
    this.pendingRead?.cancel();
    this.reading = false;
    const current = () => this.dialog === dialog && epoch === this.epoch;
    this.status?.set_label(message);
    this.paint?.();
    try {
      await operation();
      if (!current()) return;
      if (this.status?.get_label() === message) this.status.set_label("");
    } catch (error) {
      if (!current()) return;
      const uncertain = creating && (!(error instanceof HttpError) || error.status >= 500);
      const known = creating && this.attempt?.creationUnconfirmed && !this.attempt.result;
      const message = [known ? "Идентификатор задания сохранён. Новый вход недоступен до проверки или отмены этого задания."
        : uncertain ? "Шлюз не подтвердил создание задания. Проверьте состояние аккаунта перед новым входом." : "",
      problem(error, sensitive)].filter(Boolean).join("\n");
      this.status?.set_label(message);
      if (known) this.readProblem = message;
    } finally {
      if (current()) {
        this.busy = false;
        this.paint?.();
        if (this.active() && !reconciliation(this.attempt?.result?.job)) void this.read();
      }
    }
  }
}
