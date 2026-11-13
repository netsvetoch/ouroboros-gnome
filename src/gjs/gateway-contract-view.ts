import { Adw, Gio, GLib, Gtk } from "./gi.js";
import { type Gateway } from "./gateway.js";
import { readGatewayHealth } from "./connection-probe.js";
import { object } from "./settings-write.js";
import { button, chooseFile, clear, column, errorText, label, row, sheet } from "./ui.js";

interface Entry {
  title: string;
  summary: string;
  data: unknown;
  schemas: string[];
  search?: string;
}

function strings(values: unknown[]): string[] {
  return values.filter((value): value is string => typeof value === "string" && value.length > 0);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function indexContract(value: unknown) {
  const data = object(value);
  const ws = object(data.ws);
  const bodyValid = (value: unknown) => value === object(value) && (object(value).schemas === undefined
    || (Array.isArray(object(value).schemas) && (object(value).schemas as unknown[]).every(name => typeof name === "string")));
  if (typeof data.abi_version !== "string" || !data.abi_version || typeof data.runtime_version !== "string"
    || !Array.isArray(data.http) || data.schemas !== object(data.schemas)
    || Object.values(object(data.schemas)).some(schema => schema !== object(schema))
    || [data.core_paths, data.interface_paths].some(paths => !Array.isArray(paths) || paths.some(path => typeof path !== "string"))
    || data.ws !== ws || typeof ws.path !== "string" || !Array.isArray(ws.messages)
    || ws.messages.some(item => !item || typeof item !== "object" || typeof object(item).type !== "string")
    || data.http.some(item => {
      const row = object(item);
      return typeof row.method !== "string" || !row.method || typeof row.path !== "string" || !row.path
        || (row.request !== undefined && !bodyValid(row.request))
        || (row.responses !== undefined && (row.responses !== object(row.responses) || Object.values(object(row.responses)).some(value => !bodyValid(value))));
    })
    || (data.call_socket !== undefined && (data.call_socket !== object(data.call_socket)
      || typeof object(data.call_socket).path !== "string"
      || [object(data.call_socket).peer_messages, object(data.call_socket).server_messages].some(messages => messages !== object(messages)
        || Object.values(object(messages)).some(schema => typeof schema !== "string"))))) {
    throw new Error("Шлюз вернул неполный контракт API.");
  }
  const schemas = new Map<string, Entry>();
  for (const [title, definition] of Object.entries(object(data.schemas)).sort(([a], [b]) => a.localeCompare(b))) {
    const { type, description } = object(definition);
    schemas.set(title, { title, summary: strings([type, description]).join(" · "), data: definition, schemas: [] });
  }
  const http: Entry[] = [];
  for (const raw of data.http) {
    const { method, path, auth, request, responses, note } = object(raw);
    if (typeof method !== "string" || typeof path !== "string") continue;
    const payloads = [request, ...Object.values(object(responses))].map(object);
    http.push({
      title: `${method} ${path}`,
      summary: strings([auth, ...new Set(payloads.map((payload) => payload.content_type)), note]).join(" · "),
      data: raw,
      schemas: [...new Set(strings(payloads.flatMap((payload) => list(payload.schemas))))],
    });
  }
  const socket: Entry[] = typeof ws.path === "string"
    ? [{ title: ws.path, summary: "Протокол WebSocket", data: data.ws, schemas: [] }] : [];
  for (const raw of list(ws.messages)) {
    const { type, inbound, outbound } = object(raw);
    if (typeof type !== "string") continue;
    socket.push({
      title: type,
      summary: strings([inbound && "К шлюзу", outbound && "От шлюза"]).join(" · "),
      data: raw,
      schemas: strings([inbound, outbound]),
    });
  }
  const call = object(data.call_socket);
  const calls: Entry[] = typeof call.path === "string"
    ? [{ title: call.path, summary: "Протокол звонков", data: data.call_socket, schemas: [] }] : [];
  for (const [direction, messages] of [["К шлюзу", call.peer_messages], ["От шлюза", call.server_messages]] as const) {
    for (const [title, schema] of Object.entries(object(messages))) {
      if (typeof schema === "string") calls.push({ title, summary: direction, data: { type: title, schema }, schemas: [schema] });
    }
  }
  return { data, groups: [http, socket, calls, [...schemas.values()]], schemas };
}

export class GatewayContractView {
  readonly widget = column();
  private readonly kind = Gtk.DropDown.new_from_strings(["HTTP", "WebSocket", "Звонки", "Схемы"]);
  private readonly search = new Gtk.SearchEntry({ placeholder_text: "Маршрут, сообщение или схема", hexpand: true });
  private readonly status = label("", "dim-label");
  private readonly count = label("", "dim-label");
  private readonly model = new Gtk.StringList();
  private readonly exportButton = button("Сохранить JSON…", () => void this.export());
  private contract?: ReturnType<typeof indexContract>;
  private entries: Entry[] = [];
  private read?: any;
  private details?: any;
  private disposed = false;
  private exporting = false;
  private readonly cancel = new Gio.Cancellable();
  private parentClosed?: number;

  constructor(private readonly parent: any, private readonly gateway: Gateway) {
    if (parent instanceof Adw.Dialog) this.parentClosed = parent.connect("closed", () => this.close());
    const controls = row();
    const filters = row();
    this.exportButton.set_sensitive(false);
    controls.append(button("Обновить контракт", () => void this.refresh()));
    controls.append(this.exportButton);
    filters.append(this.kind);
    filters.append(this.search);
    this.widget.append(controls);
    this.widget.append(this.status);
    this.widget.append(filters);
    this.widget.append(this.count);
    const factory = new Gtk.SignalListItemFactory();
    factory.connect("setup", (_factory: unknown, item: any) => {
      const content = column(3);
      content.set_margin_start(8);
      content.set_margin_end(8);
      content.set_margin_top(6);
      content.set_margin_bottom(6);
      content.append(label("", "heading"));
      content.append(label("", "dim-label"));
      item.set_child(content);
    });
    factory.connect("bind", (_factory: unknown, item: any) => {
      const entry = this.entries[Number(item.get_item().get_string())];
      const content = item.get_child();
      content.get_first_child().set_label(entry.title);
      const summary = content.get_last_child();
      summary.set_label(entry.summary);
      summary.set_visible(Boolean(entry.summary));
    });
    const view = new Gtk.ListView({ model: new Gtk.NoSelection({ model: this.model }), factory, single_click_activate: true });
    view.connect("activate", (_view: unknown, index: number) => {
      const entry = this.entries[index];
      if (entry && this.contract) this.open(entry, this.contract.schemas);
    });
    this.widget.append(new Gtk.ScrolledWindow({ child: view, vexpand: true, hscrollbar_policy: Gtk.PolicyType.NEVER }));
    this.kind.connect("notify::selected", () => this.filter());
    this.search.connect("search-changed", () => this.filter());
  }

  ensureLoaded(): Promise<void> {
    return this.contract ? Promise.resolve() : this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.read || this.disposed) return;
    const cancel = this.read = new Gio.Cancellable();
    this.status.set_label("Чтение контракта шлюза…");
    const [contract, health] = await Promise.allSettled([
      this.gateway.json("GET", "/api/contract", undefined, undefined, false, cancel).then(indexContract),
      this.gateway.publicJson("/api/health", cancel).then(readGatewayHealth),
    ]);
    if (this.disposed) return;
    this.read = undefined;
    if (contract.status === "rejected") {
      const previous = this.contract ? " · показан предыдущий контракт" : "";
      this.status.set_label(`${errorText(contract.reason)}${previous}`);
      return;
    }
    this.contract = contract.value;
    const { data, groups } = contract.value;
    const versions = strings([data.runtime_version, `ABI ${data.abi_version}`]);
    if (health.status === "fulfilled" && health.value.abi_version && health.value.abi_version !== data.abi_version) {
      versions.push(`/api/health сообщает ABI ${health.value.abi_version}`);
    }
    const paths = strings(list(data.core_paths)).join(", ");
    const interfacePaths = strings(list(data.interface_paths)).join(", ");
    if (paths) versions.push(`Служебные пути · ${paths}`);
    if (interfacePaths) versions.push(`Пути интерфейса шлюза · ${interfacePaths}`);
    if (health.status === "rejected") versions.push(`Проверка доступности · ${errorText(health.reason)}`);
    const missing = [...new Set(groups.flatMap(group => group.flatMap(entry => entry.schemas)))].filter(name => !contract.value.schemas.has(name));
    if (missing.length) versions.push(`Нет определений схем · ${missing.join(", ")}`);
    this.status.set_label(versions.join("\n"));
    this.exportButton.set_sensitive(!this.exporting);
    this.filter();
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel.cancel();
    if (this.parentClosed !== undefined) this.parent.disconnect(this.parentClosed);
    this.read?.cancel();
    this.details?.force_close();
  }

  private filter(): void {
    const entries = this.contract?.groups[this.kind.get_selected()] ?? [];
    const terms = this.search.get_text().trim().toLowerCase().split(/\s+/).filter(Boolean);
    this.entries = entries.filter(entry => {
      const { title, summary, schemas } = entry;
      const text = [title, summary, ...schemas, entry.search ??= JSON.stringify(entry.data).toLowerCase()].join(" ").toLowerCase();
      return terms.every((term: string) => text.includes(term));
    });
    this.model.splice(0, this.model.get_n_items(), this.entries.map((_, index) => String(index)));
    this.count.set_label(this.contract ? `Записи · ${this.entries.length} из ${entries.length}` : "");
  }

  private open(entry: Entry, schemas: Map<string, Entry>): void {
    if (this.disposed || this.details) return;
    const content = column();
    const dialog = this.details = sheet(entry.title, content);
    const history = [entry];
    const render = () => {
      if (this.disposed || this.details !== dialog) return;
      clear(content);
      const current = history[history.length - 1]!;
      dialog.set_title(current.title);
      if (history.length > 1) content.append(button("Назад", () => { history.pop(); render(); }));
      for (const name of current.schemas) {
        const schema = schemas.get(name);
        if (schema) content.append(button(name, () => { history.push(schema); render(); }));
        else content.append(label(`Схема отсутствует в контракте · ${name}`, "warning"));
      }
      const json = new Gtk.TextView({ editable: false, monospace: true, wrap_mode: Gtk.WrapMode.CHAR });
      json.get_buffer().set_text(JSON.stringify(current.data, null, 2), -1);
      content.append(json);
    };
    dialog.connect("closed", () => { if (this.details === dialog) this.details = undefined; });
    render();
    dialog.present(this.parent);
  }

  private async export(): Promise<void> {
    const contract = this.contract;
    if (!contract || this.disposed || this.exporting) return;
    this.exporting = true;
    this.exportButton.set_sensitive(false);
    try {
      const destination = await chooseFile(this.parent, "ouroboros-api-contract.json", this.cancel);
      if (!destination || this.disposed) return;
      const bytes = GLib.Bytes.new(new TextEncoder().encode(JSON.stringify(contract.data, null, 2) + "\n"));
      await new Promise<void>((resolve, reject) => {
        destination.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, this.cancel,
          (file: any, result: unknown) => {
            try { file.replace_contents_finish(result); resolve(); } catch (error) { reject(error); }
          });
      });
      if (!this.disposed) this.status.set_label([this.status.get_label(), "Контракт сохранён."].filter(Boolean).join("\n"));
    } catch (error) {
      if (!this.disposed) this.status.set_label(errorText(error));
    } finally {
      this.exporting = false;
      if (!this.disposed) this.exportButton.set_sensitive(Boolean(this.contract));
    }
  }
}
