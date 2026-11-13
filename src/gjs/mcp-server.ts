import { showSavedSecret } from "./saved-secret.js";
import { Adw, Gio, GLib, Gtk } from "./gi.js";
import { type Gateway } from "./gateway.js";
import { type SettingsDocument, object, ownerHeaders } from "./settings-write.js";
import { button, clear, column, confirm, errorText, label, row, sheet } from "./ui.js";

export type McpServer = SettingsDocument;
export type Present = (dialog: any, parent?: any) => void;

export const headerMask = "***set***";
const transports = ["streamable_http", "sse", "stdio"];
const headerPattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export function flag(value: unknown): boolean {
  return value === true || ["true", "1", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

export function identity(server: McpServer | undefined): string {
  const source = String(server?.id || server?.slug || server?.name || "").trim();
  const stem = source.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").toLowerCase();
  if (stem.length <= 24) return stem;
  const digest = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, source, -1).slice(0, 12);
  return `${stem.slice(0, 11)}_${digest}`.replace(/_+/g, "_");
}

export function mcpTransport(server: McpServer): string {
  return String(server.transport || transports[0]).trim().toLowerCase();
}

function tokenMask(value: unknown): boolean {
  const token = String(value ?? "").trim();
  return token === "***" || token.endsWith("...");
}

function maskedUrl(value: unknown): boolean {
  return value === headerMask || String(value ?? "").includes("://***@");
}

function headerNames(server: McpServer): string[] {
  return Object.keys(object(server.headers));
}

export function importMetadata(server: McpServer): object {
  const names = headerNames(server);
  const legacy = server.auth_token ? String(server.auth_header || "Authorization") : undefined;
  const { id, slug, name } = server;
  return {
    ...(typeof id === "string" && id ? { id } : {}),
    ...(typeof slug === "string" && slug ? { slug } : {}),
    ...(typeof name === "string" && name ? { name } : {}),
    transport: mcpTransport(server),
    header_names: [...names, ...(legacy ? [legacy] : [])],
    ...(legacy ? { legacy_header: legacy } : {}),
    unreadable_headers: server.headers != null && server.headers !== "" && server.headers !== object(server.headers),
  };
}

function holdsMasks(server: McpServer): boolean {
  return tokenMask(server.auth_token) || maskedUrl(server.url) || server.headers === headerMask
    || Object.values(object(server.headers)).includes(headerMask);
}

export function redactMcp(text: string, servers: unknown): string {
  if (!Array.isArray(servers)) return text;
  const secrets = new Set<string>();
  for (const entry of servers) {
    const server = object(entry);
    // Literal HTTP header values follow the gateway's forwarding policy. Short
    // values such as "en" must not rewrite unrelated tool descriptions/metadata.
    for (const value of [server.auth_token, ...Object.values(object(server.env))]) {
      if (typeof value === "string" && value && !tokenMask(value) && value !== headerMask) secrets.add(value);
    }
    if (typeof server.url === "string" && !maskedUrl(server.url)) {
      try {
        const uri = GLib.Uri.parse(server.url, GLib.UriFlags.HAS_PASSWORD);
        for (const value of [uri.get_user(), uri.get_password(), uri.get_query()]) if (value) secrets.add(value);
      } catch { /* the server still reports invalid addresses */ }
    }
  }
  for (const value of [...secrets].sort((a, b) => b.length - a.length)) text = text.replaceAll(value, "•••");
  return text;
}

export function mcpToolMetadata(name: string, metadata: unknown, redact: (text: string) => string = text => text): any | undefined {
  if (!metadata || typeof metadata !== "object" || !Object.keys(metadata).length) return undefined;
  const view = new Gtk.TextView({ editable: false, monospace: true, wrap_mode: Gtk.WrapMode.WORD_CHAR });
  view.set_name("mcp-tool-metadata");
  view.get_buffer().set_text(redact(JSON.stringify(metadata, null, 2)), -1);
  return new Gtk.Expander({ label: `Метаданные · ${name}`,
    child: new Gtk.ScrolledWindow({ child: view, min_content_height: 100, max_content_height: 240, propagate_natural_height: true }) });
}

function environment(text: string): Record<string, unknown> {
  const message = "Переменные окружения должны быть объектом JSON с именами и строковыми значениями.";
  let value: unknown;
  try { value = JSON.parse(text.trim() || "{}"); } catch { throw new Error(message); }
  const parsed = object(value);
  if (value !== parsed || Object.entries(parsed).some(([key, val]) => !key || /[=\0]/.test(key) || typeof val !== "string" || val.includes("\0"))) {
    throw new Error(message);
  }
  return parsed;
}


export function textArea(value = ""): { widget: any; read: () => string; clear: () => void } {
  const input = new Gtk.TextView({ wrap_mode: Gtk.WrapMode.WORD_CHAR, monospace: true, top_margin: 6, left_margin: 6 });
  const buffer = input.get_buffer();
  buffer.set_text(value, -1);
  return {
    widget: new Gtk.ScrolledWindow({ child: input, min_content_height: 78, max_content_height: 180, propagate_natural_height: true }),
    read: () => buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false),
    clear: () => buffer.set_text("", -1),
  };
}

