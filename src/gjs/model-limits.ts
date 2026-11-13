import { Adw, Gio, GLib, Gtk, Pango } from "./gi.js";
import { type Gateway, HttpError, query } from "./gateway.js";
import type { Present } from "./mcp-server.js";
import { type SettingsDocument, object, ownerHeaders } from "./settings-write.js";
import { button, clear, column, errorText, label, row, sheet } from "./ui.js";

export interface ModelLimitSelection {
  role: string;
  model: string;
  local: boolean;
  account: string;
  window: number;
}

interface Route {
  provider: string;
  model: string;
  base_url?: string;
  options?: SettingsDocument | null;
  headers?: SettingsDocument | null;
  route_fp?: string;
  use_local?: boolean;
}

interface Preview {
  route: Route;
  response_limit: { route_fp: string; max_output_tokens?: number; source?: string; status?: string; observed_at?: string; stale?: boolean };
  window_route: Route;
  window_ack: boolean;
  window: {
    tokens?: number | null; kind?: string; usable?: number | null; reserve?: number; source?: string; observed_at?: string;
    contradiction?: { tokens?: number; kind?: string; source?: string; observed_at?: string } | null;
    retired_ack?: { window_tokens?: number; ts?: string } | null;
    text?: string;
  };
}

type Limit = "max_output_tokens" | "window_tokens";

const sources: Record<string, string> = {
  user_setting: "Настройка роли", owner_ack: "Подтверждение владельца",
  provider_metadata: "Метаданные сервера", local_health: "Локальный сервер",
};
const tokens = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
  ? value.toLocaleString("ru") : undefined;

const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const optionalStrings = (value: Record<string, any>, keys: string[]) => keys.every(key => !Object.hasOwn(value, key) || typeof value[key] === "string");
const optionalCounts = (value: Record<string, any>, keys: string[], nullable = false) => keys.every(key =>
  !Object.hasOwn(value, key) || nullable && value[key] === null || tokens(value[key]) !== undefined);
function validRoute(value: unknown, model: string, window: boolean): boolean {
  return record(value) && typeof value.provider === "string" && Boolean(value.provider.trim()) && value.model === model
    && optionalStrings(value, ["base_url", "route_fp"])
    && (!window || typeof value.route_fp === "string" && Boolean(value.route_fp.trim()))
    && (!Object.hasOwn(value, "use_local") || typeof value.use_local === "boolean")
    && ["options", "headers"].every(key => value[key] == null || record(value[key]));
}
function validPreview(value: unknown, model: string): value is Preview {
  if (!record(value) || !validRoute(value.route, model, false) || !validRoute(value.window_route, model, true)
    || !record(value.response_limit) || !record(value.window) || typeof value.window_ack !== "boolean") return false;
  const response = value.response_limit, window = value.window;
  return typeof response.route_fp === "string" && Boolean(response.route_fp.trim())
    && optionalStrings(response, ["status", "source", "observed_at"])
    && optionalCounts(response, ["max_output_tokens"])
    && (!Object.hasOwn(response, "stale") || typeof response.stale === "boolean")
    && optionalStrings(window, ["kind", "source", "observed_at", "text"])
    && optionalCounts(window, ["tokens", "usable"], true) && optionalCounts(window, ["reserve"])
    && (window.contradiction == null || record(window.contradiction)
      && optionalStrings(window.contradiction, ["kind", "source", "observed_at"]) && optionalCounts(window.contradiction, ["tokens"]))
    && (window.retired_ack == null || record(window.retired_ack)
      && optionalStrings(window.retired_ack, ["ts"]) && optionalCounts(window.retired_ack, ["window_tokens"]));
}

function fact(target: any, title: string, ...parts: (string | undefined)[]): void {
  const values = parts.filter(Boolean);
  if (!values.length) return;
  const field = label([title, ...values].join(" · "));
  field.set_wrap_mode(Pango.WrapMode.WORD_CHAR);field.set_max_width_chars(64);
  field.set_selectable(true);
  target.append(field);
}

function serverName(endpoint?: string): string | undefined {
  if (!endpoint) return undefined;
  try {
    const uri = GLib.Uri.parse(endpoint, GLib.UriFlags.NONE);
    const port = uri.get_port();
    return [uri.get_host(), port > 0 ? String(port) : ""].filter(Boolean).join(":");
  } catch { return undefined; }
}

function identity(preview: Preview, limit: Limit): { route: Route; fingerprint: string } {
  return limit === "max_output_tokens"
    ? { route: preview.route, fingerprint: preview.response_limit.route_fp }
    : { route: preview.window_route, fingerprint: preview.window_route.route_fp ?? "" };
}

function accountBound(route: Route, requested: string): boolean {
  if (route.provider !== "claudexor") return true;
  const { source_id, credential_profile_id, account_fingerprint } = object(route.options);
  return [source_id, credential_profile_id, account_fingerprint].every((value) => typeof value === "string" && value.length > 0)
    && (!requested || requested === credential_profile_id);
}

