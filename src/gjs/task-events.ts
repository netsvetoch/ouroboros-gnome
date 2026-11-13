import { SpokenReceiptView } from "./spoken-receipt.js";
import { checkpointData, checkpointLabel, TaskCheckpointsView } from "./task-checkpoints.js";
import { watchNativeI18n } from "./native-i18n.js";
import { type Gateway, HttpError, query } from "./gateway.js";
import { Gio, GLib, Gtk } from "./gi.js";
import { object } from "./settings-write.js";
import { renderEventDelivery, taskEventDelivery } from "./task-event-delivery.js";
import { taskLifecycleLabel, taskLifecycleTerminal, taskSynthesisOpen } from "./task-outcome.js";
import { actionRow, button, clear, column, errorText, label, row, sheet } from "./ui.js";

type Document = Record<string, unknown>;
interface Cursor extends Document {
  v: 2;
  seq: number;
  view: string;
  positions: Record<string, Record<string, number>>;
}
interface Entry { event: Document; source: string; heading: string; text: string; size: number; epoch: number }

const sources = new Map([
  ["", "Все источники"], ["progress", "Ход работы"], ["chat", "Чат"], ["events", "События"],
  ["tools", "Инструменты"], ["supervisor", "Супервизор"], ["task_result", "Снимок задачи"],
]);
const sourceIds = [...sources.keys()];
const pendingArtifacts = new Set(["pending", "finalizing"]);
const text = (value: unknown): string => typeof value === "string" ? value : "";
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isObject = (value: unknown): boolean => Boolean(value && typeof value === "object" && !Array.isArray(value));

function eventCursor(value: unknown): Cursor | undefined {
  const cursor = object(value);
  if (cursor.v !== 2 || !integer(cursor.seq) || !/^[a-f0-9]{64}$/u.test(text(cursor.view)) || !isObject(cursor.positions)) return undefined;
  const positions = Object.entries(object(cursor.positions));
  if (!positions.length || positions.some(([root, offsets]) => !root || !isObject(offsets)
    || !Object.keys(object(offsets)).length || Object.values(object(offsets)).some((offset) => !integer(offset)))) return undefined;
  return cursor as Cursor;
}

function gapText(reason: string): string {
  return ({
    still_importing: "Архив ещё переносится в хранилище",
    segment_unimportable: "Часть архива недоступна для чтения",
    invalid_archive_line: "В архиве пропущена повреждённая запись",
    invalid_jsonl_line: "В журнале пропущена повреждённая запись",
    lineage_incomplete: "Не удалось полностью прочитать связи с подзадачами",
  } as Record<string, string>)[reason] || "Шлюз сообщил о пропуске";
}

function eventText(event: Document): string {
  const data = object(event.data);
  const checkpoint = checkpointData(event);
  if (checkpoint) return checkpointLabel(checkpoint);
  if (event.type === "history_gap") return [gapText(text(event.reason)), event.reason, event.root].filter(Boolean).join(" · ");
  return [text(data.tool) || text(data.tool_name), [data.content, data.text, data.message, data.error, data.result].map(text).find(Boolean),
    data.status, data.reason_code].filter((value) => typeof value === "string" && value).join(" · ");
}

function preparingArtifacts(data: Document): boolean {
  return [data.artifact_status, object(data.artifact_bundle).status, object(object(data.outcome_axes).artifacts).status]
    .some(status => pendingArtifacts.has(text(status)));
}

