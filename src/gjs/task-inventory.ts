import { cancellationCaption } from "./task-cancellation.js";
import { projectHoldCaption } from "./project-hold.js";
import type { Room } from "./chat.js";
import { type Gateway, query } from "./gateway.js";
import { Gio, GLib, Gtk, Pango } from "./gi.js";
import type { ProjectTarget } from "./project-handoff.js";
import { object } from "./settings-write.js";
import { notStarted } from "./submission-notices.js";
import type { Task } from "./tasks.js";
import { button, column, errorText, label, row } from "./ui.js";

const scopes = ["Задачи и очередь", "Только очередь"];
const limits = [50, 100, 250, 500, 0];
const filters = [
  { label: "Все состояния" },
  { label: "Ожидают запуска", value: "requested,scheduled,queued,pending" },
  { label: "В работе", value: "starting,running" },
  { label: "Пауза и прерывание", value: "paused,budget_paused,owner_paused,technical_pause,interrupted" },
  { label: "Завершены", value: "completed" },
  { label: "С ошибкой или отказом запуска", value: "failed" },
  { label: "Остановлены", value: "cancelled" },
  { label: "Отклонены как дубликаты", value: "rejected_duplicate" },
  { label: "Свои состояния", custom: true },
];

const statusNames: Record<string, string> = {
  requested: "Запрошена", scheduled: "Запланирована", queued: "В очереди", pending: "Ожидает",
  running: "Выполняется", starting: "Запускается", paused: "На паузе", budget_paused: "Пауза по бюджету",
  owner_paused: "Пауза владельца", technical_pause: "Техническая пауза", interrupted: "Прервана",
  completed: "Завершена", failed: "Ошибка", cancelled: "Остановлена", rejected_duplicate: "Отклонена как дубликат",
};
const queueBuckets = ["running", "pending"] as const;
type Bucket = typeof queueBuckets[number];
interface Item { id: string; task: Task; saved: boolean; buckets: Set<Bucket> }
interface Snapshot { items: Map<string, Item>; count: number; ignored: number; queueKnown: boolean; queueTime: string; queueReason: string }

const text = (value: unknown): string => typeof value === "string" ? value : "";
const taskId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value);
const fold = (value: string): string => value.normalize("NFKC").toLocaleLowerCase("ru");

export function taskTitle(task: Task): string {
  return text(task.suggested_name) || text(task.title) || text(task.objective) || text(task.description)
    || text(task.task_id) || text(task.id) || "Задача";
}

function exactId(row: Record<string, unknown>): string | undefined {
  const id = row.task_id ?? row.id;
  if (taskId(id) && [row.task_id, row.id].every(value => value === undefined || value === id)) return id;
  return undefined;
}

function projectInventory(raw: unknown, queueOnly: boolean, stateFilter?: string): Snapshot {
  const result = object(raw);
  if (!Array.isArray(result.tasks)) throw new Error("Шлюз не вернул список задач.");
  const items = new Map<string, Item>();
  let ignored = 0;
  for (const value of queueOnly ? [] : result.tasks) {
    const task = object(value);
    const id = exactId(task);
    if (id && !items.has(id)) items.set(id, { id, task: { ...task, task_id: id }, saved: true, buckets: new Set() });
    else ignored++;
  }
  const count = items.size;
  const queue = object(result.queue);
  let queueKnown = true;
  const seenQueue = new Set<string>();
  for (const bucket of queueBuckets) {
    const rows = queue[bucket];
    if (!Array.isArray(rows)) {
      queueKnown = false;
      continue;
    }
    const count = queue[`${bucket}_count`];
    if (count !== undefined && (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count !== rows.length)) queueKnown = false;
    for (const value of rows) {
      const entry = object(value);
      const task = object(entry.task);
      const outer = exactId(entry);
      const inner = exactId(task);
      const id = outer ?? inner;
      if (!id || (outer && inner && outer !== inner)
        || ((entry.id !== undefined || entry.task_id !== undefined) && !outer)
        || ((task.id !== undefined || task.task_id !== undefined) && !inner)) {
        queueKnown = false;
        continue;
      }
      if (seenQueue.has(id)) queueKnown = false;
      seenQueue.add(id);
      const known = items.get(id);
      if (known) {
        known.buckets.add(bucket);
        if (Object.hasOwn(task, "project_admission_hold")) known.task = { ...known.task, project_admission_hold: task.project_admission_hold };
      }
      else if (!stateFilter) items.set(id, { id, task: { ...task, task_id: id, status: undefined }, saved: false, buckets: new Set([bucket]) });
    }
  }
  return { items, count, ignored, queueKnown, queueTime: text(queue.ts), queueReason: text(queue.reason) };
}

