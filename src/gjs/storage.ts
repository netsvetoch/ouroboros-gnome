import { Gio, GLib, Gtk } from "./gi.js";
import { type Gateway, HttpError, query } from "./gateway.js";
import { button, clear, column, confirm, errorText, label, row, sheet } from "./ui.js";

interface Sized {
  bytes: number | null;
  bytes_complete?: boolean;
}

interface Part extends Sized {
  name: string;
  files?: number;
}

interface CountedPlace extends Sized {
  id: string;
  roots: string[];
  present: boolean;
  same_volume: boolean;
  files: number;
  unreadable: number;
  parts: Part[];
  rest?: { count: number; bytes: number };
  growth_bytes?: number | null;
  growth_flag?: string;
  undecided?: string;
}

interface DeletedFolder extends Sized {
  path: string;
  state: string;
  unreadable: number;
  counted_in: string | null;
  same_volume: boolean;
  projects: { name: string; deleted_at: string; provenance: string }[];
  active_projects: { name: string; relation: string }[];
  parts: Part[];
  rest?: { count: number; bytes: number };
  reason?: string;
  within?: string;
  holds?: string[];
}

interface Count extends Sized {
  started_at: string;
  finished_at: string;
  duration_seconds: number;
  io_priority: string;
  basis: string;
  files: number;
  unreadable: number;
  places: CountedPlace[];
  growth_bytes?: number | null;
  growth_since?: string;
  growth_flag?: string;
  deleted_projects?: { state: string; no_folder: number; folders: DeletedFolder[] };
}

interface Remover {
  id: string;
  state: string;
  at: string | null;
  last_error?: { class: string; at: string };
  compressed?: number;
  saved_bytes?: number | null;
  freed_bytes?: number;
  released?: number;
  holds?: { class: string; count: number; example: string; since: string }[];
  held?: number;
  held_since?: string;
  errors?: number;
  first_error?: string | null;
}

interface Reason {
  reason: string;
  count: number;
  causes?: { cause: string; count: number }[];
  manual_count?: number;
}

interface Group extends Sized {
  id: string;
  count: number;
  inside_wait: number;
  in_use: number;
  unreadable: number;
  items: Part[];
}

interface Free {
  state: string;
  plan: string | null;
  started_at: string | null;
  finished_at: string | null;
  done: number;
  total: number;
  groups: Group[];
  pool?: (Sized & {
    count: number;
    kinds: Record<string, number>;
    excluded: Reason[];
    manual: Sized & { count: number; retained: number };
  }) | null;
  run: {
    selected: number;
    done: number;
    removed: number;
    removed_bytes: number;
    deleting: number;
    deleting_bytes: number;
    stuck: number;
    failed?: number;
    not_started?: number;
    kept: Reason[];
    free_before: number | null;
    free_after: number | null;
    stopped: boolean;
    error: string | null;
    outcomes_ready?: boolean;
  } | null;
  error: string | null;
}

interface StorageState {
  count?: Count | null;
  counting: {
    started_at: string; place: string; current: string; places_done: number; places_total: number;
    bytes: number; files: number; done: Part[];
  } | null;
  volume: { free_bytes: number | null; total_bytes: number | null; observed_at: string };
  retention_days: number;
  removers: Record<string, Remover[]>;
  error: { at: string; message: string; stopped: boolean } | null;
  free: Free;
  started?: boolean;
  reason?: string;
}

interface Entry extends Sized {
  id: string;
  group: string;
  kind: string;
  name: string;
  path: string;
  task_id: string | null;
  eligible_after: string | null;
  reason: string | null;
  cause?: string;
  outcome: string | null;
  availability: string;
  manual?: {
    not_proven_saved_count: number;
    not_proven_saved_bytes: number;
    not_proven_saved: { path: string; bytes: number }[];
    omitted_count: number;
    keeps_commits: boolean;
    producer_retained?: boolean;
    loss?: string;
    paths?: string[];
  };
}

type View = "pool" | "excluded" | "manual" | "outcomes";
type Tab = View | "groups";