function render(target: any, preview: Preview): void {
  clear(target);
  const { route, response_limit: response, window } = preview;
  const { source_id, credential_profile_id, account_fingerprint } = object(route.options);
  fact(target, "Маршрут шлюза", route.provider, route.model, serverName(route.base_url));
  fact(target, "Аккаунт", typeof source_id === "string" ? source_id : undefined,
    typeof credential_profile_id === "string" ? credential_profile_id : undefined);
  const windowAccount = object(preview.window_route.options);
  fact(target, "Маршрут окна контекста", preview.window_route.provider, preview.window_route.model, serverName(preview.window_route.base_url));
  fact(target, "Аккаунт окна контекста", typeof windowAccount.source_id === "string" ? windowAccount.source_id : undefined,
    typeof windowAccount.credential_profile_id === "string" ? windowAccount.credential_profile_id : undefined);
  fact(target, "Максимум ответа", response.max_output_tokens ? tokens(response.max_output_tokens) : "Неизвестен",
    sources[response.source ?? ""] ?? response.source, response.observed_at, response.stale ? "данные устарели" : undefined);
  if (route.provider === "claudexor") target.append(label("Максимум используется для планирования. Размер ответа определяет движок аккаунта.", "dim-label"));
  fact(target, "Окно контекста", tokens(window.tokens) ?? "Неизвестно", window.kind,
    sources[window.source ?? ""] ?? window.source, window.observed_at);
  fact(target, "Доступно для входа", tokens(window.usable));
  fact(target, "Резерв для ответа", tokens(window.reserve));
  if (window.contradiction) fact(target, "Расхождение", tokens(window.contradiction.tokens), window.contradiction.kind,
    sources[window.contradiction.source ?? ""] ?? window.contradiction.source, window.contradiction.observed_at);
  if (window.retired_ack) fact(target, "Прежнее подтверждение не используется", tokens(window.retired_ack.window_tokens), window.retired_ack.ts);
  const details = column(4);
  fact(details, "Отпечаток максимума ответа", response.route_fp);
  fact(details, "Отпечаток окна контекста", preview.window_route.route_fp);
  fact(details, "Отпечаток аккаунта максимума ответа", typeof account_fingerprint === "string" ? account_fingerprint : undefined);
  fact(details, "Отпечаток аккаунта окна контекста", typeof windowAccount.account_fingerprint === "string" ? windowAccount.account_fingerprint : undefined);
  fact(details, "Сводка шлюза", window.text);
  target.append(new Gtk.Expander({ label: "Сведения о проверке", child: details }));
}

export class ModelLimits {
  constructor(private readonly gateway: Gateway, private readonly present: Present) {}

