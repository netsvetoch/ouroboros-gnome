import { showExtensionSettings } from "./extension-settings.js";
import { Adw, Gio, GLib, Gtk, Pango } from "./gi.js";
import { type Gateway, HttpError, query } from "./gateway.js";
import { textArea, type Present } from "./mcp-server.js";
import { ModelCatalog } from "./model-catalog.js";
import { detail, PlaceHistory, type Room } from "./place-history.js";
import { type SettingsDocument, object, ownerHeaders } from "./settings-write.js";
import { button, clear, column, confirm, errorText, label, row, sheet } from "./ui.js";

const path = "/api/places";
const modes = ["active", "silent", "paused"];
const modeNames: Record<string, string> = { active: "Активно", silent: "Тихо", paused: "Пауза" };
const modeNotes: Record<string, string> = {
  active: "Место принимает события, запускает фокус и разрешает действия через подключённый сервис.",
  silent: "События могут запускать фокус. Запись через объявленные инструменты коннектора и очередь доставки удерживается.",
  paused: "Входящие события могут сохраняться. Запуски фокуса и действия здесь приостановлены.",
};
const wakeNames: Record<string, string> = {
  direct_message: "Личные сообщения", group_dm: "Групповые сообщения", mention: "Упоминания", reply_to_me: "Ответы",
  my_thread: "Сообщения в своих ветках", new_issue: "Новые задачи", new_pull_request: "Новые pull request",
  review_requested: "Запросы ревью", assigned: "Назначения", any_message: "Любое сообщение", from_bot: "Сообщения ботов",
  legacy_addressed: "Адресованные сообщения",
};

interface Connector {
  connector: string;
  label: string;
  source?: { url?: string };
  readiness?: { text?: string; tone?: string };
  labels?: Record<string, string>;
  facts?: (string | { id: string; label?: string })[];
  settings?: string;
}
interface Place extends Connector {
  place_id: string;
  account_id: string;
  conversation_id: string;
  state: string;
  revision: number;
  wakes: { fact: string; author?: string }[];
  wake_suggestions?: string[];
  notes: { note_id?: string; text: string; author?: string; at?: string }[];
  owner_accounts: { platform_actor_id: string; account_id?: string; label?: string; confirmed_at?: string }[];
  account_candidates?: { platform_actor_id: string; account_id?: string; label?: string; display_name?: string }[];
  working_folder?: string;
  model?: string;
  unanswered?: number | null;
  spent_24h_usd?: number | null;
  last_activity_at?: string;
  safety_mode?: string;
  rooms?: { room_chat_id: number }[] | null;
}
interface Index {
  places: Place[];
  connectors: Connector[];
  migration_problems?: unknown[];
}
interface Instance {
  account_id: string;
  conversation_id: string;
  label: string;
}
interface Account {
  id: string;
  label: string;
  kind: "user" | "bot";
}
interface ConnectorStatus {
  ok?: boolean;
  error?: string;
  account_id?: string;
  text?: string;
  tone?: string;
  connect?: unknown;
  identity?: { sends_as?: unknown; reads_as?: unknown[] };
  labels?: Record<string, string>;
}

function placeDetail(target: any, ...values: unknown[]): void {
  detail(target, ...values);
  const caption = target.get_last_child();
  if (caption instanceof Gtk.Label) {
    caption.set_wrap_mode(Pango.WrapMode.WORD_CHAR);
    caption.set_max_width_chars(80);
  }
}

function placeButton(text: string, activate: () => void): any {
  const widget = button(text, activate);
  const caption = widget.get_child();
  if (caption instanceof Gtk.Label) {
    caption.set_wrap(true);
    caption.set_wrap_mode(Pango.WrapMode.WORD_CHAR);
    caption.set_max_width_chars(48);
  }
  return widget;
}