export class TaskInventory {
  readonly widget = column();
  private readonly scope = Gtk.DropDown.new_from_strings(scopes);
  private readonly filter = Gtk.DropDown.new_from_strings(filters.map(({ label }) => label));
  private readonly limit = Gtk.DropDown.new_from_strings(limits.map((value) => value ? `До ${value}` : "Все сохранённые"));
  private readonly custom = new Gtk.Entry({ placeholder_text: "Состояния через запятую", hexpand: true });
  private readonly search = new Gtk.SearchEntry({ placeholder_text: "Поиск в загруженных задачах", hexpand: true });
  private readonly currentProject = new Gtk.CheckButton({ label: "Текущий проект" });
  private readonly exact = button("Открыть по ID", () => this.openId());
  private readonly status = label("", "dim-label");
  private readonly model = new Gtk.StringList();
  private readonly list: any;
  private readonly factory: any;
  private readonly factorySignals: number[] = [];
  private readonly mounted = new Map<any, string>();
  private renderedIds: string[] = [];
  private snapshot?: Snapshot;
  private loadedQuery?: string;
  private read?: any;
  private readIssue = "";
  private disposed = false;
  private poll = 0;

  constructor(private readonly gateway: Gateway, private readonly room: () => Room,
    private readonly open: (id: string, task?: Task) => void,
    private readonly binding?: (task: string) => ProjectTarget | undefined) {
    const filtersRow = new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.NONE, row_spacing: 4, column_spacing: 6 });
    this.limit.set_selected(1);
    for (const control of [this.scope, this.filter, this.limit, button("Обновить", () => void this.refresh())]) {
      control.set_halign(Gtk.Align.FILL);
      filtersRow.append(control);
    }
    this.widget.append(filtersRow);
    this.widget.append(this.custom);
    const searchRow = row(5);
    searchRow.append(this.search);
    searchRow.append(this.exact);
    this.widget.append(searchRow);
    this.widget.append(this.currentProject);
    this.widget.append(this.status);
    const factory = this.factory = new Gtk.SignalListItemFactory();
    this.factorySignals.push(factory.connect("setup", (_factory: unknown, item: any) => {
      const content = column(2);
      content.set_margin_start(8);
      content.set_margin_end(8);
      content.set_margin_top(7);
      content.set_margin_bottom(7);
      const heading = label("", "heading");
      heading.set_lines(2);
      heading.set_ellipsize(Pango.EllipsizeMode.END);
      const details = label("", "dim-label");
      details.set_wrap_mode(Pango.WrapMode.WORD_CHAR);
      details.set_max_width_chars(64);
      content.append(heading);
      content.append(details);
      item.set_child(content);
    }));
    this.factorySignals.push(factory.connect("bind", (_factory: unknown, item: any) => {
      const id = item.get_item().get_string();
      this.mounted.set(item, id);
      this.updateItem(item, id);
    }));
    this.factorySignals.push(factory.connect("unbind", (_factory: unknown, item: any) => { this.mounted.delete(item); }));
    const list = this.list = new Gtk.ListView({ model: new Gtk.SingleSelection({ model: this.model, autoselect: false }),
      factory, single_click_activate: true });
    list.connect("activate", (_list: unknown, index: number) => {
      if (this.disposed || index >= this.model.get_n_items()) return;
      const id = this.model.get_string(index);
      const record = this.snapshot?.items.get(id);
      if (record) this.open(id, record.task);
    });
    this.widget.append(new Gtk.ScrolledWindow({ child: list, vexpand: true }));
    for (const control of [this.scope, this.filter, this.limit]) control.connect("notify::selected", () => {
      if (this.disposed) return;
      this.syncControls();
      void this.refresh();
    });
    this.custom.connect("activate", () => void this.refresh());
    this.search.connect("search-changed", () => this.render());
    this.currentProject.connect("toggled", () => this.render());
    this.syncControls();
    this.roomChanged();
  }

  setActive(active: boolean): void {
    if (this.poll) {
      GLib.Source.remove(this.poll);
      this.poll = 0;
    }
    if (!active || this.disposed) {
      this.read?.cancel();
      this.read = undefined;
      return;
    }
    void this.refresh();
    this.poll = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => {
      if (this.queueOnly() && !this.read) void this.refresh();
      return GLib.SOURCE_CONTINUE;
    });
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.setActive(false);
    this.list.set_model(null);
    for (const signal of this.factorySignals.splice(0)) this.factory.disconnect(signal);
    this.list.set_factory(null);
    this.mounted.clear();
    this.exact.set_sensitive(false);
    this.widget.set_sensitive(false);
  }

  roomChanged(): void {
    if (this.disposed) return;
    this.currentProject.set_visible(Boolean(this.room().projectId));
    this.render();
  }

  async refresh(): Promise<void> {
    if (this.disposed) return;
    const queueOnly = this.queueOnly();
    const selection = filters[this.filter.get_selected()];
    const custom = this.custom.get_text().split(",").map((word: string) => word.trim()).filter(Boolean);
    const status = queueOnly ? undefined : selection?.custom ? [...new Set(custom)].join(",") || undefined : selection?.value;
    const limit = limits[this.limit.get_selected()] ?? 100;
    const path = "/api/tasks" + query(queueOnly ? { queue_only: 1 } : { limit, status });
    this.read?.cancel();
    const cancel = new Gio.Cancellable();
    this.read = cancel;
    this.readIssue = "";
    if (this.loadedQuery !== path) {
      this.snapshot = undefined;
      this.render();
    }
    this.status.set_label(queueOnly ? "Читаю снимок очереди…" : "Читаю список задач…");
    try {
      const result = await this.gateway.json("GET", path, undefined, undefined, false, cancel);
      if (this.read !== cancel || this.disposed) return;
      this.snapshot = projectInventory(result, queueOnly, status);
      this.loadedQuery = path;
    } catch (error) {
      if (this.read !== cancel || this.disposed) return;
      this.readIssue = errorText(error);
    } finally {
      if (this.read === cancel && !this.disposed) {
        this.read = undefined;
        this.render();
      }
    }
  }

  private queueOnly(): boolean { return this.scope.get_selected() === 1; }

  private syncControls(): void {
    const archive = !this.queueOnly();
    this.filter.set_sensitive(archive);
    this.limit.set_sensitive(archive);
    this.custom.set_visible(archive && filters[this.filter.get_selected()]?.custom === true);
  }

  private openId(): void {
    if (this.disposed) return;
    const id = this.search.get_text().trim();
    if (taskId(id)) this.open(id, this.snapshot?.items.get(id)?.task);
  }

  private project(item: Item): ProjectTarget | undefined {
    return this.binding?.(item.id) ?? (text(item.task.project_id) ? { id: item.task.project_id! } : undefined);
  }

  private subtitle(item: Item): string {
    const task = item.task;
    const status = text(task.status);
    const project = this.project(item);
    const saved = task.admission_outcome === "never_admitted" ? notStarted : (Object.hasOwn(statusNames, status) ? statusNames[status] : status) || "Состояние не указано";
    return [item.saved ? saved : "Из снимка очереди", projectHoldCaption(task), cancellationCaption(task),
      item.buckets.has("running") && "Снимок · выполнялась",
      item.buckets.has("pending") && "Снимок · ожидала запуска",
      project?.name || project?.id, text(task.ts) || text(task.updated_at), item.id].filter(Boolean).join(" · ");
  }

  private updateItem(item: any, id: string): void {
    const record = this.snapshot?.items.get(id);
    const content = item.get_child();
    const heading = content.get_first_child();
    const details = content.get_last_child();
    const title = record ? taskTitle(record.task) : id;
    const subtitle = record ? this.subtitle(record) : id;
    if (heading.get_label() !== title) heading.set_label(title);
    if (details.get_label() !== subtitle) details.set_label(subtitle);
  }

  private updateModel(ids: string[]): void {
    const previous = this.renderedIds;
    let start = 0;
    let before = previous.length;
    let after = ids.length;
    while (start < before && start < after && previous[start] === ids[start]) start++;
    while (before > start && after > start && previous[before - 1] === ids[after - 1]) {
      before--;
      after--;
    }
    if (before !== start || after !== start) this.model.splice(start, before - start, ids.slice(start, after));
    this.renderedIds = ids;
    for (const [item, id] of this.mounted) this.updateItem(item, id);
  }

  private render(): void {
    if (this.disposed) return;
    const search = this.search.get_text().trim();
    this.exact.set_sensitive(taskId(search));
    const needle = fold(search);
    const project = this.currentProject.get_active() ? this.room().projectId : undefined;
    const snapshot = this.snapshot;
    const ids: string[] = [];
    for (const item of snapshot?.items.values() ?? []) {
      const destination = this.project(item);
      if (project && destination?.id !== project) continue;
      if (needle && ![item.id, taskTitle(item.task), text(item.task.description), destination?.id ?? "", destination?.name ?? ""]
        .some((part) => fold(part).includes(needle))) continue;
      ids.push(item.id);
    }
    this.updateModel(ids);
    const notes: string[] = [];
    if (this.readIssue) notes.push(this.readIssue);
    if (snapshot) {
      if (this.readIssue) notes.push("Показана предыдущая выдача.");
      else if (this.read) notes.push("Обновляю выдачу…");
      const queueOnly = this.queueOnly();
      if (!queueOnly) {
        const limit = limits[this.limit.get_selected()] ?? 100;
        notes.push(limit ? `Сохранённых записей · ${snapshot.count} · Лимит шлюза ${limit}`
          : `Сохранённых записей · ${snapshot.count}`);
        if (snapshot.ignored) notes.push(`Не удалось однозначно распознать записи · ${snapshot.ignored}`);
      }
      if (!snapshot.queueKnown) notes.push("Снимок очереди недоступен или неполон.");
      else notes.push([`Снимок очереди`, snapshot.queueTime || "Время не указано", snapshot.queueReason].filter(Boolean).join(" · "));
      notes.push(`Показано · ${ids.length} из ${snapshot.items.size}`);
    } else if (this.read && !this.readIssue) notes.push("Загрузка…");
    this.status.set_label(notes.join("\n"));
  }
}