  show(parent: any, title: string, selection: ModelLimitSelection): void {
    const content = column();
    const dialog = sheet(`Лимиты маршрута · ${title}`, content);
    const data = column(4);
    const status = label("", "dim-label");
    const inputs = column();
    const response = new Gtk.Entry({ placeholder_text: "Токенов ответа", input_purpose: Gtk.InputPurpose.DIGITS, hexpand: true });
    const context = new Gtk.Entry({ placeholder_text: "Токенов контекста", input_purpose: Gtk.InputPurpose.DIGITS, hexpand: true });
    const note = new Gtk.TextView({ wrap_mode: Gtk.WrapMode.WORD_CHAR });
    note.set_name("model-window-note");
    const cancel = new Gio.Cancellable();
    let open = true;
    let busy = false;
    let preview: Preview | undefined;
    let displayed: Preview | undefined;
    const parentSignal = parent instanceof Adw.Dialog ? parent.connect("closed", () => dialog.force_close()) : 0;
    dialog.connect("closed", () => {
      if (!open) return;
      open = false;
      cancel.cancel();
      if (parentSignal) parent.disconnect(parentSignal);
    });
    const read = async () => {
      const data = await this.gateway.json<unknown>("GET", "/api/settings" + query({ response_limit_preview: 1, ...selection }),
        undefined, undefined, false, cancel);
      if (!validPreview(data, selection.model)) {
        throw new Error("Шлюз не подтвердил оба маршрута для выбранной модели.");
      }
      return data;
    };
    const sync = () => {
      refresh.set_sensitive(!busy);
      inputs.set_sensitive(!busy && Boolean(preview));
      if (!preview) return;
      const responseBound = accountBound(preview.route, selection.account);
      const contextBound = accountBound(preview.window_route, selection.account);
      responseApply.set_sensitive(responseBound);
      contextApply.set_sensitive(contextBound);
      responseClear.set_visible(preview.response_limit.source === "owner_ack");
      responseClear.set_sensitive(responseBound);
      contextClear.set_visible(preview.window_ack);
    };
    const show = (next: Preview) => {
      if (displayed && displayed.response_limit.route_fp !== next.response_limit.route_fp) response.set_text("");
      if (displayed && displayed.window_route.route_fp !== next.window_route.route_fp) {
        context.set_text("");
        note.get_buffer().set_text("", -1);
      }
      displayed = preview = next;
      render(data, next);
      if (!accountBound(next.route, selection.account) || !accountBound(next.window_route, selection.account)) {
        data.append(label("Шлюз пока не подтвердил точный аккаунт подписки. Перечитайте маршрут после подключения аккаунта.", "dim-label"));
      }
    };
    const refreshPreview = async () => {
      if (busy || !open) return;
      busy = true;
      preview = undefined;
      sync();
      status.set_label("Читаю сведения о маршруте…");
      try {
        const next = await read();
        if (!open) return;
        show(next);
        status.set_label("");
      } catch (error) {
        if (open) status.set_label((displayed ? "Сведения о маршруте недоступны. Показаны прежние данные, запись отключена. "
          : "Сведения о маршруте недоступны. ") + errorText(error));
      } finally {
        busy = false;
        if (open) sync();
      }
    };
    const apply = async (limit: Limit, input: any, remove = false) => {
      if (busy || !open || !preview) return;
      const raw = input.get_text().trim();
      const value = remove ? 0 : Number(raw);
      if (!remove && (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0)) {
        status.set_label("Введите положительное целое число токенов.");
        return;
      }
      const shown = identity(preview, limit);
      busy = true;
      sync();
      status.set_label("Проверяю отпечаток маршрута…");
      let writing = false;
      let confirmed = false;
      try {
        const current = await read();
        if (!open) return;
        const { route, fingerprint } = identity(current, limit);
        if (fingerprint !== shown.fingerprint) {
          show(current);
          status.set_label("Маршрут изменился. Проверьте его и введите значение заново.");
          return;
        }
        if ((limit === "max_output_tokens" || !remove) && !accountBound(route, selection.account)) {
          show(current);
          status.set_label("Шлюз не подтвердил аккаунт этого маршрута.");
          return;
        }
        writing = true;
        status.set_label("Записываю подтверждение маршрута…");
        const { provider, model, base_url, options, headers } = route;
        const buffer = note.get_buffer();
        const annotation = buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false);
        const result = await this.gateway.json<{ ok?: boolean; ack?: SettingsDocument }>("POST", "/api/owner/capability-ack", {
          provider, model, base_url, options, ...(limit === "window_tokens" && headers ? { headers } : {}),
          ...(limit === "window_tokens" && !remove ? { note: annotation } : {}),
          route_fp: fingerprint, [limit]: value,
        }, ownerHeaders, false, cancel);
        if (!open) return;
        if (result?.ok !== true || result.ack?.route_fp !== fingerprint || result.ack[limit] !== value
          || (limit === "window_tokens" && !remove && result.ack.note !== annotation)) {
          throw new Error("Шлюз не вернул квитанцию для этого отпечатка и значения.");
        }
        confirmed = true;
        input.set_text("");
        if (limit === "window_tokens") note.get_buffer().set_text("", -1);
        const next = await read();
        if (!open) return;
        show(next);
        const message = remove ? "Подтверждение удалено." : "Подтверждение сохранено.";
        status.set_label(message + (identity(next, limit).fingerprint === fingerprint ? "" : " Шлюз уже показывает другой маршрут."));
      } catch (error) {
        if (!open) return;
        preview = undefined;
        const prefix = confirmed ? "Запись подтверждена. Обновить сведения не удалось. "
          : writing && !(error instanceof HttpError && error.status === 400) ? "Результат записи неизвестен. Перечитайте маршрут. " : "";
        status.set_label(prefix + errorText(error));
      } finally {
        busy = false;
        if (open) sync();
      }
    };
    const refresh = button("Перечитать маршрут", () => void refreshPreview());
    const responseApply = button("Подтвердить максимум", () => void apply("max_output_tokens", response));
    const responseClear = button("Отозвать максимум", () => void apply("max_output_tokens", response, true));
    const contextApply = button("Подтвердить окно", () => void apply("window_tokens", context));
    const contextClear = button("Отозвать окно", () => void apply("window_tokens", context, true));
    responseClear.set_visible(false);
    contextClear.set_visible(false);
    const responseRow = row();
    const contextRow = row();
    for (const widget of [response, responseApply]) responseRow.append(widget);
    for (const widget of [context, contextApply]) contextRow.append(widget);
    for (const widget of [label("Максимум ответа", "heading"), responseRow, responseClear,
      label("Окно контекста", "heading"), contextRow, contextClear,
      label("Примечание к подтверждению окна (необязательно)", "dim-label"),
      new Gtk.ScrolledWindow({ child: note, min_content_height: 80 })]) inputs.append(widget);
    for (const widget of [label(selection.model, "heading"),
      label("Шлюз разрешает маршрут по сохранённым подключениям. Подтверждения действуют сразу и хранятся отдельно от настроек ролей.", "dim-label"),
      refresh, status, data, inputs]) content.append(widget);
    this.present(dialog, parent);
    void refreshPreview();
  }
}