const itemPath = (id: string) => `${path}/${encodeURIComponent(id)}`;
const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value: Record<string, any>, keys: string[]) => keys.every(key => value[key] == null || typeof value[key] === "string");
const optional = (value: unknown, valid: (value: any) => boolean) => value == null || valid(value);
const stringMap = (value: unknown) => record(value) && Object.values(value).every(item => typeof item === "string");
function validConnector(value: unknown): value is Connector {
  return record(value) && typeof value.connector === "string" && Boolean(value.connector.trim()) && typeof value.label === "string"
    && strings(value, ["settings"])
    && optional(value.source, source => record(source) && strings(source, ["url"]))
    && optional(value.readiness, readiness => record(readiness) && strings(readiness, ["text", "tone"]))
    && optional(value.labels, stringMap)
    && optional(value.facts, facts => Array.isArray(facts) && facts.every(fact => typeof fact === "string"
      || record(fact) && typeof fact.id === "string" && Boolean(fact.id) && strings(fact, ["label"])));
}
function validPlace(value: unknown): value is Place {
  if (!validConnector(value)) return false;
  const place = value as unknown as Record<string, any>;
  const entries = (value: unknown, key: string, rest: string[]) => Array.isArray(value) && value.every(item =>
    record(item) && typeof item[key] === "string" && strings(item, rest));
  return typeof place.place_id === "string" && Boolean(place.place_id.trim())
    && Number.isSafeInteger(place.revision) && place.revision >= 0
    && typeof place.account_id === "string" && typeof place.conversation_id === "string"
    && typeof place.state === "string" && Boolean(place.state)
    && strings(place, ["working_folder", "model", "last_activity_at", "safety_mode"])
    && entries(place.wakes, "fact", ["author"]) && entries(place.notes, "text", ["note_id", "author", "at"])
    && entries(place.owner_accounts, "platform_actor_id", ["account_id", "label", "confirmed_at"])
    && optional(place.account_candidates, items => entries(items, "platform_actor_id", ["account_id", "label", "display_name"]))
    && optional(place.wake_suggestions, items => Array.isArray(items) && items.every(item => typeof item === "string"))
    && optional(place.rooms, rooms => Array.isArray(rooms) && rooms.every(room => record(room)
      && Number.isSafeInteger(room.room_chat_id) && room.room_chat_id > 0))
    && optional(place.unanswered, count => Number.isSafeInteger(count) && count >= 0)
    && optional(place.spent_24h_usd, cost => typeof cost === "number" && Number.isFinite(cost));
}
function readPlaces(value: unknown): Index {
  if (!record(value) || !Array.isArray(value.places) || !value.places.every(validPlace)
    || !Array.isArray(value.connectors) || !value.connectors.every(validConnector)
    || !optional(value.migration_problems, Array.isArray)
    || new Set(value.places.map((place: Place) => place.place_id)).size !== value.places.length) {
    throw new Error("Шлюз не подтвердил целый список мест и коннекторов.");
  }
  return value as Index;
}

function account(value: unknown): Account | undefined {
  const { id, label, kind } = object(value);
  if (record(value) && Object.keys(value).length === 3 && Object.keys(value).every(key => ["id", "label", "kind"].includes(key))
    && typeof id === "string" && id.trim() && [...id].length <= 200
    && typeof label === "string" && label.trim() && [...label].length <= 200 && (kind === "user" || kind === "bot")) return { id, label, kind };
  return undefined;
}

// Credential identity is one declaration: a malformed member invalidates all of it.
function statusIdentity(value: unknown): ConnectorStatus["identity"] {
  if (!record(value) || Object.keys(value).some(key => !["sends_as", "reads_as"].includes(key))
    || (Object.hasOwn(value, "sends_as") && !account(value.sends_as))
    || (Object.hasOwn(value, "reads_as") && (!Array.isArray(value.reads_as) || !value.reads_as.every(account)))) return undefined;
  return value;
}

function labelsOf(row: Connector, status?: ConnectorStatus): Record<string, string> {
  const labels = Object.fromEntries((row.facts ?? []).flatMap((fact) => fact && typeof fact !== "string" && fact.id && fact.label ? [[fact.id, fact.label]] : []));
  for (const value of [row.labels, status?.labels]) {
    for (const [key, label] of Object.entries(object(value))) if (typeof label === "string" && label) labels[key] = label;
  }
  return labels;
}

function choices(value: unknown): { rows: Instance[]; status: string; state: "absent" | "unavailable" | "empty" | "known" } {
  if (value === undefined) return { state: "absent", rows: [], status: "Коннектор не объявил список отдельных подключений." };
  if (!Array.isArray(value)) return { state: "unavailable", rows: [], status: "Список отдельных подключений недоступен." };
  const rows = value.filter((row): row is Instance => Boolean(row && typeof row.account_id === "string" && row.account_id.trim()
    && typeof row.conversation_id === "string" && typeof row.label === "string" && row.label.trim()));
  return { state: rows.length ? "known" : value.length ? "unavailable" : "empty", rows, status: rows.length ? "" : value.length ? "Коннектор вернул непригодные записи подключений." : "Отдельные подключения пока не предложены." };
}

export class Places {
  private dialog?: any;
  private snapshot?: Index;
  private reading = 0;
  private readCancel?: any;
  private disposed = false;
  private readonly dialogs = new Set<any>();
  private list?: any;
  private status?: any;
  private readonly rooms: PlaceHistory;
  private readonly models: ModelCatalog;
  private readonly writes = new Set<string>();
  private readonly detached = new Map<string, Place>();