interface Items {
  plan: string;
  view: View;
  version: string;
  total: number;
  counts: Record<string, number>;
  next_cursor: number | null;
  items: Entry[];
}

const tabs: Record<Tab, string> = {
  pool: "Доступные", groups: "Группы", excluded: "Исключённые", manual: "Ручное удаление", outcomes: "Результаты",
};
const states: Record<string, string> = {
  idle: "Нет плана", listing: "Подготовка плана", ready: "План готов", running: "Очистка выполняется",
  done: "Очистка завершена", failed: "Ошибка", stopped: "Остановлено",
  removed: "Удалено", deleting: "Ожидает удаления", stuck: "Удаление задержалось", kept: "Сохранено",
  not_started: "Не начато", ordinary: "Можно выбрать отдельно", saved_group: "Можно выбрать целой группой",
  manual_discard: "Требуется ручное подтверждение", none: "Сейчас недоступно",
};
const places: Record<string, string> = {
  model_calls: "Вызовы моделей", engine: "Данные движка", task_results: "Результаты задач", archives: "Архивы",
  memory_skills: "Память и навыки", project_folders: "Папки проектов", deliverables: "Артефакты",
  work_folders: "Рабочие папки", working_copies: "Рабочие копии", app_state: "Состояние приложения",
  data_other: "Прочие данные", program: "Программа", deleted_projects: "Папки удалённых проектов",
  review_evidence: "Материалы ревью", review_checkouts: "Копии для ревью", lost_copies: "Неучтённые копии",
  service_folders: "Служебные папки", result_pins: "Закреплённые результаты",
};

const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const nonnegative = (value: unknown): boolean => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const sizedValue = (value: unknown): boolean => record(value) && (value.bytes === null || nonnegative(value.bytes))
  && (value.bytes_complete === undefined || typeof value.bytes_complete === "boolean");

/** Validate the complete page before making any object eligible for owner selection. */
function readItems(value: unknown, cursor: number, seen: Set<string>): Items {
  const fail = () => { throw new Error("Шлюз вернул неполную или противоречивую страницу объектов. Обновите список перед выбором."); };
  if (!record(value) || typeof value.plan !== "string" || !value.plan || typeof value.version !== "string" || !value.version
    || !["pool", "excluded", "manual", "outcomes"].includes(value.view) || !nonnegative(value.total)
    || !record(value.counts) || !Object.values(value.counts).every(nonnegative) || !Array.isArray(value.items)
    || value.items.length > 50 || cursor + value.items.length > value.total
    || (value.next_cursor !== null && (!nonnegative(value.next_cursor) || value.next_cursor <= cursor
      || value.next_cursor !== cursor + value.items.length || value.next_cursor >= value.total))
    || (value.next_cursor === null && cursor + value.items.length !== value.total)) return fail();
  const ids = new Set(seen);
  for (const entry of value.items) {
    if (!record(entry) || !sizedValue(entry) || typeof entry.id !== "string" || !entry.id || ids.has(entry.id)
      || ["group", "kind", "name", "path", "availability"].some(key => typeof entry[key] !== "string")
      || !["ordinary", "saved_group", "manual_discard", "none"].includes(entry.availability)
      || ["task_id", "eligible_after", "reason", "outcome"].some(key => entry[key] !== null && typeof entry[key] !== "string")
      || (entry.cause !== undefined && typeof entry.cause !== "string")) return fail();
    ids.add(entry.id);
    const manual = entry.manual;
    if (manual !== undefined && (!record(manual)
      || ["not_proven_saved_count", "not_proven_saved_bytes", "omitted_count"].some(key => !nonnegative(manual[key]))
      || typeof manual.keeps_commits !== "boolean" || !Array.isArray(manual.not_proven_saved)
      || manual.not_proven_saved.some((item: unknown) => !record(item) || typeof item.path !== "string" || !nonnegative(item.bytes))
      || (manual.producer_retained !== undefined && typeof manual.producer_retained !== "boolean")
      || (manual.loss !== undefined && typeof manual.loss !== "string")
      || (manual.paths !== undefined && (!Array.isArray(manual.paths) || manual.paths.some((item: unknown) => typeof item !== "string"))))) return fail();
    if (value.view === "manual" && entry.availability === "manual_discard" && !manual) return fail();
  }
  return value as unknown as Items;
}

