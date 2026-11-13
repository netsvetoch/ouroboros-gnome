import { Gio, Gtk } from "./gi.js";
import { type Gateway } from "./gateway.js";
import { editMcpServer, flag, headerMask, identity, importMetadata, type McpServer, mcpToolMetadata, mcpTransport, type Present, redactMcp, textArea } from "./mcp-server.js";
import { mcpSignIn } from "./mcp-sign-in.js";
import { type SettingsDocument, object, ownerHeaders } from "./settings-write.js";
import { button, clear, column, confirm, errorText, label, row, sheet } from "./ui.js";

export const mcpKeys = new Set(["MCP_ENABLED", "MCP_SERVERS", "MCP_TOOL_TIMEOUT_SEC"]);

interface Tool {
  name: string;
  prefixed_name?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

interface StatusServer {
  id: string;
  name?: string;
  enabled: boolean;
  transport?: string;
  url?: string;
  auth_header?: string;
  auth_configured?: boolean;
  cwd?: string;
  env_from_settings?: Record<string, string>;
  header_names?: string[];
  allowed_tools?: string[];
  schemas_at_start?: boolean;
  task_session?: boolean;
  browser_policy?: boolean;
  configuration_warnings?: string[];
  instructions?: string;
  map_tokens?: number;
  schema_tokens?: number;
  tool_count: number;
  tools?: Tool[];
  tool_name_collisions?: Record<string, unknown>[];
  last_error: string | null;
  last_refreshed?: string;
  last_attempted?: string;
  listed_at?: string | null;
  latest_attempt?: { at: string; ok: boolean; error: string; partial: boolean } | null;
  complete?: boolean;
  publication_error?: string;
  code?: string;
  sign_in?: { state: string; reason?: string; issuer?: string; pending?: boolean; required_scope?: string };
}

interface McpStatus {
  enabled: boolean;
  sdk_available: boolean;
  sdk_error?: string;
  tool_timeout_sec?: number;
  servers: StatusServer[];
  weights?: { tools?: number; map_tokens?: number; schema_tokens_from_task_start?: number };
}

interface RefreshOutcome {
  ok?: boolean;
  tool_count?: number;
  error?: string;
  code?: string;
  not_started?: boolean;
  published?: boolean;
  publication_error?: string;
}

interface DraftRow {
  server: McpServer;
  saved?: McpServer;
}

interface ImportEntry {
  source_name: string;
  server_id: string;
  action: "" | "add" | "update";
  transport: string;
  arg_count: number;
  header_names: string[];
  env_names: string[];
  unsupported_keys: string[];
  problems: string[];
  warnings: string[];
  patch: McpServer;
  index?: number;
  header_changes?: { added: string[]; replaced: string[]; removed: string[] };
  kept_header_names?: string[];
  unreadable_headers?: boolean;
}

interface ImportReply {
  ok: boolean;
  entries: ImportEntry[];
  wrapper?: string;
  ignored_keys?: string[];
  error?: string;
}

const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
function importReply(value: unknown, rows: DraftRow[]): ImportReply {
  const fail = () => { throw new Error("Шлюз вернул неполный или противоречивый предпросмотр импорта. Черновик не изменён."); };
  if (!record(value) || typeof value.ok !== "boolean" || !Array.isArray(value.entries)
    || (value.error !== undefined && typeof value.error !== "string")
    || (value.wrapper !== undefined && typeof value.wrapper !== "string")
    || (value.ignored_keys !== undefined && !stringList(value.ignored_keys))) return fail();
  const ids = new Set<string>();
  for (const entry of value.entries) {
    if (!record(entry) || ["source_name", "server_id", "transport"].some(key => typeof entry[key] !== "string")
      || !["", "add", "update"].includes(entry.action) || !Number.isSafeInteger(entry.arg_count) || entry.arg_count < 0
      || ["header_names", "env_names", "unsupported_keys", "problems", "warnings"].some(key => !stringList(entry[key]))
      || (entry.kept_header_names !== undefined && !stringList(entry.kept_header_names))
      || (entry.unreadable_headers !== undefined && typeof entry.unreadable_headers !== "boolean")
      || (entry.header_changes !== undefined && (!record(entry.header_changes)
        || ["added", "replaced", "removed"].some(key => !stringList(entry.header_changes[key]))))
      || !record(entry.patch)) return fail();
    if (!entry.action) continue;
    const patch = entry.patch;
    if (!value.ok || entry.problems.length || !entry.server_id || ids.has(entry.server_id)
      || !["streamable_http", "sse", "stdio"].includes(entry.transport) || patch.transport !== entry.transport
      || ["url", "command", "cwd", "auth_header", "auth_token", "id", "name"].some(key => patch[key] !== undefined && typeof patch[key] !== "string")
      || ["enabled", "task_session", "browser_policy"].some(key => patch[key] !== undefined && typeof patch[key] !== "boolean")
      || (patch.args !== undefined && !stringList(patch.args))
      || ["env", "headers"].some(key => patch[key] !== undefined && (!record(patch[key]) || Object.values(patch[key]).some(value => typeof value !== "string")))
      || (entry.transport === "stdio" ? typeof patch.command !== "string" : typeof patch.url !== "string")) return fail();
    const allowed = new Set(["transport", "task_session", "browser_policy",
      ...(entry.transport === "stdio" ? ["command", "args", "env", "cwd"] : ["url", "headers", "auth_header", "auth_token"]),
      ...(entry.action === "add" ? ["id", "name", "enabled"] : [])]);
    if (Object.keys(patch).some(key => !allowed.has(key)) || entry.arg_count !== (patch.args?.length ?? 0)
      || JSON.stringify(entry.header_names) !== JSON.stringify(Object.keys(patch.headers ?? {}))
      || JSON.stringify(entry.env_names) !== JSON.stringify(Object.keys(patch.env ?? {}))
      || ((patch.auth_header !== undefined || patch.auth_token !== undefined) &&
        (entry.action !== "update" || patch.headers === undefined || patch.auth_header !== "Authorization" || patch.auth_token !== ""))) return fail();
    if (entry.action === "update" && entry.transport !== "stdio") {
      if (patch.headers !== undefined ? patch.auth_header !== "Authorization" || patch.auth_token !== ""
        || entry.header_changes === undefined || entry.kept_header_names !== undefined
        : entry.header_changes !== undefined || !stringList(entry.kept_header_names)) return fail();
    }
    ids.add(entry.server_id);
    const candidates = rows.map(({ server }, index) => ({ server, index })).filter(({ server }) => identity(server) === entry.server_id);
    if (entry.action === "add") {
      if (candidates.length || patch.enabled !== false || patch.id !== entry.server_id || patch.name !== entry.source_name || identity(patch) !== entry.server_id || entry.index !== undefined) return fail();
    } else if (!Number.isSafeInteger(entry.index) || entry.index < 0 || candidates.length !== 1
      || candidates[0].index !== entry.index || mcpTransport(candidates[0].server) !== entry.transport
      || (patch.id !== undefined && identity(patch) !== entry.server_id) || patch.enabled !== undefined) return fail();
  }
  return value as ImportReply;
}

function list(value: unknown): McpServer[] {
  return Array.isArray(value) ? value.filter((entry) => entry && entry === object(entry)) : [];
}

function field(target: any, values: unknown[], style?: string): void {
  const text = values.filter((value) => value != null && value !== "" && value !== false).join(" · ");
  if (!text) return;
  const control = label(text, style);
  control.set_selectable(true);
  target.append(control);
}

function refreshText(result: RefreshOutcome): string {
  const message = result.ok === true ? `Получен список · инструментов ${result.tool_count ?? 0}`
    : result.not_started ? "Обновление не начато" : "Обновление отклонено";
  return [message, result.code, result.error,
    result.published === false && "Публикация списка не подтверждена", result.publication_error].filter(Boolean).join(" · ");
}

function hasCredential(server: McpServer): boolean {
  return Boolean(server.auth_token || server.headers === headerMask || Object.values(object(server.headers)).some(Boolean));
}

export class McpSettings {
  private dialog?: any;
  private importDialog?: any;
  private cancel?: any;
  private statusCancel?: any;
  private rows: DraftRow[] = [];
  private readonly draft = column(8);
  private readonly status = column(8);
  private readonly feedback = label("", "dim-label");
  private readonly observation = label("", "dim-label");
  private readonly statusError = label("", "error");
  private read = 0;
  private refreshing = false;
  private snapshot?: McpStatus;
  private version = 0;
  private saved: McpServer[] = [];