  constructor(private readonly gateway: Gateway, private readonly present: Present,
    private readonly openSkills: () => void, openTask?: (id: string) => void) {
    const child: Present = (dialog, parent) => {
      if (!this.available(parent)) return;
      this.own(dialog, parent);
      present(dialog, parent);
    };
    this.rooms = new PlaceHistory(gateway, child, openTask);
    this.models = new ModelCatalog(gateway, child);
  }

  private available(parent?: any): boolean {
    return !this.disposed && (!parent || parent.get_mapped?.() !== false);
  }

  private own(dialog: any, parent?: any, retired?: () => void): { cancel: any; alive: () => boolean } {
    const cancel = new Gio.Cancellable();
    let open = true;
    const signals: [any, number][] = [];
    this.dialogs.add(dialog);
    const retire = () => {
      if (!open) return;
      open = false;
      cancel.cancel();
      this.dialogs.delete(dialog);
      for (const [object, signal] of signals.splice(0)) object.disconnect(signal);
      retired?.();
    };
    dialog.connect("closed", retire);
    const follow = (object: any, signal: string) => signals.push([object, object.connect(signal, () => {
      // A plain Gtk.Window may destroy/unmap a dialog without emitting its closed signal.
      // Retire the operation before asking GTK to close the visible surface.
      if (open) { retire(); dialog.force_close(); }
      return false;
    })]);
    if (parent instanceof Adw.Dialog) follow(parent, "closed");
    const window = parent instanceof Gtk.Window ? parent : parent?.get_root?.();
    if (window instanceof Gtk.Window) follow(window, "close-request");
    return { cancel, alive: () => open && !this.disposed };
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.readCancel?.cancel();
    for (const dialog of [...this.dialogs].reverse()) dialog.force_close();
  }

  show(parent?: any): void {
    if (!this.available(parent) || this.dialog) return;
    const content = column(12);
    const dialog = sheet("Места Ouroboros", content);
    dialog.set_content_width(720);
    dialog.set_content_height(650);
    this.dialog = dialog;
    this.own(dialog, parent, () => {
      if (this.dialog !== dialog) return;
      this.readCancel?.cancel();
      this.dialog = this.status = this.list = undefined;
      this.reading++;
    });
    this.status = label("", "dim-label");
    this.list = column(8);
    const tools = row();
    tools.append(placeButton("Обновить список", () => { if (this.dialog === dialog) void this.refresh(); }));
    tools.append(placeButton("Подключить место…", () => { if (this.dialog === dialog) this.connectors(dialog); }));
    for (const widget of [tools, this.status, this.list]) content.append(widget);
    this.present(dialog, parent);
    this.render();
    void this.refresh();
  }

  openWakeRoom(parent: any, chatId: number): void {
    if (!this.available(parent) || !Number.isSafeInteger(chatId) || chatId <= 1) return;
    const content = column();
    const dialog = sheet("Разговор пробуждения", content);
    const status = label("", "dim-label");
    let pending: any;
    const life = this.own(dialog, parent, () => pending?.cancel()), live = life.alive;
    const load = async () => {
      if (!live() || pending) return;
      const cancel = new Gio.Cancellable();
      pending = cancel;
      retry.set_sensitive(false);
      status.set_label("Ищу сохранённую комнату…");
      try {
        const { places } = await this.read(cancel);
        const candidates = places.filter((place) => place?.place_id && (!Array.isArray(place.rooms)
          || place.rooms.some((room) => room?.room_chat_id === chatId)));
        const matches: { place: Place; room: Room }[] = [];
        let unavailable: unknown;
        let incomplete = false;
        for (const place of candidates) {
          if (!live()) return;
          try {
            const result = await this.rooms.capture(place.place_id, cancel);
            const room = result.rooms.find((room) => room.room_chat_id === chatId);
            if (room) matches.push({ place, room });
            incomplete ||= result.coverage.importing || result.coverage.gaps;
          } catch (error) {
            unavailable ??= error;
          }
        }
        if (!live()) return;
        if (matches.length > 1) throw new Error("Шлюз указал одну комнату в нескольких местах.");
        const match = matches[0];
        if (match) {
          const labels = labelsOf(match.place);
          dialog.close();
          this.rooms.history(parent, match.room, labels);
        } else if (unavailable) throw unavailable;
        else status.set_label(incomplete ? "Комната пока не найдена. Индекс неполный."
          : "Комната отсутствует в доступном индексе мест.");
      } catch (error) {
        if (live()) status.set_label(errorText(error));
      } finally {
        pending = undefined;
        if (live()) retry.set_sensitive(true);
      }
    };
    const retry = placeButton("Повторить поиск", () => void load());
    content.append(status);
    content.append(retry);
    this.present(dialog, parent);
    void load();
  }