interface TestReply {
  ok: boolean;
  tool_count: number;
  tools?: { name: string; description?: string; metadata?: Record<string, unknown> }[];
  instructions?: string;
  schema_omissions?: string[];
  configuration_warnings?: string[];
  pagination_truncated?: boolean;
  code?: string;
  error?: string;
}

function readTestReply(value: unknown): TestReply {
  const record = (item: unknown): item is Record<string, any> => item !== null && typeof item === "object" && !Array.isArray(item);
  const strings = (item: unknown) => Array.isArray(item) && item.every(value => typeof value === "string");
  if (!record(value) || typeof value.ok !== "boolean"
    || ["instructions", "code", "error"].some(key => value[key] != null && typeof value[key] !== "string")
    || ["schema_omissions", "configuration_warnings"].some(key => value[key] != null && !strings(value[key]))
    || (value.pagination_truncated != null && typeof value.pagination_truncated !== "boolean")
    || (value.ok && (!Number.isSafeInteger(value.tool_count) || value.tool_count < 0 || !Array.isArray(value.tools) || value.tools.length !== value.tool_count))
    || (value.tools != null && (!Array.isArray(value.tools) || value.tools.some(item => !record(item) || typeof item.name !== "string"
      || (item.description != null && typeof item.description !== "string") || (item.metadata != null && !record(item.metadata)))))) {
    throw new Error("Шлюз не подтвердил результат проверки MCP. Список инструментов не применён.");
  }
  return value as TestReply;
}

interface HeaderField {
  name: any;
  value: any;
  kept?: { name: string; value: string };
  keep: any;
}