  constructor(private readonly gateway: Gateway, private readonly present: Present) {}

  show(effective: SettingsDocument, saved: SettingsDocument, stage: (patch: SettingsDocument) => void): void {
    if (this.dialog) return;
    const content = column(12);
    const dialog = sheet("Серверы MCP", content);
    dialog.set_content_width(720);
    dialog.set_content_height(660);
    this.dialog = dialog;
    const cancel = new Gio.Cancellable();
    this.cancel = cancel;
    const current = () => this.dialog === dialog;
    let staged = false;
    this.snapshot = undefined;
    this.feedback.set_label("");
    this.observation.set_label("");
    this.statusError.set_label("");
    const savedRows = list(saved.MCP_SERVERS);
    this.saved = savedRows;
    const baseline = list(effective.MCP_SERVERS);
    this.rows = baseline.map((server) => {
      const id = identity(server);
      const matching = savedRows.filter((original) => id && identity(original) === id);
      return { server, saved: matching.length === 1 ? matching[0] : undefined };
    });
    const enabled = new Gtk.CheckButton({ label: "Включить MCP на шлюзе", active: flag(effective.MCP_ENABLED) });
    const initialTimeout = Number(effective.MCP_TOOL_TIMEOUT_SEC) > 0 ? Number(effective.MCP_TOOL_TIMEOUT_SEC) : 60;
    const timeout = new Gtk.Entry({ text: String(initialTimeout), input_purpose: Gtk.InputPurpose.DIGITS });
    const tools = new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.NONE, column_spacing: 6, row_spacing: 6 });
    tools.append(button("Добавить сервер…", () => { if (current()) this.edit(); }));
    tools.append(button("Импортировать JSON…", () => { if (current()) this.import(); }));
    const apply = button("Применить к настройкам…", () => {
      if (!current() || staged) return;
      const seconds = Number(timeout.get_text().trim());
      if (!Number.isSafeInteger(seconds) || seconds <= 0) {
        this.feedback.set_label("Введите целое положительное число секунд.");
        return;
      }
      const servers = this.rows.map((row) => row.server);
      const rowsChanged = JSON.stringify(servers) !== JSON.stringify(baseline);
      if (rowsChanged) {
        const ids = servers.map(identity).filter(Boolean);
        if (new Set(ids).size !== ids.length) {
          this.feedback.set_label("В черновике есть серверы с одинаковыми идентификаторами.");
          return;
        }
      }
      staged = true;
      stage({
        ...(rowsChanged ? { MCP_SERVERS: servers } : {}),
        ...(seconds !== initialTimeout ? { MCP_TOOL_TIMEOUT_SEC: seconds } : {}),
        ...(enabled.get_active() !== flag(effective.MCP_ENABLED) ? { MCP_ENABLED: enabled.get_active() } : {}),
      });
      dialog.close();
    });
    const refresh = row();
    refresh.append(button("Перечитать состояние", () => { if (current()) void this.readStatus(); }));
    refresh.append(button("Обновить инструменты всех серверов", () => { if (current()) void this.refresh(); }));
    for (const item of [
      label("Черновик настроек", "title-3"), enabled, label("Время ожидания инструмента, секунды"), timeout, tools,
      this.draft, this.feedback, apply, label("Сохранённое состояние", "title-3"), refresh, this.observation, this.statusError, this.status,
    ]) content.append(item);
    dialog.connect("closed", () => {
      cancel.cancel();
      if (!current()) return;
      this.statusCancel?.cancel();
      this.refreshing = false;
      apply.set_sensitive(false);
      this.dialog = undefined;
      this.read++;
      this.rows = [];
      this.saved = [];
      for (const widget of [this.draft, this.feedback, this.status, this.observation, this.statusError]) content.remove(widget);
      clear(this.draft);
      clear(this.status);
    });
    this.present(dialog);
    this.renderDraft();
    void this.readStatus();
  }

  private renderDraft(): void {
    const parent = this.dialog;
    const cancel = this.cancel;
    clear(this.draft);
    if (!this.rows.length) field(this.draft, ["В черновике нет серверов."], "dim-label");
    for (const entry of this.rows) {
      const { server, saved } = entry;
      const name = String(server.name || server.label || identity(server) || "Сервер без идентификатора");
      const item = column(4);
      field(item, [name], "heading");
      field(item, [identity(server), mcpTransport(server), flag(server.enabled) ? "включён" : "выключен",
        !saved && "новый", saved && JSON.stringify(saved) !== JSON.stringify(server) && "изменён в черновике"], "dim-label");
      const actions = row();
      actions.append(button("Изменить сервер…", () => { if (this.dialog === parent && this.rows.includes(entry)) this.edit(entry); }));
      actions.append(button("Убрать из черновика…", () => {
        const dialog = parent;
        if (!dialog || this.dialog !== dialog || !this.rows.includes(entry)) return;
        void confirm(dialog, `Убрать ${name}?`, "Сервер будет убран из сохранённой конфигурации после общего сохранения настроек.", "Убрать", cancel)
          .then((allowed) => {
            if (!allowed || this.dialog !== dialog || !this.rows.includes(entry)) return;
            this.rows = this.rows.filter((item) => item !== entry);
            this.version++;
            this.renderDraft();
          });
      }));
      item.append(actions);
      this.draft.append(item);
    }
  }

  private edit(entry?: DraftRow): void {
    const dialog = this.dialog;
    if (!dialog || entry && !this.rows.includes(entry)) return;
    editMcpServer(dialog, this.gateway, this.present, entry?.server ?? { transport: "streamable_http", enabled: false }, entry?.saved,
      (server) => {
        if (this.dialog !== dialog) return;
        if (entry && this.rows.includes(entry)) entry.server = server;
        else if (!entry) this.rows.push({ server });
        this.version++;
        this.renderDraft();
      }, () => void this.readStatus());
  }

  private async readStatus(): Promise<void> {
    if (!this.dialog) return;
    const token = ++this.read;
    this.statusCancel?.cancel();
    const cancel = new Gio.Cancellable();
    this.statusCancel = cancel;
    try {
      const result = await this.gateway.json<McpStatus>("GET", "/api/mcp/status", undefined, undefined, false, cancel);
      if (!this.dialog || token !== this.read) return;
      if (!result || typeof result.enabled !== "boolean" || typeof result.sdk_available !== "boolean"
        || !Array.isArray(result.servers) || result.servers.some(server => !server || typeof server.id !== "string"
          || (server.tools !== undefined && !Array.isArray(server.tools)))) {
        throw new Error("Шлюз не вернул пригодное состояние MCP.");
      }
      this.statusError.set_label("");
      if (JSON.stringify(result) === JSON.stringify(this.snapshot)) return;
      this.snapshot = result;
      this.renderStatus(result);
    } catch (error) {
      if (this.dialog && token === this.read) this.statusError.set_label(errorText(error));
    } finally { if (this.statusCancel === cancel) this.statusCancel = undefined; }
  }

  private renderStatus(result: McpStatus): void {
    const dialog = this.dialog;
    const current = () => this.dialog === dialog && this.snapshot === result;
    clear(this.status);
    field(this.status, [result.enabled ? "MCP включён" : "MCP выключен",
      result.sdk_available ? "SDK доступен" : "SDK недоступен", result.sdk_error,
      result.tool_timeout_sec == null ? "" : `ожидание ${result.tool_timeout_sec} с`], "dim-label");
    if (result.weights) field(this.status, [`Инструментов ${result.weights.tools ?? 0}`, `токенов карты ${result.weights.map_tokens ?? 0}`,
      `токенов схем с начала задачи ${result.weights.schema_tokens_from_task_start ?? 0}`], "dim-label");
    for (const server of result.servers) {
      const child = column();
      const title = [server.name ?? server.id, server.transport, `инструментов ${server.tool_count}`,
        server.enabled ? "включён" : "выключен", server.code].filter(Boolean).join(" · ");
      const panel = new Gtk.Expander({ label: title, child });
      this.status.append(panel);
      field(child, [server.url && `Адрес сервера · ${server.url}`]);
      field(child, [server.auth_configured && server.auth_header && `Заголовок токена · ${server.auth_header}`]);
      field(child, [server.id, server.schemas_at_start && "схемы с начала задачи", server.task_session && "процесс на цикл задачи",
        server.browser_policy && "действуют правила браузера", server.complete === false && "список неполный"]);
      field(child, [server.listed_at && `Успешный список · ${server.listed_at}`, !server.listed_at && server.last_refreshed]);
      if (server.last_attempted && server.last_attempted !== server.latest_attempt?.at) {
        field(child, [`Последнее обращение · ${server.last_attempted}`]);
      }
      if (server.latest_attempt) field(child, [`Последняя попытка · ${server.latest_attempt.at}`,
        server.latest_attempt.ok ? "успешно" : "ошибка", server.latest_attempt.partial && "частично", server.latest_attempt.error]);
      field(child, [server.last_error, server.publication_error]);
      field(child, [server.map_tokens == null ? "" : `токенов карты ${server.map_tokens}`,
        server.schema_tokens == null ? "" : `токенов схем ${server.schema_tokens}`]);
      if (server.header_names?.length) field(child, [`HTTP-заголовки · ${server.header_names.join(", ")}`]);
      if (server.allowed_tools?.length) field(child, [`Разрешённые инструменты · ${server.allowed_tools.join(", ")}`]);
      if (server.cwd) field(child, [`Рабочая папка · ${server.cwd}`]);
      for (const [variable, key] of Object.entries(server.env_from_settings ?? {})) field(child, [variable, key]);
      if (server.sign_in) field(child, [server.sign_in.state, server.sign_in.reason, server.sign_in.issuer,
        server.sign_in.pending && "ожидается возврат из браузера", server.sign_in.required_scope]);
      for (const warning of server.configuration_warnings ?? []) field(child, [warning]);
      const actions = row();
      if (server.id) actions.append(button("Обновить инструменты", () => { if (current()) void this.refresh(server.id); }));
      const saved = this.saved.find((row) => identity(row) === server.id);
      const hasCredentials = server.auth_configured || (saved && (hasCredential(saved) || String(saved.url ?? "").includes("://***@")));
      if (server.id && ["streamable_http", "sse"].includes(server.transport ?? "") && (server.sign_in || !hasCredentials)) {
        actions.append(button("Вход и выход…", () => { if (current()) mcpSignIn(dialog, this.gateway, this.present, server.id, () => { if (this.dialog === dialog) void this.readStatus(); }); }));
      }
      child.append(actions);
      field(child, [server.instructions]);
      for (const item of server.tools ?? []) {
        field(child, [item.name, item.prefixed_name, item.description]);
        const metadata = mcpToolMetadata(item.name, item.metadata);
        if (metadata) child.append(metadata);
      }
      for (const collision of server.tool_name_collisions ?? []) field(child, [Object.entries(collision).map(([key, value]) => `${key} · ${String(value)}`).join(" · ")]);
    }
  }

  private async refresh(serverId?: string): Promise<void> {
    const dialog = this.dialog;
    if (!dialog || this.refreshing) return;
    this.refreshing = true;
    this.observation.set_label("Шлюз обновляет список инструментов…");
    try {
      const response = await this.gateway.json<RefreshOutcome & { refreshed?: Record<string, RefreshOutcome> }>(
        "POST", "/api/mcp/refresh", serverId ? { server_id: serverId } : {}, ownerHeaders, true, this.cancel);
      if (this.dialog !== dialog) return;
      const text = response.refreshed
        ? Object.entries(response.refreshed).map(([id, result]) => `${id} · ${refreshText(result)}`).join("\n")
        : serverId ? refreshText(response) : "";
      this.observation.set_label(text || response.error || "Шлюз не сообщил об обновлённых серверах.");
    } catch (error) {
      if (this.dialog === dialog) this.observation.set_label(errorText(error));
    } finally {
      if (this.dialog === dialog) { this.refreshing = false; void this.readStatus(); }
    }
  }

  private import(): void {
    const parent = this.dialog;
    if (!parent) return;
    if (this.importDialog) { this.importDialog.present(parent); return; }
    const content = column();
    const dialog = sheet("Импорт серверов MCP", content);
    this.importDialog = dialog;
    const pasted = textArea();
    pasted.widget.get_child().set_name("mcp-import-text");
    const status = label("", "dim-label");
    const preview = column();
    preview.set_name("mcp-import-preview");
    const cancel = new Gio.Cancellable();
    let open = true;
    let inspecting = false;
    let previewed = false;
    const stale = "Текст импорта или черновик изменился. Повторите предпросмотр.";
    const parentSignal = parent.connect("closed", () => dialog.force_close());
    dialog.connect("closed", () => {
      if (!open) return;
      open = false;
      if (this.importDialog === dialog) this.importDialog = undefined;
      cancel.cancel();
      pasted.clear();
      clear(preview);
      parent.disconnect(parentSignal);
    });
    pasted.widget.get_child().get_buffer().connect("changed", () => {
      if (!open || (!inspecting && !previewed)) return;
      previewed = false;
      clear(preview);
      status.set_label(stale);
    });
    const inspect = button("Проверить импорт", () => {
      void (async () => {
        if (!open || inspecting) return;
        const raw = pasted.read();
        if (!raw.trim()) {
          status.set_label("Вставьте JSON с полем mcpServers или servers.");
          return;
        }
        const version = this.version;
        const current = () => open && this.dialog === parent && this.version === version && raw === pasted.read();
        inspecting = true;
        previewed = false;
        inspect.set_sensitive(false);
        clear(preview);
        status.set_label("Шлюз проверяет конфигурацию…");
        try {
          const value = await this.gateway.json<unknown>("POST", "/api/mcp/import/preview", {
            text: raw, servers: this.rows.map(({ server }) => importMetadata(server)),
          }, ownerHeaders, false, cancel);
          if (!open || this.dialog !== parent) return;
          if (!current()) {
            status.set_label(stale);
            return;
          }
          const reply = importReply(value, this.rows);
          if (!reply.ok) {
            status.set_label(reply.error || "Шлюз отклонил импорт.");
            return;
          }
          status.set_label([reply.wrapper, reply.ignored_keys?.length && `Пропущены поля · ${reply.ignored_keys.join(", ")}`].filter(Boolean).join(" · "));
          previewed = true;
          this.importPreview(dialog, preview, status, reply.entries, current, cancel);
        } catch (error) {
          if (open) status.set_label(errorText(error));
        } finally {
          inspecting = false;
          if (open) inspect.set_sensitive(true);
        }
      })();
    });
    for (const widget of [label("Вставьте JSON конфигурации MCP. Предпросмотр показывает имена полей и изменения черновика.", "dim-label"),
      pasted.widget, inspect, status, preview]) content.append(widget);
    this.present(dialog, parent);
  }

  private importPreview(dialog: any, target: any, status: any, entries: ImportEntry[], current: () => boolean, cancel: any): void {
    const choices: { entry: ImportEntry; widget: any }[] = [];
    for (const entry of entries) {
      const heading = [entry.source_name, entry.server_id, entry.transport,
        entry.action === "add" ? "добавление" : entry.action === "update" ? "обновление" : "пропущено"].filter(Boolean).join(" · ");
      if (entry.action && !entry.problems.length) {
        const widget = new Gtk.CheckButton({ label: heading });
        choices.push({ entry, widget });
        target.append(widget);
      } else field(target, [heading], "heading");
      if (entry.header_changes) {
        for (const [name, values] of [["Добавит", entry.header_changes.added], ["Заменит", entry.header_changes.replaced], ["Удалит", entry.header_changes.removed]] as const) {
          if (values.length) field(target, [`${name} заголовки · ${values.join(", ")}`]);
        }
      } else if (entry.header_names.length) field(target, [`Заголовки · ${entry.header_names.join(", ")}`]);
      if (entry.unreadable_headers) field(target, ["Заменит нечитаемый список заголовков."]);
      if (entry.kept_header_names?.length) field(target, [`Сохранит заголовки · ${entry.kept_header_names.join(", ")}`]);
      if (entry.env_names.length) field(target, [`Переменные окружения · ${entry.env_names.join(", ")}`]);
      if (entry.arg_count) field(target, [`Аргументов процесса · ${entry.arg_count}`]);
      if (entry.unsupported_keys.length) field(target, [`Пропущены поля · ${entry.unsupported_keys.join(", ")}`]);
      for (const line of [...entry.problems, ...entry.warnings]) field(target, [line]);
    }
    if (!choices.length) return;
    let applying = false;
    const apply = button("Перенести выбранное в черновик…", () => {
      void (async () => {
        if (cancel.is_cancelled() || applying) return;
        if (!current()) {
          status.set_label("Текст импорта или черновик изменился. Повторите предпросмотр.");
          return;
        }
        const selected = choices.filter(({ widget }) => widget.get_active()).map(({ entry }) => entry);
        if (!selected.length) return;
        applying = true;
        apply.set_sensitive(false);
        try {
          const next = this.rows.map((row) => ({ ...row }));
          let credentialsMoved = false;
          for (const { action, index, patch } of selected) {
            if (action === "add") next.push({ server: { ...patch } });
            else if (index != null && next[index]) {
              const row = next[index];
              const before = row.server;
              row.server = { ...before, ...patch };
              if (patch.url && patch.url !== before.url && hasCredential(before)
                && (!Object.hasOwn(patch, "headers") || !Object.hasOwn(patch, "auth_token"))) credentialsMoved = true;
            } else {
              status.set_label("Шлюз не указал запись для обновления. Повторите предпросмотр.");
              apply.set_sensitive(true);
              return;
            }
          }
          if (credentialsMoved && !await confirm(dialog, "Использовать сохранённые данные с новым адресом?",
            "После сохранения настройки могут отправить прежние заголовки или токен на новый адрес.", "Перенести в черновик", cancel)) {
            return;
          }
          if (!current()) return;
          this.rows = next;
          this.version++;
          this.feedback.set_label(`Перенесено в черновик · ${selected.length}`);
          this.renderDraft();
          dialog.close();
        } finally {
          applying = false;
          if (!cancel.is_cancelled() && current()) apply.set_sensitive(choices.some(({ widget }) => widget.get_active()));
        }
      })();
    });
    apply.set_sensitive(false);
    for (const { widget } of choices) widget.connect("toggled", () => { if (current() && !applying) apply.set_sensitive(choices.some(({ widget }) => widget.get_active())); });
    target.append(apply);
  }
}