export class TaskEvents {
  readonly widget = new Gtk.Expander({ label: "События выполнения" });
  private readonly status = label("", "dim-label");
  private readonly notices = label("", "dim-label");
  private readonly snapshotLabel = label("", "dim-label");
  private readonly snapshotButton = button("Открыть снимок задачи…", () => {
    if (this.snapshot) this.open(this.snapshot, "Снимок задачи");
  });
  private readonly list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE });
  private readonly checkpoints = new TaskCheckpointsView((event, title) => this.open(event, title));
  private readonly unwatch: () => void;
  private readonly deliveries = column(6);
  private readonly deliveryPanel = new Gtk.Expander({ label: "Сведения о доставке", child: this.deliveries, visible: false });
  private readonly filter = Gtk.DropDown.new_from_strings([...sources.values()]);
  private readonly readButton = button("Прочитать события", () => void this.read(false));
  private readonly followButton = button("Следить за событиями", () => void this.read(true));
  private readonly stopButton = button("Остановить чтение", () => this.stop());
  private readonly restartButton = button("Перечитать доступный журнал", () => this.restart());
  private readonly entries: Entry[] = [];
  private readonly mounted = new Map<Entry, any>();
  private readonly seen = new Set<string>();
  private readonly gaps = new Map<string, string>();
  private readonly deliveryRecords = new Map<string, NonNullable<ReturnType<typeof taskEventDelivery>>>();
  private deliveriesChanged = false;
  private deliveriesTrimmed = false;
  private snapshot?: Document;
  private viewer?: any;
  private cursor: Cursor | null = null;
  private rank = 0;
  private legacy = false;
  private consumed = false;
  private disposed = false;
  private run?: any;
  private resumeFollow?: () => void;
  private opened = false;
  private cursorUnavailable = false;
  private renderTimer = 0;
  private size = 0;
  private dropped = 0;
  private epoch = 0;
  private replayed = false;
  private final = false;
  private renderedFilter?: string;

  constructor(private readonly parent: any, private readonly gateway: Gateway, private readonly task: string,
    private readonly refreshTask: () => void, private readonly observe?: (event: Document) => void) {
    const body = column(5);
    this.list.add_css_class("boxed-list");
    const actions = new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.NONE, row_spacing: 4, column_spacing: 6 });
    for (const button of [this.readButton, this.followButton, this.stopButton, this.restartButton]) actions.append(button);
    const filter = row();
    filter.append(label("Источник"));
    filter.append(this.filter);
    const snapshot = row();
    snapshot.append(this.snapshotLabel);
    snapshot.append(this.snapshotButton);
    for (const child of [actions, this.status, this.notices, snapshot, this.deliveryPanel, this.checkpoints.widget, filter,
      new Gtk.ScrolledWindow({ child: this.list, min_content_height: 150, max_content_height: 350, propagate_natural_height: true })]) body.append(child);
    this.filter.connect("notify::selected", () => this.render());
    this.widget.set_child(body);
    this.widget.connect("notify::expanded", () => {
      if (!this.widget.get_expanded()) this.stop();
      else if (!this.opened) void this.read(false);
    });
    this.unwatch = watchNativeI18n(() => { if (!this.disposed) this.render(); });
    this.sync();
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unwatch();this.checkpoints.close();
    this.stop();
    if (this.renderTimer) GLib.Source.remove(this.renderTimer);
    this.viewer?.force_close();
  }

  showHistory(): void {
    this.widget.set_expanded(true);
    void this.read(false);
  }

  private stop(): void {
    this.run?.cancel();
    this.resumeFollow?.();
  }

  private delayFollow(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        this.resumeFollow = undefined;
        resolve();
        return GLib.SOURCE_REMOVE;
      });
      this.resumeFollow = () => {
        GLib.Source.remove(timer);
        this.resumeFollow = undefined;
        resolve();
      };
    });
  }

  private restart(): void {
    if (this.run || this.disposed || (!this.cursorUnavailable && !this.legacy)) return;
    this.epoch++;
    this.cursor = null;
    this.rank = 0;
    this.seen.clear();
    this.final = this.cursorUnavailable = false;
    void this.read(false);
  }

  private async read(follow: boolean): Promise<void> {
    if (this.run || this.disposed) return;
    this.opened = true;
    const cancel = new Gio.Cancellable();
    this.run = cancel;
    this.status.set_label(follow ? "Слежу за событиями…" : "Читаю события…");
    this.sync();
    try {
      do {
        const start = GLib.get_monotonic_time();
        await this.readPass(follow ? 15 : 0, cancel);
        if (cancel.is_cancelled()) break;
        this.cursorUnavailable = false;
        this.refreshTask();
        if (!follow || this.final) break;
        // The gateway can close a stream at a terminal lifecycle while the
        // final result still needs synthesis or file preparation.
        if (taskLifecycleTerminal(object(this.snapshot?.data).status)) await this.delayFollow(3000);
        else if (GLib.get_monotonic_time() - start < 1_000_000) await this.delayFollow(1000);
      } while (!cancel.is_cancelled());
      if (!this.disposed) this.status.set_label(cancel.is_cancelled() ? "Чтение остановлено. Позиция сохранена в этом окне."
        : this.final ? "Шлюз прислал итоговый снимок." : "Текущая порция журнала прочитана.");
    } catch (error) {
      if (!this.disposed) this.status.set_label(cancel.is_cancelled() ? "Чтение остановлено. Позиция сохранена в этом окне."
        : this.cursorUnavailable ? `Шлюз не может продолжить с этой позиции. ${errorText(error)}` : errorText(error));
    } finally {
      this.run = undefined;
      if (!this.disposed) {
        if (this.renderTimer) {
          GLib.Source.remove(this.renderTimer);
          this.renderTimer = 0;
        }
        this.render();
        this.sync();
      }
    }
  }

  private async readPass(wait: number, cancel: any): Promise<void> {
    const path = `/api/tasks/${encodeURIComponent(this.task)}/events`;
    let ending = false;
    const consume = (raw: unknown) => {
      const event = object(raw);
      this.consumed = true;
      if (cancel.is_cancelled()) return;
      if (event.type === "error") {
        if (event.task_id === this.task && event.reason === "cursor_unavailable") this.cursorUnavailable = true;
        throw new Error(text(event.error) || "Шлюз сообщил об ошибке чтения событий.");
      }
      const type = text(event.type);
      if (!type || !integer(event.seq) || (["task_result", "cursor_replay", "cursor_checkpoint", "history_gap"].includes(type)
        && event.task_id !== this.task)) throw new Error("Шлюз вернул событие без подтверждённого адреса.");
      const next = this.legacy ? undefined : eventCursor(event.cursor);
      if (!this.legacy && (!next || next.seq !== event.seq || next.seq < (this.cursor?.seq ?? 0)
        || (this.cursor && next.view !== this.cursor.view && type !== "cursor_replay"))) {
        throw new Error("Шлюз вернул непригодную позицию в журнале.");
      }
      if (!this.legacy && !["task_result", "cursor_replay", "cursor_checkpoint", "history_gap"].includes(type)
        && !text(event.event_id)) throw new Error("В событии отсутствует идентификатор записи журнала.");
      if (type === "cursor_replay") this.replayed = true;
      else if (type === "cursor_checkpoint") ending = true;
      else if (type === "task_result") {
        const data = object(event.data);
        const terminal = taskLifecycleTerminal(data.status);
        this.snapshot = event;
        this.final = terminal && !taskSynthesisOpen(data) && !preparingArtifacts(data);
        ending ||= terminal;
      } else this.append(event, this.legacy ? `rank:${event.seq}` : text(event.event_id));
      if (next) this.cursor = next;
      else this.rank = Math.max(this.rank, event.seq);
      this.observe?.(event);
      this.scheduleRender();
    };
    const legacy = () => this.gateway.listenEvents(path + query({ wait, cursor: this.rank }), cancel, (raw) => consume(JSON.parse(raw)));
    if (this.legacy) return legacy();
    try {
      await this.gateway.events(path, { v: 2, wait, cursor: this.cursor }, cancel, consume);
      if (!ending && !cancel.is_cancelled()) throw new Error("Поток завершился без контрольной позиции. Можно повторить чтение.");
    } catch (error) {
      if (this.consumed || !(error instanceof HttpError) || error.status !== 405 || cancel.is_cancelled()) throw error;
      this.legacy = true;
      await legacy();
    }
  }

  private append(event: Document, id: string): void {
    const source = text(event.source);
    const kind = text(event.type);
    const gap = kind === "history_gap";
    if (gap) {
      const key = JSON.stringify([this.epoch, source, event.root, event.reason, id]);
      if (this.gaps.has(key)) return;
      this.gaps.set(key, gapText(text(event.reason)));
      if (this.gaps.size > 250) this.gaps.delete(this.gaps.keys().next().value!);
    } else if (id) {
      if (this.seen.has(id)) return;
      this.seen.add(id);
      if (this.seen.size > 4096) this.seen.delete(this.seen.keys().next().value!);
    }
    const delivery = taskEventDelivery(event);
    if (delivery) {
      this.deliveryRecords.delete(delivery.key);
      this.deliveryRecords.set(delivery.key, delivery);
      if (this.deliveryRecords.size > 64) {
        this.deliveryRecords.delete(this.deliveryRecords.keys().next().value!);
        this.deliveriesTrimmed = true;
      }
      this.deliveriesChanged = true;
    }
    const heading = [text(event.ts), sources.get(source) || source, gap ? "Пропуск" : delivery?.title || kind,
      text(event.task_id)].filter(Boolean).join(" · ");
    const size = JSON.stringify(event).length;
    const words = eventText(event);
    this.entries.push({ event, source, heading, text: words.length > 240 ? words.slice(0, 240) + "…" : words, size, epoch: this.epoch });
    this.size += size;
    while (this.entries.length > 250 || (this.entries.length > 1 && this.size > 2_000_000)) {
      this.size -= this.entries.shift()!.size;
      this.dropped++;
    }
  }

  private scheduleRender(): void {
    if (this.renderTimer) return;
    this.renderTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
      this.renderTimer = 0;
      if (!this.disposed) this.render();
      return GLib.SOURCE_REMOVE;
    });
  }

  private render(): void {
    if (this.deliveriesChanged) {
      this.deliveriesChanged = false;
      clear(this.deliveries);
      for (const delivery of [...this.deliveryRecords.values()].sort((a, b) => b.at.localeCompare(a.at))) {
        const item = column(3);
        renderEventDelivery(item, delivery);
        this.deliveries.append(item);
      }
      if (this.deliveriesTrimmed) this.deliveries.append(label("Часть записей о доставке за пределами окна.", "dim-label"));
      this.deliveryPanel.set_visible(this.deliveryRecords.size > 0);
    }
    const filter = sourceIds[this.filter.get_selected()];
    if (filter !== this.renderedFilter) {
      this.renderedFilter = filter;
      clear(this.list);
      this.mounted.clear();
    }
    const visible = this.entries.filter((entry) => !filter || entry.source === filter);
    this.checkpoints.update(visible, this.epoch, this.dropped > 0);
    const retained = new Set(visible);
    for (const [entry, item] of this.mounted) {
      if (retained.has(entry)) continue;
      this.list.remove(item);
      this.mounted.delete(entry);
    }
    for (const entry of visible) {
      if (checkpointData(entry.event)) entry.text = eventText(entry.event);
      const subtitle = [entry.epoch < this.epoch ? "Предыдущее чтение" : "", entry.text].filter(Boolean).join(" · ");
      const existing = this.mounted.get(entry);
      if (existing) {
        if (existing.get_subtitle() !== subtitle) existing.set_subtitle(subtitle);
        continue;
      }
      const item = actionRow({ title: entry.heading, subtitle, use_markup: false });
      item.set_subtitle_lines(2);
      const open = button("Открыть…", () => this.open(entry.event, entry.heading));
      open.set_valign(Gtk.Align.CENTER);
      item.add_suffix(open);
      item.set_activatable_widget(open);
      this.list.append(item);
      this.mounted.set(entry, item);
    }
    const gaps = [...new Set(this.gaps.values())];
    this.notices.set_label([
      this.legacy && "Шлюз поддерживает чтение по порядковым номерам. Поздние записи могут менять порядок: возможны повторы и пропуски при продолжении. Перечитайте доступный журнал, чтобы увидеть его текущий состав.",
      this.replayed && "Область журнала изменилась. Шлюз начал повторное чтение.",
      gaps.length && `Отмеченные пропуски · ${gaps.join(" · ")}`,
      this.dropped && `За пределами окна · ${this.dropped}`,
      this.opened && !this.entries.length && "В полученной порции нет записей журнала.",
    ].filter(Boolean).join("\n"));
    const snapshot = object(this.snapshot?.data);
    const stage = taskSynthesisOpen(snapshot) ? "Подготовка итогов"
      : preparingArtifacts(snapshot) ? "Подготовка материалов" : taskLifecycleLabel(snapshot);
    this.snapshotLabel.set_label(this.snapshot ? [this.final ? "Итоговый снимок" : "Последний снимок", stage]
      .filter(Boolean).join(" · ") : "");
    this.snapshotButton.set_visible(Boolean(this.snapshot));
  }

  private sync(): void {
    this.snapshotButton.set_visible(Boolean(this.snapshot));
    this.readButton.set_sensitive(!this.run);
    this.followButton.set_sensitive(!this.run && !this.final && !this.cursorUnavailable);
    this.stopButton.set_visible(Boolean(this.run));
    this.restartButton.set_visible(this.cursorUnavailable || this.legacy);
    this.restartButton.set_sensitive(!this.run);
  }

  private open(event: Document, title: string): void {
    if (this.disposed || this.viewer) return;
    const content = column();
    const delivery = taskEventDelivery(event);
    if (delivery) renderEventDelivery(content, delivery);
    const speech = new SpokenReceiptView(event.data);
    if (speech.widget.visible) { speech.widget.expanded = true;content.append(speech.widget); }
    const checkpoint = new TaskCheckpointsView();
    checkpoint.update([{ event, epoch: 0 }]);
    if (checkpoint.widget.visible) { checkpoint.widget.expanded = true;content.append(checkpoint.widget); }
    const view = new Gtk.TextView({ editable: false, monospace: true, wrap_mode: Gtk.WrapMode.WORD_CHAR });
    view.get_buffer().set_text(JSON.stringify(event, null, 2), -1);
    content.append(view);
    const viewer = sheet(title, content);
    this.viewer = viewer;
    viewer.connect("closed", () => { speech.close();checkpoint.close();this.viewer = undefined; });
    viewer.present(this.parent);
  }
}