  private async read(cancel?: any): Promise<Index> {
    return readPlaces(await this.gateway.json<unknown>("GET", path, undefined, undefined, false, cancel));
  }

  private async refresh(): Promise<void> {
    const dialog = this.dialog;
    if (!dialog || this.disposed) return;
    const id = ++this.reading;
    this.readCancel?.cancel();
    const cancel = new Gio.Cancellable();
    this.readCancel = cancel;
    this.status.set_label("Читаю места…");
    try {
      const index = await this.read(cancel);
      if (this.dialog !== dialog || id !== this.reading) return;
      // A complete verified roster can confirm a disconnect whose write receipt was lost.
      const connected = new Set(index.places.map(place => place.place_id));
      for (const previous of this.snapshot?.places ?? []) {
        if (!connected.has(previous.place_id)) this.detached.set(previous.place_id, previous);
      }
      this.snapshot = index;
      this.status.set_label("");
      this.render();
    } catch (error) {
      if (this.dialog === dialog && id === this.reading) this.status.set_label(
        (this.snapshot ? "Показан ранее прочитанный список. " : "") + errorText(error));
    } finally {
      if (this.readCancel === cancel) this.readCancel = undefined;
    }
  }

  private render(): void {
    if (!this.list || !this.dialog || this.disposed) return;
    const list = this.list, dialog = this.dialog;
    const active = (widget: any) => this.dialog === dialog && this.list === list && widget.get_parent() === list;
    clear(this.list);
    const index = this.snapshot;
    if (!index) return;
    if (!index.places.length) placeDetail(this.list, "Подключённых мест нет.");
    for (const place of index.places) {
      if (!validPlace(place)) continue;
      this.detached.delete(place.place_id);
      const edit = placeButton(place.label || place.place_id, () => { if (active(edit)) this.edit(dialog, place); });
      this.list.append(edit);
      placeDetail(this.list, modeNames[place.state] ?? place.state, place.readiness?.text, place.last_activity_at,
        place.unanswered == null ? "число открытых фокусов неизвестно" : `открытых фокусов ${place.unanswered}`,
        place.spent_24h_usd == null ? "расход за сутки неизвестен" : `${place.spent_24h_usd} USD за сутки`);
    }
    for (const place of this.detached.values()) {
      const rooms = placeButton(`Комнаты отключённого места · ${place.label}…`,
        () => { if (active(rooms)) this.rooms.rooms(dialog, place.place_id, place.label, labelsOf(place)); });
      this.list.append(rooms);
    }
    for (const problem of index.migration_problems ?? []) placeDetail(this.list, "Проблема переноса", typeof problem === "object" ? JSON.stringify(problem) : problem);
  }

  private async statusOf(connector: Connector, accountId?: string, cancel?: any): Promise<ConnectorStatus> {
    const prefix = `/api/extensions/${encodeURIComponent(connector.connector)}/`;
    const url = connector.source?.url ?? "";
    const segments = url.startsWith(prefix) ? url.slice(prefix.length).split("/") : [];
    if (!segments.length || segments.some((segment) => !segment || segment === "." || segment === "..")
      || prefix + segments.map(encodeURIComponent).join("/") !== url) throw new Error("Коннектор не объявил допустимый маршрут состояния.");
    const result = await this.gateway.json<unknown>("GET", url + query({ account_id: accountId || undefined }), undefined, undefined, false, cancel);
    if (!record(result) || !strings(result, ["text", "tone", "account_id", "error"])
      || result.ok === false || result.error) {
      throw new Error(record(result) && typeof result.error === "string" ? result.error : "Состояние коннектора недоступно.");
    }
    if (accountId && Object.hasOwn(result, "account_id") && result.account_id !== accountId) throw new Error("Коннектор вернул состояние другого аккаунта.");
    return { ...result, identity: statusIdentity(result.identity), labels: stringMap(result.labels) ? result.labels : undefined };
  }

  private connectorSettings(parent: any, connector: Connector): void {
    if (!this.available(parent)) return;
    if (!connector.settings) { this.openSkills(); return; }
    showExtensionSettings(this.gateway, connector.connector, dialog => {
      this.own(dialog, parent);
      this.present(dialog, parent);
    }, parent, connector.settings);
  }