function size(bytes: number | null | undefined): string {
  return bytes == null ? "размер неизвестен" : GLib.format_size(bytes);
}

function sized(value: Sized): string {
  return value.bytes != null && value.bytes_complete === false ? `не менее ${size(value.bytes)}` : size(value.bytes);
}

function breakdown(counts: Record<string, number>): string {
  return Object.entries(counts).map(([name, count]) => `${states[name] ?? name} · ${count}`).join(", ");
}

function detail(target: any, text: string): void {
  const widget = label(text);
  widget.set_selectable(true);
  target.append(widget);
}

function expander(target: any, title: string): any {
  const content = column(4);
  target.append(new Gtk.Expander({ label: title, child: content }));
  return content;
}

function parts(target: any, items: Part[], rest?: { count: number; bytes: number }): void {
  for (const part of items) detail(target, `${part.name} · ${sized(part)}${part.files == null ? "" : ` · файлов ${part.files}`}`);
  if (rest?.count) detail(target, `Прочие (${rest.count}) · ${size(rest.bytes)}`);
}

function reasons(target: any, items: Reason[]): void {
  for (const item of items) {
    const causes = item.causes?.map(({ cause, count }) => `${cause} · ${count}`).join(", ");
    detail(target, [`${item.reason} · ${item.count}`, causes, item.manual_count ? `вручную · ${item.manual_count}` : null]
      .filter(Boolean).join(" · "));
  }
}

function growth(bytes?: number | null, flag?: string, since?: string): string {
  if (bytes == null) return flag ? `Изменение неизвестно · ${flag}` : "";
  return `Изменение ${bytes >= 0 ? "+" : "−"}${size(Math.abs(bytes))}${since ? ` с ${since}` : ""}`;
}

function manualDetails(entry: Entry): string[] {
  const manual = entry.manual;
  if (!manual) return [];
  const lines = manual.producer_retained ? [manual.loss ?? "", ...(manual.paths ?? [])] : [
    `Сохранность не подтверждена для ${manual.not_proven_saved_count} путей · ${size(manual.not_proven_saved_bytes)}`,
    ...manual.not_proven_saved.map((item) => `${item.path} · ${size(item.bytes)}`),
    manual.omitted_count ? `Ещё путей · ${manual.omitted_count}` : "",
    manual.keeps_commits ? "Коммиты в ветке или закреплении сохраняются." : "",
  ];
  return lines.filter(Boolean);
}

export class Storage {
  private readonly content = column(12);
  private readonly dialog = sheet("Хранилище шлюза", this.content);
  private readonly status = label("", "dim-label");
  private readonly volume = label("");
  private readonly counting = label("");
  private readonly countDetails = column();
  private readonly freeSummary = column(4);
  private readonly listing = column();
  private readonly selection = label("", "dim-label");
  private readonly manualEntries = new Map<string, Entry>();
  private readonly tabControls = new Map<Tab, any>();
  private readonly refresh = button("Обновить", () => void this.load(true));
  private readonly measure = button("Измерить", () => void this.post("/measure"));
  private readonly stopMeasure = button("Остановить измерение", () => void this.post("/measure/cancel"));
  private readonly preview = button("Подготовить план", () => void this.post("/free/preview"));
  private readonly stopFree = button("Остановить", () => void this.stopCleanup());
  private readonly remove = button("Удалить выбранное", () => void this.cleanup());
  private readonly more = button("Ещё", () => void this.readItems());
  private readonly chosen = new Map<string, string>();
  private readonly checkboxes: any[] = [];
  private readonly itemIds = new Set<string>();
  private listingGeneration = 0;
  private state?: StorageState;
  private tab: Tab = "pool";
  private version?: string;
  private cursor: number | null = 0;
  private generation = 0;
  private poll = 0;
  private busy = false;
  private open = false;
  private countKey = "";
  private freeKey = "";
  private cancel?: any;