export function editMcpServer(parent: any, gateway: Gateway, present: Present, draft: McpServer, saved: McpServer | undefined,
  apply: (candidate: McpServer) => void, onTest: () => void): void {
  const content = column();
  const dialog = sheet("Сервер MCP", content);
  dialog.set_content_width(680);
  let open = true;
  let busy = false;
  const cancel = new Gio.Cancellable();
  const parentSignal = parent?.connect(parent instanceof Adw.Dialog ? "closed" : "close-request", () => { if (open) dialog.force_close(); return false; });
  const form = column();
  const entry = (target: any, title: string, value: unknown) => {
    const widget = new Gtk.Entry({ text: String(value ?? ""), placeholder_text: title });
    target.append(label(title));
    target.append(widget);
    return widget;
  };
  const check = (target: any, title: string, value: unknown) => {
    const widget = new Gtk.CheckButton({ label: title, active: flag(value) });
    target.append(widget);
    return widget;
  };
  const area = (target: any, title: string, value: string) => {
    const widget = textArea(value);
    target.append(label(title));
    target.append(widget.widget);
    return widget;
  };
  const id = entry(form, "Идентификатор сервера", draft.id ?? draft.slug);
  const name = entry(form, "Отображаемое имя", draft.name ?? draft.label);
  const initialTransport = mcpTransport(draft);
  const modes = transports.includes(initialTransport) ? transports : [...transports, initialTransport];
  const transport = Gtk.DropDown.new_from_strings([...["Streamable HTTP", "SSE", "Локальный процесс (stdio)"],
    ...(modes.length > transports.length ? [initialTransport] : [])]);
  transport.set_selected(modes.indexOf(initialTransport));
  form.append(transport);
  const enabled = check(form, "Включить сервер", draft.enabled);
  const allowedValues = Array.isArray(draft.allowed_tools) ? draft.allowed_tools
    : typeof draft.allowed_tools === "string" ? draft.allowed_tools.split(",").map(value => value.trim()).filter(Boolean) : [];
  const allowed = area(form, "Разрешённые инструменты · массив строк JSON", JSON.stringify(allowedValues, null, 2));
  allowed.widget.get_child().set_name("mcp-server-allowed-tools");
  form.append(label("Укажите исходные имена инструментов сервера. Пустой список [] не ограничивает инструменты этим полем.", "dim-label"));
  const pin = check(form, "Загружать схемы инструментов с начала задачи", draft.schemas_at_start);
  const remote = column();
  remote.append(label("URL сервера"));
  const url = new Gtk.PasswordEntry({ text: String(draft.url ?? ""), placeholder_text: "https://…/mcp", show_peek_icon: true });
  remote.append(url);
  const legacy = column();
  const legacyHeader = entry(legacy, "Имя заголовка", draft.auth_header || "Authorization");
  const token = new Gtk.PasswordEntry({
    text: tokenMask(draft.auth_token) ? "" : String(draft.auth_token ?? ""), placeholder_text: "Новый токен", show_peek_icon: true,
  });
  legacy.append(token);
  const keepToken = check(legacy, "Сохранить прежний токен", tokenMask(draft.auth_token));
  keepToken.set_visible(tokenMask(draft.auth_token));
  const sid = identity(saved);
  const reveal = (target: any, header?: string) => {
    if (!sid) return;
    target.append(button(header ? `Показать сохранённый ${header}…` : "Показать сохранённый токен…", () =>
      { if (open) showSecret(dialog, gateway, present, sid, header); }));
  };
  if (saved?.auth_token) reveal(legacy);
  remote.append(new Gtk.Expander({ label: "Одиночный токен (старый формат)", child: legacy }));

  const headers = column();
  const headerRows: HeaderField[] = [];
  const badHeaders = draft.headers === headerMask;
  const keepUnreadable = check(headers, "Сохранить нечитаемый список заголовков", badHeaders);
  keepUnreadable.set_visible(badHeaders);
  const appendHeader = (initialName = "", initialValue = "") => {
    const controls = column();
    const header = entry(controls, "Имя HTTP-заголовка", initialName);
    const kept = initialValue === headerMask ? { name: initialName, value: initialValue } : undefined;
    const value = new Gtk.PasswordEntry({ text: kept ? "" : initialValue, placeholder_text: "Значение заголовка", show_peek_icon: true });
    controls.append(value);
    const keep = check(controls, "Сохранить прежнее значение", Boolean(kept));
    keep.set_visible(Boolean(kept));
    if (kept && headerNames(saved ?? {}).some((key) => key.toLowerCase() === initialName.toLowerCase())) reveal(controls, initialName);
    const field = { name: header, value, keep, kept };
    headerRows.push(field);
    controls.append(button("Убрать заголовок", () => {
      if (!open || !headerRows.includes(field)) return;
      headerRows.splice(headerRows.indexOf(field), 1);
      headers.remove(controls);
    }));
    headers.append(controls);
  };
  for (const [name, value] of Object.entries(object(draft.headers))) appendHeader(name, String(value ?? ""));
  headers.append(button("Добавить заголовок", () => {
    if (!open) return;
    keepUnreadable.set_active(false);
    appendHeader();
  }));
  remote.append(new Gtk.Expander({ label: "HTTP-заголовки", child: headers, expanded: headerRows.length > 0 || badHeaders }));
  form.append(remote);

  const process = column();
  const command = entry(process, "Команда на шлюзе", draft.command);
  const args = area(process, "Аргументы · массив строк JSON", draft.args == null ? "[]" : JSON.stringify(draft.args, null, 2));
  args.widget.get_child().set_name("mcp-server-args");
  process.append(label("Например, [\"--mode\", \"value\", \"\"]. Пустые аргументы, пробелы и переносы внутри строк сохраняются.", "dim-label"));
  const cwd = entry(process, "Рабочая папка на шлюзе", draft.cwd);
  const env = area(process, "Переменные окружения (JSON)", draft.env == null ? "" : JSON.stringify(draft.env, null, 2));
  const refs = area(process, "Ссылки на ключи настроек (JSON)", draft.env_from_settings == null ? "" : JSON.stringify(draft.env_from_settings, null, 2));
  const taskSession = check(process, "Один процесс на цикл инструментов задачи", draft.task_session);
  const browserPolicy = check(process, "Применять правила браузера шлюза к запросам процесса", draft.browser_policy);
  form.append(process);
  const note = label("", "dim-label");
  form.append(note);
  const showTransport = () => {
    const kind = modes[transport.get_selected()];
    remote.set_visible(kind !== "stdio");
    process.set_visible(kind === "stdio");
    note.set_label(kind !== initialTransport ? "При смене транспорта параметры прежнего транспорта будут удалены из этой записи." : "");
  };
  transport.connect("notify::selected", showTransport);
  showTransport();
  const status = label("", "dim-label");
  const result = column();
  const actions = row();

  const collect = (): McpServer => {
    const kind = modes[transport.get_selected()];
    if (!transports.includes(kind)) throw new Error("Выберите поддерживаемый транспорт.");
    let allowedTools: unknown;
    try { allowedTools = JSON.parse(allowed.read().trim() || "[]"); } catch { throw new Error("Разрешённые инструменты должны содержать корректный массив строк JSON."); }
    if (!Array.isArray(allowedTools) || allowedTools.some(value => typeof value !== "string")) {
      throw new Error("Разрешённые инструменты должны содержать массив строк JSON.");
    }
    const candidate = { ...draft, id: id.get_text().trim(), name: name.get_text().trim(), transport: kind,
      enabled: enabled.get_active(), allowed_tools: allowedTools,
      schemas_at_start: pin.get_active() } as McpServer;
    delete candidate.auth_configured;
    if (!identity(candidate)) throw new Error("Идентификатор или имя должны содержать латинскую букву или цифру.");
    if (kind === "stdio") {
      for (const key of ["url", "headers", "auth_token", "auth_header"]) delete candidate[key];
      const executable = command.get_text().trim();
      if (!executable || executable.includes("\0")) throw new Error("Укажите команду локального процесса.");
      const working = cwd.get_text().trim();
      let argv: unknown;
      try { argv = JSON.parse(args.read().trim() || "[]"); } catch { throw new Error("Аргументы должны содержать корректный массив строк JSON."); }
      if (!Array.isArray(argv) || argv.some(value => typeof value !== "string")) throw new Error("Аргументы должны содержать массив строк JSON.");
      if ([working, ...argv].some((value) => value.includes("\0"))) throw new Error("Команда, аргументы и папка не могут содержать нулевые байты.");
      if (browserPolicy.get_active() && !taskSession.get_active()) throw new Error("Для правил браузера нужен один процесс на цикл задачи.");
      Object.assign(candidate, { command: executable, args: argv, cwd: working, env: environment(env.read()), env_from_settings: environment(refs.read()),
        task_session: taskSession.get_active(), browser_policy: browserPolicy.get_active() });
    } else {
      for (const key of ["command", "args", "cwd", "env", "env_from_settings", "task_session", "browser_policy"]) delete candidate[key];
      const endpoint = url.get_text().trim();
      if (endpoint !== headerMask) {
        let parsed;
        try { parsed = GLib.Uri.parse(endpoint, GLib.UriFlags.NONE); } catch { throw new Error("Укажите корректный URL HTTP или HTTPS."); }
        if (!["http", "https"].includes(parsed.get_scheme()) || !parsed.get_host() || parsed.get_fragment()) {
          throw new Error("Укажите URL HTTP или HTTPS без фрагмента.");
        }
      }
      const authHeader = legacyHeader.get_text().trim() || "Authorization";
      const authToken = token.get_text() || (keepToken.get_active() ? String(draft.auth_token) : "");
      if (!headerPattern.test(authHeader)) throw new Error("Укажите допустимое имя заголовка одиночного токена.");
      if (token.get_text() && tokenMask(token.get_text())) throw new Error("Введите полное значение токена.");
      if (/[^\x20-\x7e]/.test(authToken)) throw new Error("Токен содержит недопустимый символ.");
      if (keepToken.get_active() && !token.get_text() && authHeader.toLowerCase() !== String(saved?.auth_header || "Authorization").toLowerCase()) {
        throw new Error("Для нового имени заголовка введите значение токена заново.");
      }
      const values = new Map<string, string>();
      const folded = new Set<string>();
      for (const field of headerRows) {
        const name = field.name.get_text().trim();
        const entered = field.value.get_text();
        if (!headerPattern.test(name)) throw new Error("Укажите допустимое имя каждого HTTP-заголовка.");
        const key = name.toLowerCase();
        if (folded.has(key)) throw new Error(`HTTP-заголовок «${name}» указан несколько раз.`);
        folded.add(key);
        const keep = Boolean(field.kept && field.keep.get_active() && !entered);
        if (keep && key !== field.kept?.name.toLowerCase()) throw new Error(`Введите значение для переименованного заголовка «${name}» заново.`);
        if (entered === headerMask || /[^\x20-\x7e]/.test(entered) || entered !== entered.trim()) throw new Error(`Недопустимое значение заголовка «${name}».`);
        const value = keep ? headerMask : entered;
        if (value && authToken && key === authHeader.toLowerCase()) throw new Error(`Заголовок «${name}» уже задаётся одиночным токеном.`);
        values.set(name, value);
      }
      Object.assign(candidate, { url: endpoint, auth_header: authHeader, auth_token: authToken,
        headers: keepUnreadable.get_active() ? headerMask : Object.fromEntries(values) });
    }
    if (holdsMasks(candidate) && (!sid || identity(candidate) !== sid)) {
      throw new Error("Для другого идентификатора введите замаскированные значения заново.");
    }
    if (maskedUrl(candidate.url) && candidate.url !== saved?.url) throw new Error("Для нового URL введите адрес целиком.");
    return candidate;
  };

  const run = async (test: boolean) => {
    if (busy || !open) return;
    busy = true;
    form.set_sensitive(false);
    actions.set_sensitive(false);
    try {
      const candidate = collect();
      if (candidate.url !== saved?.url && holdsMasks(candidate)
        && !await confirm(dialog, "Использовать сохранённые заголовки с новым адресом?",
          "После изменения URL сохранённые заголовки или токен будут отправляться на указанный адрес.", "Подтвердить", cancel)) return;
      if (!open) return;
      if (!test) {
        apply(candidate);
        dialog.close();
        return;
      }
      if (mcpTransport(candidate) === "stdio" && (!await confirm(dialog, "Запустить пробу локального процесса?",
        "Шлюз запустит указанную команду на своём хосте для чтения списка инструментов.", "Проверить", cancel) || !open)) return;
      status.set_label("Шлюз проверяет черновик…");
      let reply: TestReply;
      try {
        reply = readTestReply(await gateway.json<unknown>("POST", "/api/mcp/test", {
          server: candidate, ...(holdsMasks(candidate) && sid ? { server_id: sid } : {}),
        }, ownerHeaders, true, cancel));
      } catch (error) {
        throw new Error(redactMcp(errorText(error), [candidate]));
      }
      if (!open) return;
      if (!reply.ok) status.set_label(redactMcp(["Проверка отклонена", reply.code, reply.error].filter(Boolean).join(" · "), [candidate]));
      else {
        status.set_label(redactMcp([`Проверка черновика прошла · инструментов ${reply.tool_count}`, reply.pagination_truncated && "список неполный",
          ...(reply.configuration_warnings ?? [])].filter(Boolean).join(" · "), [candidate]));
        if (reply.instructions) {
          result.append(label("Инструкции сервера MCP", "heading"));
          const instructions = label(redactMcp(reply.instructions, [candidate]));
          instructions.set_selectable(true);
          result.append(instructions);
        }
        for (const omission of reply.schema_omissions ?? []) result.append(label(redactMcp(omission, [candidate]), "dim-label"));
        for (const tool of reply.tools ?? []) {
          result.append(label(redactMcp([tool.name, tool.description].filter(Boolean).join(" · "), [candidate])));
          const metadata = mcpToolMetadata(tool.name, tool.metadata, text => redactMcp(text, [candidate]));
          if (metadata) result.append(metadata);
        }
      }
    } catch (error) {
      if (open) status.set_label(errorText(error));
    } finally {
      busy = false;
      if (open) {
        actions.set_sensitive(true);
        form.set_sensitive(true);
        if (test) onTest();
      }
    }
  };
  actions.append(button("Проверить черновик…", () => {
    if (!open || busy) return;
    clear(result);
    void run(true);
  }));
  actions.append(button("Применить к черновику", () => void run(false)));
  dialog.connect("closed", () => {
    if (!open) return;
    open = false;
    cancel.cancel();
    token.set_text(""); url.set_text(""); env.clear(); refs.clear(); args.clear(); allowed.clear();
    for (const field of headerRows) field.value.set_text("");
    clear(result);
    form.set_sensitive(false); actions.set_sensitive(false);
    if (parentSignal) parent.disconnect(parentSignal);
  });
  for (const widget of [form, actions, status, result]) content.append(widget);
  present(dialog, parent);
}

function showSecret(parent: any, gateway: Gateway, present: Present, sid: string, header?: string): void {
  showSavedSecret(parent, gateway, present, { mcp_server_id: sid, ...(header ? { header_name: header } : {}) }, "Сохранённый секрет MCP");
}