  private connectors(parent: any): void {
    if (!this.available(parent)) return;
    const content = column();
    const dialog = sheet("Подключить место", content);
    const status = label("", "dim-label");
    const list = column();
    const life = this.own(dialog, parent), live = life.alive;
    let busy = false;
    const load = async () => {
      if (!live() || busy) return;
      busy = true;
      status.set_label("Читаю коннекторы…");
      try {
        const result = await this.read(life.cancel);
        if (!live()) return;
        status.set_label("");
        clear(list);
        if (!result.connectors.length) placeDetail(list, "Установленные навыки пока не объявили коннекторов мест.");
        for (const connector of result.connectors) {
          list.append(placeButton(connector.label || connector.connector, () => { if (live()) this.instances(dialog, connector, result.places); }));
          placeDetail(list, connector.connector, connector.readiness?.text);
        }
      } catch (error) { if (live()) status.set_label(errorText(error)); }
      finally { busy = false; }
    };
    content.append(label("Новое место подключается в тихом режиме.", "dim-label"));
    content.append(placeButton("Перечитать коннекторы", () => void load()));
    content.append(placeButton("Открыть навыки…", () => { if (live()) { dialog.force_close(); this.openSkills(); } }));
    content.append(status);
    content.append(list);
    this.present(dialog, parent);
    void load();
  }

  private instances(parent: any, connector: Connector, places: Place[]): void {
    if (!this.available(parent)) return;
    const content = column();
    const dialog = sheet(connector.label, content);
    const status = label("", "dim-label");
    const list = column();
    const life = this.own(dialog, parent), live = life.alive;
    let reading = false;
    const add = (where: Instance | undefined) => {
      const existing = places.find((item) => item.connector === connector.connector && item.account_id === (where?.account_id ?? "")
        && item.conversation_id === (where?.conversation_id ?? ""));
      const name = where?.label || "Весь аккаунт";
      list.append(placeButton(existing ? `Открыть · ${name}` : `Подключить · ${name}…`, () => {
        if (!live()) return;
        if (existing) this.edit(dialog, existing);
        else this.connect(dialog, connector, where);
      }));
      if (where) placeDetail(list, where.account_id, where.conversation_id);
    };
    const load = async () => {
      if (!live() || reading) return;
      reading = true;
      clear(list);
      settings.set_visible(false);
      add(undefined);
      if (!connector.source?.url) {
        status.set_label(connector.readiness?.text || "Коннектор не объявил маршрут состояния.");
        reading = false;
        return;
      }
      status.set_label("Читаю варианты подключения…");
      try {
        const response = await this.statusOf(connector, undefined, life.cancel);
        if (!live()) return;
        const available = choices(response.connect);
        status.set_label([response.text, available.status].filter(Boolean).join("\n"));
        for (const item of available.rows) add(item);
        settings.set_visible(available.state === "empty");
      } catch (error) { if (live()) status.set_label(errorText(error)); }
      finally { reading = false; }
    };
    const settings = placeButton(connector.settings ? "Открыть настройки коннектора…" : "Открыть навыки…",
      () => { if (live() && settings.get_visible()) this.connectorSettings(dialog, connector); });
    settings.set_visible(false);
    for (const widget of [placeButton("Перечитать варианты", () => void load()), status, list, settings]) content.append(widget);
    this.present(dialog, parent);
    void load();
  }

  private connect(parent: any, connector: Connector, where?: Instance): void {
    if (!this.available(parent)) return;
    const content = column();
    const dialog = sheet(where?.label || "Подключить весь аккаунт", content);
    const name = new Gtk.Entry({ text: where?.label ?? "", placeholder_text: "Название места (необязательно)" });
    const status = label("", "dim-label");
    const life = this.own(dialog, parent), live = life.alive;
    const key = JSON.stringify([connector.connector, where?.account_id, where?.conversation_id]);
    const submit = placeButton("Подключить", () => {
      void (async () => {
        if (!live() || this.writes.has(key)) return;
        this.writes.add(key);
        submit.set_sensitive(false);
        try {
          const result = await this.gateway.json<{ ok: boolean; place?: Place; error?: string }>("POST", path, {
            connector: connector.connector,
            ...(where ? { account_id: where.account_id, conversation_id: where.conversation_id } : {}),
            ...(name.get_text().trim() ? { label: name.get_text().trim() } : {}),
          }, ownerHeaders, false, life.cancel);
          if (result.ok !== true || !validPlace(result.place) || result.place.connector !== connector.connector
            || result.place.account_id !== (where?.account_id ?? "") || result.place.conversation_id !== (where?.conversation_id ?? "")) {
            throw new Error(result.error || "Шлюз не подтвердил подключение выбранного места.");
          }
          if (live()) {
            dialog.force_close();
            this.edit(parent, result.place);
          }
        } catch (error) {
          if (live()) status.set_label(error instanceof HttpError ? errorText(error) : `Итог подключения неизвестен. Обновите список мест. ${errorText(error)}`);
        } finally {
          this.writes.delete(key);
          void this.refresh();
          if (live()) submit.set_sensitive(true);
        }
      })();
    });
    placeDetail(content, connector.label, where ? where.account_id : "Выбран весь аккаунт", where?.conversation_id);
    content.append(label("Новое место начнёт работу в тихом режиме."));
    for (const widget of [name, status, submit]) content.append(widget);
    this.present(dialog, parent);
  }