  constructor(private readonly parent: any, private readonly gateway: Gateway, private readonly openTask: (id: string) => void) {
    const measureBar = row();
    for (const widget of [this.refresh, this.measure, this.stopMeasure]) measureBar.append(widget);
    const freeBar = row();
    for (const widget of [this.preview, this.stopFree]) freeBar.append(widget);
    const tabsBar = new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.NONE, column_spacing: 6, row_spacing: 4 });
    for (const [tab, title] of Object.entries(tabs) as [Tab, string][]) {
      const control = button(title, () => void this.selectTab(tab));
      tabsBar.append(control);
      this.tabControls.set(tab, control);
    }
    this.remove.add_css_class("destructive-action");
    const actions = row();
    for (const widget of [this.more, this.remove]) actions.append(widget);
    for (const widget of [
      this.status, label("Измерение", "title-3"), this.volume, measureBar, this.counting, this.countDetails,
      label("Очистка", "title-3"), freeBar, this.freeSummary, tabsBar, this.listing, this.selection, actions,
    ]) this.content.append(widget);
    this.dialog.connect("closed", () => {
      this.open = false;
      this.generation++;
      this.cancel?.cancel();
      if (this.poll) GLib.Source.remove(this.poll);
      this.poll = 0;
      this.busy = false;
      this.chosen.clear();
      this.controls();
    });
  }

  show(): void {
    if (this.open) return;
    this.open = true;
    this.cancel = new Gio.Cancellable();
    this.busy = false;
    this.state = undefined;
    this.countKey = "";
    this.freeKey = "";
    this.tab = "pool";
    this.volume.set_label("");
    this.counting.set_label("");
    clear(this.countDetails);
    clear(this.freeSummary);
    this.resetListing();
    this.controls();
    this.status.set_label("Загрузка…");
    this.dialog.present(this.parent);
    this.poll = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
      void this.load();
      return GLib.SOURCE_CONTINUE;
    });
    void this.load(true);
  }

  close(): void {
    if (this.open) this.dialog.close();
  }

  private selectionSummary(): string[] {
    if (!this.chosen.size) return [];
    const lines = [`Выбрано объектов · ${this.chosen.size}`];
    if (this.tab !== "manual") return lines;
    const offers = [...this.chosen.keys()].map(id => this.manualEntries.get(id)?.manual).filter(value => value !== undefined);
    const copies = offers.filter(value => !value.producer_retained);
    if (copies.length) lines.push(`Сохранность не подтверждена для ${copies.reduce((sum, value) => sum + value.not_proven_saved_count, 0)} путей · ${size(copies.reduce((sum, value) => sum + value.not_proven_saved_bytes, 0))}`);
    const retained = offers.filter(value => value.producer_retained);
    if (retained.length) lines.push(`Рабочих областей, сохранённых производителем · ${retained.length}`);
    if (copies.some(value => value.keeps_commits)) lines.push("Коммиты в ветке или закреплении сохраняются.");
    return lines;
  }

  private controls(): void {
    this.selection.set_label(this.selectionSummary().join("\n"));
    const free = this.state?.free;
    const ready = this.open && free?.state === "ready";
    const idle = this.open && !this.busy;
    const plan = Boolean(free?.plan && free.state !== "listing");
    this.refresh.set_sensitive(idle);
    this.measure.set_sensitive(Boolean(this.state && idle && !this.state.counting));
    this.stopMeasure.set_visible(Boolean(this.state?.counting));
    this.stopMeasure.set_sensitive(idle);
    this.preview.set_sensitive(Boolean(free && idle && !["listing", "running"].includes(free.state)));
    this.stopFree.set_visible(free?.state === "listing" || free?.state === "running");
    this.stopFree.set_sensitive(idle);
    for (const [tab, control] of this.tabControls) {
      control.set_visible(tab === "outcomes" ? Boolean(free?.run?.outcomes_ready) : plan);
      control.set_sensitive(idle && tab !== this.tab);
    }
    this.more.set_visible(this.tab !== "groups" && this.version !== undefined && this.cursor != null);
    this.more.set_sensitive(idle);
    this.remove.set_visible(ready && ["pool", "groups", "manual"].includes(this.tab));
    this.remove.set_sensitive(idle && this.chosen.size > 0);
    for (const checkbox of this.checkboxes) checkbox.set_sensitive(ready && idle);
  }

  private async request(work: (current: () => boolean) => Promise<void>): Promise<void> {
    if (this.busy || !this.open) return;
    const generation = this.generation;
    const current = () => this.open && this.generation === generation;
    this.busy = true;
    this.controls();
    try {
      await work(current);
    } catch (error) {
      if (current()) {
        this.state = undefined;
        this.resetListing();
        this.status.set_label(errorText(error));
      }
    } finally {
      if (current()) {
        this.busy = false;
        this.controls();
      }
    }
  }

  private async load(explicit = false): Promise<void> {
    await this.request(async (current) => {
      const state = await this.gateway.json<StorageState>("GET", "/api/storage", undefined, {}, false, this.cancel);
      if (!current()) return;
      const changed = this.render(state);
      if (explicit) this.status.set_label("");
      if (explicit && this.tab === "outcomes") this.resetListing();
      if (changed || (explicit && this.cursor === 0 && !this.version)) await this.loadPage(current);
    });
  }

  private async post(path: string, body?: object): Promise<void> {
    await this.request((current) => this.send(path, current, body));
  }

  private async send(path: string, current: () => boolean, body?: object): Promise<void> {
    let state;
    try {
      state = await this.gateway.json<StorageState>("POST", `/api/storage${path}`, body, {}, false, this.cancel);
    } catch (error) {
      if (current()) {
        this.state = undefined;
        this.resetListing();
        this.status.set_label(`Ответ на действие не получен. Обновите состояние перед повтором. ${errorText(error)}`);
      }
      return;
    }
    if (!current()) return;
    const changed = this.render(state);
    this.status.set_label(state.started === false && state.reason ? `Шлюз отклонил действие · ${state.reason}` : "");
    if (changed) await this.loadPage(current);
  }

  private render(state: StorageState): boolean {
    if (!state?.volume || !state.free || !Array.isArray(state.free.groups)
      || !["idle", "listing", "ready", "running", "done", "failed", "stopped"].includes(state.free.state)) {
      throw new Error("Шлюз не вернул пригодное состояние хранилища.");
    }
    const old = this.state?.free;
    const free = state.free;
    const changed = old?.plan !== free.plan || old?.state !== free.state
      || old?.run?.outcomes_ready !== free.run?.outcomes_ready;
    this.state = state;
    if (changed) {
      if (free.run?.outcomes_ready && !old?.run?.outcomes_ready) this.tab = "outcomes";
      else if (this.tab === "outcomes" && !free.run?.outcomes_ready) this.tab = "pool";
      this.resetListing();
    }
    const volume = state.volume;
    this.volume.set_label(`Диск данных · свободно ${size(volume.free_bytes)} из ${size(volume.total_bytes)} · ${volume.observed_at}`);
    const counting = state.counting;
    this.counting.set_label(counting ? [
      `Измерение с ${counting.started_at} · ${counting.places_done}/${counting.places_total} · ${size(counting.bytes)} · файлов ${counting.files}`,
      places[counting.place] ?? counting.place, counting.current,
      counting.done.map((item) => `${places[item.name] ?? item.name} · ${sized(item)}`).join(", "),
    ].filter(Boolean).join("\n") : "");
    this.renderCount(state);
    this.renderFree(free, state.retention_days);
    return changed;
  }

  private renderCount({ count, error, removers }: StorageState): void {
    const key = JSON.stringify([count?.finished_at, error, removers]);
    if (key === this.countKey) return;
    this.countKey = key;
    clear(this.countDetails);
    if (error) detail(this.countDetails, `${error.stopped ? "Измерение остановлено" : "Ошибка измерения"} · ${error.at} · ${error.message}`);
    if (count) {
      const basis = count.basis === "allocated" ? "на диске" : count.basis === "logical" ? "логический размер" : count.basis;
      const saved = expander(this.countDetails, `Последнее измерение · ${count.finished_at} · ${sized(count)}`);
      detail(saved, [basis, `файлов ${count.files}`, `не прочитано ${count.unreadable}`, `${count.duration_seconds} с`, count.io_priority,
        growth(count.growth_bytes, count.growth_flag, count.growth_since)].filter(Boolean).join(" · "));
      for (const place of count.places) {
        const caption = place.undecided ? "путь неизвестен" : place.present ? sized(place) : "отсутствует";
        const content = expander(saved, `${places[place.id] ?? place.id} · ${caption}`);
        for (const root of place.roots) detail(content, root);
        detail(content, [`файлов ${place.files}`, `не прочитано ${place.unreadable}`, place.present && !place.same_volume ? "другой диск" : "",
          growth(place.growth_bytes, place.growth_flag), place.undecided].filter(Boolean).join(" · "));
        parts(content, place.parts, place.rest);
      }
      const deleted = count.deleted_projects;
      if (deleted) {
        const folders = expander(saved, "Папки удалённых проектов");
        detail(folders, `${deleted.state} · проектов без записанной папки ${deleted.no_folder}`);
        for (const folder of deleted.folders) {
          const item = expander(folders, `${folder.path} · ${folder.state} · ${folder.state === "partial" ? "не менее " : ""}${sized(folder)}`);
          detail(item, [`не прочитано ${folder.unreadable}`, folder.reason,
            folder.counted_in && `включено в ${places[folder.counted_in] ?? folder.counted_in}`,
            folder.within && `внутри ${folder.within}`, folder.holds?.join(", "), folder.same_volume ? "" : "другой диск"].filter(Boolean).join(" · "));
          for (const project of folder.projects) detail(item, [project.name, project.deleted_at, project.provenance].filter(Boolean).join(" · "));
          for (const project of folder.active_projects) detail(item, `Существующий проект · ${project.name} · ${project.relation}`);
          parts(item, folder.parts, folder.rest);
        }
      } else detail(saved, "Сведения о папках удалённых проектов отсутствуют.");
    } else detail(this.countDetails, "Завершённого измерения пока нет.");
    if (Object.keys(removers).length) {
      const jobs = expander(this.countDetails, "Обслуживание хранилища");
      for (const [place, entries] of Object.entries(removers)) {
        const content = expander(jobs, places[place] ?? place);
        for (const job of entries) {
          detail(content, [job.id, states[job.state] ?? job.state, job.at,
            job.last_error && `${job.last_error.class} · ${job.last_error.at}`, job.first_error,
            job.released == null ? "" : `освобождено объектов ${job.released}`,
            job.compressed == null ? "" : `сжато файлов ${job.compressed}`,
            job.saved_bytes === undefined ? "" : `сжатием сэкономлено · ${size(job.saved_bytes)}`,
            job.freed_bytes == null ? "" : `освобождено ${size(job.freed_bytes)}`,
            job.held == null ? "" : `удерживается ${job.held}`, job.held_since,
            job.errors == null ? "" : `ошибок ${job.errors}`].filter(Boolean).join(" · "));
          for (const hold of job.holds ?? []) detail(content, [hold.class, hold.count, hold.since, hold.example].join(" · "));
        }
      }
    }
  }

  private renderFree(free: Free, retention: number): void {
    const key = JSON.stringify([free, retention]);
    if (this.freeKey === key) return;
    this.freeKey = key;
    clear(this.freeSummary);
    detail(this.freeSummary, [states[free.state] ?? free.state, free.total ? `${free.done}/${free.total}` : "",
      free.finished_at ?? free.started_at, `срок хранения · ${retention} дн.`, free.error].filter(Boolean).join(" · "));
    if (free.pool) {
      const pool = free.pool;
      detail(this.freeSummary, `Доступно объектов · ${pool.count} · ${sized(pool)}`);
      if (Object.keys(pool.kinds).length) detail(this.freeSummary, breakdown(pool.kinds));
      if (pool.excluded.length) reasons(expander(this.freeSummary, "Причины исключений"), pool.excluded);
      detail(this.freeSummary, `Ручное удаление · ${pool.manual.count} · ${sized(pool.manual)} · сохранённых рабочих областей ${pool.manual.retained}`);
    }
    if (free.run) {
      const run = free.run;
      detail(this.freeSummary, `Обработано ${run.done}/${run.selected} · удалено ${run.removed} (${size(run.removed_bytes)}) · ожидает удаления ${run.deleting} (${size(run.deleting_bytes)}) · задержалось ${run.stuck}`);
      detail(this.freeSummary, [
        run.failed == null ? "" : `ошибок ${run.failed}`, run.not_started == null ? "" : `не начато ${run.not_started}`,
        run.stopped ? "Остановлено" : "", run.error, `Свободно до · ${size(run.free_before)}`, `после · ${size(run.free_after)}`,
      ].filter(Boolean).join(" · "));
      if (run.kept.length) reasons(expander(this.freeSummary, "Что осталось"), run.kept);
    }
  }

  private resetListing(): void {
    this.listingGeneration++;
    this.itemIds.clear();
    this.manualEntries.clear();
    clear(this.listing);
    this.listing.append(label(tabs[this.tab], "title-4"));
    this.chosen.clear();
    this.checkboxes.length = 0;
    this.cursor = 0;
    this.version = undefined;
  }

  private async selectTab(tab: Tab): Promise<void> {
    await this.request(async (current) => {
      this.tab = tab;
      this.resetListing();
      await this.loadPage(current);
    });
  }

  private async readItems(): Promise<void> {
    await this.request((current) => this.loadPage(current));
  }

  private async loadPage(current: () => boolean): Promise<void> {
    const free = this.state?.free;
    if (!free?.plan || free.state === "listing" || this.cursor == null) return;
    if (this.tab === "groups") {
      for (const group of free.groups) {
        const title = `${places[group.id] ?? group.id} · ${group.count} · ${sized(group)}`;
        if (free.state === "ready" && group.count > 0) this.checkbox(this.listing, group.id, title);
        else detail(this.listing, title);
        const info = expander(this.listing, "Состав группы");
        detail(info, `Моложе срока хранения · ${group.inside_wait} · удерживается ${group.in_use} · не прочитано ${group.unreadable}`);
        parts(info, group.items);
      }
      this.cursor = null;
      return;
    }
    const { plan } = free;
    const view = this.tab;
    const version = this.version;
    const cursor = this.cursor;
    let page: Items;
    try {
      const value = await this.gateway.json<unknown>("GET", `/api/storage/free/items${query({ plan, view, cursor: this.cursor, limit: 50, version })}`, undefined, {}, false, this.cancel);
      if (!current()) return;
      page = readItems(value, cursor, this.itemIds);
    } catch (error) {
      if (!current()) return;
      if (!(error instanceof HttpError) || error.status !== 409) throw error;
      this.resetListing();
      if (error.reason === "view_changed" && version) {
        await this.loadPage(current);
      } else {
        const latest = await this.gateway.json<StorageState>("GET", "/api/storage", undefined, {}, false, this.cancel);
        if (current()) {
          this.render(latest);
          this.status.set_label(`Список изменился · ${error.reason ?? errorText(error)}. Обновите список перед выбором.`);
        }
      }
      return;
    }
    if (!current()) return;
    if (page.plan !== plan || page.view !== view || (version !== undefined && page.version !== version)) {
      this.resetListing();
      throw new Error("Шлюз вернул другую версию списка. Обновите список перед выбором.");
    }
    if (!version) detail(this.listing, [`Всего · ${page.total}`, breakdown(page.counts)].filter(Boolean).join(" · "));
    this.version = page.version;
    this.cursor = page.next_cursor;
    for (const entry of page.items) {
      this.itemIds.add(entry.id);
      this.entry(entry, view, free.state === "ready");
    }
  }

  private checkbox(target: any, id: string, name: string): void {
    const control = new Gtk.CheckButton({ child: label(name), active: this.chosen.has(id) });
    const generation = this.listingGeneration;
    control.connect("toggled", () => {
      if (!this.open || generation !== this.listingGeneration || this.busy || this.state?.free.state !== "ready") return;
      if (control.get_active()) this.chosen.set(id, name);
      else this.chosen.delete(id);
      this.controls();
    });
    target.append(control);
    this.checkboxes.push(control);
  }

  private entry(entry: Entry, view: View, ready: boolean): void {
    if (view === "manual" && entry.manual) this.manualEntries.set(entry.id, entry);
    const title = `${entry.name} · ${sized(entry)}`;
    const loss = view === "manual" && entry.manual
      ? entry.manual.producer_retained
        ? entry.manual.loss ?? "Сохранённая рабочая область сеанса"
        : `сохранность не подтверждена для ${entry.manual.not_proven_saved_count} путей (${size(entry.manual.not_proven_saved_bytes)})`
      : "";
    const selectable = ready && ((view === "pool" && entry.availability === "ordinary")
      || (view === "manual" && entry.availability === "manual_discard" && entry.manual));
    if (selectable) this.checkbox(this.listing, entry.id, [title, entry.path, loss].filter(Boolean).join(" · "));
    else detail(this.listing, title);
    const content = expander(this.listing, "Сведения об объекте");
    detail(content, entry.path);
    detail(content, [entry.kind, places[entry.group] ?? entry.group, states[entry.availability] ?? entry.availability,
      entry.outcome && (states[entry.outcome] ?? entry.outcome), entry.reason, entry.cause,
      entry.eligible_after && `Возможна фоновая очистка с ${entry.eligible_after}`].filter(Boolean).join(" · "));
    for (const line of manualDetails(entry)) detail(content, line);
    const generation = this.listingGeneration;
    if (entry.task_id) content.append(button(`Задача ${entry.task_id}`, () => {
      if (!this.open || generation !== this.listingGeneration) return;
      this.close();
      this.openTask(entry.task_id!);
    }));
  }

  private async cleanup(): Promise<void> {
    await this.request(async (current) => {
      const free = this.state?.free;
      const tab = this.tab;
      if (free?.state !== "ready" || !free.plan || !this.chosen.size || !["pool", "groups", "manual"].includes(tab)) return;
      const ids = [...this.chosen.keys()];
      const names = [...this.chosen.values()].slice(0, 8);
      if (ids.length > names.length) names.push(`Ещё · ${ids.length - names.length}`);
      const manual = tab === "manual";
      const warning = manual
        ? "Выбранные папки будут удалены целиком. Файлы, сохранность которых не подтверждена, могут быть потеряны."
        : tab === "groups" ? "Шлюз обработает все объекты выбранных групп из этого плана." : "Шлюз обработает только выбранные объекты из этого плана.";
      if (!await confirm(this.dialog, `Удалить выбранное (${ids.length})?`, [warning, ...(manual ? this.selectionSummary() : []), ...names].join("\n"), "Начать очистку", this.cancel)
        || !current()) return;
      const plan = free.plan;
      const selection = manual ? { manual: ids, accept_loss: true } : tab === "groups" ? { groups: ids } : { items: ids };
      await this.send("/free", current, { plan, ...selection });
    });
  }

  private async stopCleanup(): Promise<void> {
    await this.request(async (current) => {
      const running = this.state?.free.state === "running";
      if (running && (!await confirm(this.dialog, "Остановить очистку?", "Уже удалённые объекты останутся удалёнными.", "Остановить", this.cancel)
        || !current())) return;
      await this.send("/free/cancel", current);
    });
  }
}