  private edit(parent: any, initial: Place): void {
    if (!this.available(parent)) return;
    const content = column(10);
    const dialog = sheet(initial.label, content);
    dialog.set_content_width(710);
    dialog.set_content_height(670);
    const savedFacts = column(4);
    const status = label("", "dim-label");
    const connectorFacts = column(4);
    const mode = Gtk.DropDown.new_from_strings(modes.map((item) => modeNames[item]));
    mode.set_selected(modes.includes(initial.state) ? modes.indexOf(initial.state) : Gtk.INVALID_LIST_POSITION);
    const modeHelp = label(modeNotes[initial.state] ?? "", "dim-label");
    mode.connect("notify::selected", () => { if (live()) modeHelp.set_label(modeNotes[modes[mode.get_selected()]] ?? ""); });
    const folder = new Gtk.Entry({ text: initial.working_folder ?? "", placeholder_text: "Рабочая папка на шлюзе" });
    const model = new Gtk.Entry({ text: initial.model ?? "", placeholder_text: "Модель фокуса" });
    const wakeBox = column(4);
    const wakeControls = new Map<string, any>();
    const notes = column();
    const note = textArea();
    const owners = column();
    const actor = new Gtk.Entry({ placeholder_text: "ID аккаунта владельца" });
    const actorLabel = new Gtk.Entry({ placeholder_text: "Имя аккаунта (необязательно)" });
    const actorScope = new Gtk.Entry({ placeholder_text: "Область аккаунта (по умолчанию область места)" });
    const form = column();
    const writeControls = column();
    let current: Place | undefined = initial;
    let connector: ConnectorStatus | undefined;
    let connectorRead = 0;
    let busy = false;
    const life = this.own(dialog, parent, () => {
      connectorRead++;
      form.remove(mode);
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { mode.run_dispose(); return GLib.SOURCE_REMOVE; });
    }), live = life.alive;
    let unknown = false;
    const id = initial.place_id;
    const sync = () => {
      form.set_sensitive(!busy && !unknown && Boolean(current));
      writeControls.set_sensitive(!busy && !unknown && Boolean(current));
    };
    const update = async (method: "POST" | "DELETE", patch: SettingsDocument, after?: () => void) => {
      const place = current;
      if (!live() || !place || busy || unknown || this.writes.has(id)) return;
      this.writes.add(id);
      busy = true;
      sync();
      status.set_label("Шлюз сохраняет изменение…");
      try {
        if (method === "DELETE") {
          try { await this.rooms.capture(id, life.cancel); } catch { /* disconnect can proceed without a room index */ }
          if (!live()) return;
        }
        const result = await this.gateway.json<{ ok: boolean; place?: Place; error?: string }>(method, itemPath(id), {
          ...patch, expected_revision: place.revision,
        }, ownerHeaders, false, life.cancel);
        if (result.ok !== true || (method === "POST" && (!validPlace(result.place) || result.place.place_id !== id))) {
          throw new Error(result.error || "Шлюз не подтвердил изменение.");
        }
        if (method === "DELETE") {
          this.detached.set(id, place);
          if (!live()) return;
          current = undefined;
          status.set_label("Место отключено. Сохранённая история остаётся на шлюзе.");
          paint();
        } else if (live()) {
          status.set_label("Изменение сохранено.");
          reconcile(result.place!, new Set(Object.keys(patch)));
          after?.();
        }
      } catch (error) {
        if (!live()) return;
        if (error instanceof HttpError && error.status === 409 && error.reason === "place_revision_conflict") {
          const latest = object(error.body).place as Place | null | undefined;
          status.set_label("Версия места изменилась. Черновик сохранён. Проверьте новое состояние перед повторным сохранением.");
          if (validPlace(latest) && latest.place_id === id) reconcile(latest);
          else if (latest === null) {
            this.detached.set(id, place);
            current = undefined;
            paint();
          } else unknown = true;
        } else if (error instanceof HttpError && error.status < 500) status.set_label(errorText(error));
        else {
          unknown = true;
          status.set_label(`Итог изменения неизвестен. Перечитайте место перед повтором. ${errorText(error)}`);
        }
      } finally {
        this.writes.delete(id);
        busy = false;
        if (live()) sync();
        void this.refresh();
      }
    };

    const selectedWakes = () => [...wakeControls].filter(([, widget]) => widget.get_active()).map(([id]) => id);
    const paintWakes = (place: Place, checked: string[]) => {
      const recorded = new Map(place.wakes.map((wake) => [wake.fact, wake.author]));
      const facts = place.facts?.map((item) => typeof item === "string" ? item : item.id)
        ?? Object.keys(wakeNames).filter((key) => key !== "legacy_addressed");
      const keys = new Set([...facts, ...recorded.keys(), ...checked]);
      clear(wakeBox);
      wakeControls.clear();
      const names = labelsOf(place, connector);
      for (const key of keys) {
        if (!key) continue;
        const caption = [names[key] ?? wakeNames[key] ?? key, recorded.get(key)].filter(Boolean).join(" · ");
        const check = new Gtk.CheckButton({ label: caption, active: checked.includes(key) });
        const text = check.get_child();
        if (text instanceof Gtk.Label) {
          text.set_wrap(true);
          text.set_wrap_mode(Pango.WrapMode.WORD_CHAR);
          text.set_max_width_chars(48);
        }
        wakeBox.append(check);
        wakeControls.set(key, check);
      }
    };
    const reconcile = (latest: Place, submitted = new Set<string>()) => {
      const old = current;
      const oldWakes = old?.wakes.map((wake) => wake.fact) ?? [];
      const selected = new Set(selectedWakes());
      const draft = new Set(latest.wakes.map((wake) => wake.fact));
      if (old && !submitted.has("wakes")) {
        for (const item of oldWakes) if (!selected.has(item)) draft.delete(item);
        for (const item of selected) if (!oldWakes.includes(item)) draft.add(item);
      }
      if (submitted.has("state") || !old || (modes[mode.get_selected()] ?? old.state) === old.state) {
        mode.set_selected(modes.includes(latest.state) ? modes.indexOf(latest.state) : Gtk.INVALID_LIST_POSITION);
      }
      if (submitted.has("working_folder") || !old || folder.get_text() === (old.working_folder ?? "")) folder.set_text(latest.working_folder ?? "");
      if (submitted.has("model") || !old || model.get_text() === (old.model ?? "")) model.set_text(latest.model ?? "");
      current = latest;
      unknown = false;
      connectorRead++;
      connector = undefined;
      paintWakes(latest, [...draft]);
      paint();
      void loadConnector();
    };
    const ownerConfirm = async (id: string, name: string, scope?: string, after?: () => void) => {
      const revision = current?.revision;
      if (!live() || !id || !await confirm(dialog, `Подтвердить аккаунт «${name || id}»?`,
        "В пределах этого места Ouroboros будет считать сообщения этого аккаунта сообщениями владельца.", "Подтвердить аккаунт", life.cancel)
        || current?.revision !== revision) return;
      await update("POST", { confirm_owner_account: { platform_actor_id: id, label: name, ...(scope ? { account_id: scope } : {}) } }, after);
    };
    const paint = () => {
      clear(savedFacts);
      clear(connectorFacts);
      clear(notes);
      clear(owners);
      const place = current;
      if (!place) { placeDetail(savedFacts, "Место отсутствует в актуальном списке."); sync(); return; }
      placeDetail(savedFacts, `Сохранено · ${modeNames[place.state] ?? place.state}`, `ревизия ${place.revision}`, place.account_id, place.conversation_id);
      placeDetail(savedFacts, connector?.text ?? place.readiness?.text, place.safety_mode && `Safety · ${place.safety_mode}`,
        place.last_activity_at, place.unanswered == null ? "число открытых фокусов неизвестно" : `открытых фокусов ${place.unanswered}`);
      const sender = account(connector?.identity?.sends_as);
      const candidates = connector?.identity?.reads_as;
      const readers = (Array.isArray(candidates) ? candidates : []).map(account).filter((item): item is Account => Boolean(item));
      const confirmed = (id: string) => place.owner_accounts.some((item) => item.platform_actor_id === id
        && (!item.account_id || item.account_id === place.account_id));
      if (sender) placeDetail(connectorFacts, "Пишет от", sender.label, sender.kind, sender.kind === "user" && confirmed(sender.id) && "вы");
      if (readers.length) placeDetail(connectorFacts, "Читает от", readers.map((item) => item.label).join(", "));
      if (sender?.kind === "user" && !confirmed(sender.id)) owners.append(placeButton(`Это мой аккаунт · ${sender.label}…`, () => void ownerConfirm(sender.id, sender.label)));
      for (const item of place.owner_accounts) {
        placeDetail(owners, item.label || item.platform_actor_id, item.platform_actor_id, item.account_id, item.confirmed_at);
        if ((item.account_id ?? place.account_id) === place.account_id) owners.append(placeButton(`Отозвать подтверждение · ${item.label || item.platform_actor_id}`, () => {
          void update("POST", { revoke_owner_account: item.platform_actor_id });
        }));
      }
      for (const item of place.account_candidates ?? []) {
        if (!item.platform_actor_id || confirmed(item.platform_actor_id) || item.platform_actor_id === sender?.id) continue;
        const name = item.label || item.display_name || "";
        owners.append(placeButton(`Это мой аккаунт · ${name || item.platform_actor_id}…`, () => void ownerConfirm(item.platform_actor_id, name)));
      }
      for (const entry of place.notes) {
        placeDetail(notes, entry.text, entry.author, entry.at);
        if (entry.note_id) notes.append(placeButton("Удалить заметку", () => void update("POST", { remove_note: entry.note_id })));
      }
      sync();
    };
    const loadConnector = async () => {
      if (!live()) return;
      const place = current;
      if (!place?.source?.url) return;
      const token = ++connectorRead;
      try {
        const value = await this.statusOf(place, place.account_id, life.cancel);
        if (!live() || token !== connectorRead || current !== place) return;
        connector = value;
        paintWakes(place, selectedWakes());
        paint();
      } catch (error) {
        if (live() && token === connectorRead) placeDetail(connectorFacts, errorText(error));
      }
    };
    const reload = async () => {
      if (busy || !live()) return;
      busy = true;
      sync();
      try {
        const index = await this.read(life.cancel);
        if (!live()) return;
        const latest = index.places.find((item) => item.place_id === id);
        status.set_label(latest ? "Состояние перечитано. Изменения в форме сохранены как черновик." : "Место отсутствует в актуальном списке.");
        if (validPlace(latest)) reconcile(latest);
        else { current = undefined; paint(); }
      } catch (error) { if (live()) status.set_label(errorText(error)); }
      finally { busy = false; if (live()) sync(); }
    };

    const controls = row();
    controls.append(placeButton("Перечитать место", () => void reload()));
    controls.append(placeButton("Комнаты…", () => { if (live()) this.rooms.rooms(dialog, id, initial.label, labelsOf(current ?? initial, connector)); }));
    controls.append(placeButton("Навыки коннектора…", () => { if (live()) this.openSkills(); }));
    form.append(mode);
    form.append(modeHelp);
    form.append(new Gtk.Expander({ label: "События для запуска фокуса", child: wakeBox, expanded: true }));
    form.append(folder);
    const modelRow = row();
    model.set_hexpand(true);
    modelRow.append(model);
    modelRow.append(placeButton("Выбрать модель…", () => { if (live()) this.models.pick(dialog, (item) => { if (live()) model.set_text(item.value); }); }));
    form.append(modelRow);
    form.append(placeButton("Сохранить параметры", () => {
      if (!live()) return;
      const place = current;
      if (!place) return;
      const patch: SettingsDocument = {};
      const state = modes[mode.get_selected()];
      const wakes = selectedWakes();
      if (state && state !== place.state) patch.state = state;
      if (JSON.stringify([...wakes].sort()) !== JSON.stringify(place.wakes.map((entry) => entry.fact).sort())) patch.wakes = wakes;
      if (folder.get_text().trim() !== (place.working_folder ?? "")) patch.working_folder = folder.get_text().trim();
      if (model.get_text().trim() !== (place.model ?? "")) patch.model = model.get_text().trim();
      if (Object.keys(patch).length) void update("POST", patch);
    }));
    const noteBox = column();
    noteBox.append(notes);
    noteBox.append(note.widget);
    noteBox.append(placeButton("Добавить заметку", () => {
      const text = note.read();
      if (text.trim()) void update("POST", { add_note: text }, note.clear);
    }));
    writeControls.append(new Gtk.Expander({ label: "Заметки", child: noteBox }));
    const accountBox = column();
    for (const item of [owners, actor, actorLabel, actorScope, placeButton("Подтвердить введённый аккаунт…", () => {
      void ownerConfirm(actor.get_text().trim(), actorLabel.get_text().trim(), actorScope.get_text().trim(),
        () => { for (const item of [actor, actorLabel, actorScope]) item.set_text(""); });
    })]) accountBox.append(item);
    writeControls.append(new Gtk.Expander({ label: "Аккаунты владельца", child: accountBox }));
    const disconnect = placeButton("Отключить место…", () => {
      void (async () => {
        if (!live()) return;
        const revision = current?.revision;
        if (await confirm(dialog, "Отключить место?", "Привязка будет удалена. Сохранённая история комнаты останется.", "Отключить", life.cancel)
          && current?.revision === revision) await update("DELETE", {});
      })();
    });
    disconnect.add_css_class("destructive-action");
    writeControls.append(disconnect);
    for (const widget of [controls, savedFacts, connectorFacts, status, form, writeControls]) content.append(widget);
    this.present(dialog, parent);
    paintWakes(initial, initial.wakes.map(({ fact }) => fact));
    paint();
    void loadConnector();
  }
}
