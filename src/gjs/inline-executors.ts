import { Gtk, Pango } from "./gi.js";
import { bindChrome, chromeText, watchNativeI18n } from "./native-i18n.js";
import { exactWorkTarget } from "./work-actions.js";
import { button, clear, column, label } from "./ui.js";

interface Execution { executor: string; task_id?: string | null; wid?: number; ts?: string; reason?: string; chat_id?: number }
interface Snapshot { degraded_total: number; live: Execution[]; recent: Execution[] }
const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);
function read(raw: unknown): Snapshot | undefined {
  if (raw === undefined) return undefined;
  const row = (v: unknown) => object(v) && typeof v.executor === "string" && Boolean(v.executor.trim())
    && (v.task_id == null || typeof v.task_id === "string")
    && ["ts", "reason"].every(key => v[key] == null || typeof v[key] === "string")
    && ["wid", "chat_id"].every(key => v[key] === undefined || Number.isSafeInteger(v[key]));
  if (!object(raw) || !Number.isSafeInteger(raw.degraded_total) || raw.degraded_total < 0
    || !Array.isArray(raw.live) || !raw.live.every(row) || !Array.isArray(raw.recent) || !raw.recent.every(row)) throw new Error();
  return raw as Snapshot;
}
function executorName(value: string): string {
  if (value === "inline_degraded") return chromeText("Fallback inline executor", undefined, "Резервный исполнитель в процессе");
  if (value === "inline_call") return chromeText("Live call executor", undefined, "Исполнитель живого вызова");
  return value;
}

/** Health observations of this process, never task outcome or a worker-control declaration. */
export class InlineExecutorsView {
  private readonly body = column(6);
  readonly widget = new Gtk.Expander({ child: this.body, visible: false });
  private snapshot?: Snapshot;
  private stale = false;
  private closed = false;
  private headingRelease = () => {};
  private readonly unwatch: () => void;
  constructor(private readonly openTask: (id: string) => void) { this.unwatch = watchNativeI18n(() => this.render()); }
  update(raw: unknown): void {
    if (this.closed) return;
    try { this.snapshot = read(raw);this.stale = false; } catch { this.stale = true; }
    this.render();
  }
  unavailable(): void { if (!this.closed) { this.stale = true;this.render(); } }
  close(): void { if (this.closed) return;this.closed = true;this.unwatch();this.headingRelease(); }
  private render(): void {
    if (this.closed) return;
    const value = this.snapshot;
    this.widget.set_visible(this.stale || Boolean(value));
    clear(this.body);this.headingRelease();
    const source = this.stale ? "Inline execution details are unavailable" : "Gateway process · {live} current · {count} fallback disclosures";
    const params = { live: value?.live.length ?? 0, count: value?.degraded_total ?? 0 };
    this.widget.set_label(chromeText(source, params, this.stale ? "Сведения об исполнении в процессе недоступны"
      : `Процесс шлюза · текущих ${params.live} · резервных запусков объявлено ${params.count}`));
    this.headingRelease = bindChrome(this.widget, "label", source, params);
    const append = (words: string, style?: string) => {
      const field = label(words, style);field.set_selectable(true);field.set_wrap_mode(Pango.WrapMode.WORD_CHAR);field.set_max_width_chars(64);this.body.append(field);
    };
    if (this.stale) append(value
      ? chromeText("Showing the last observed inline executions; a new reading is unconfirmed.", undefined, "Показаны последние наблюдения исполнения в процессе; новое чтение не подтверждено.")
      : chromeText("No inline execution observations could be read.", undefined, "Прочитать наблюдения исполнения в процессе не удалось."), "warning");
    if (!value) return;
    append(chromeText("These observations belong to this gateway process. A recent disclosure does not confirm task completion.", undefined,
      "Наблюдения относятся к этому процессу шлюза. Недавняя запись о запуске не подтверждает завершение задачи."), "dim-label");
    for (const [rows, heading] of [[value.live, chromeText("Current inline executors", undefined, "Текущие исполнители в процессе")],
      [value.recent, chromeText("Recent execution disclosures", undefined, "Недавние записи о запуске")]] as const) {
      append(heading, "heading");
      if (!rows.length) append(chromeText("No records in this part of the snapshot.", undefined, "В этой части снимка записей нет."), "dim-label");
      for (const row of rows) {
        append([executorName(row.executor), row.wid === undefined ? "" : chromeText("Slot · {id}", { id: row.wid }, `Слот · ${row.wid}`), row.task_id, row.ts].filter(v => v !== "" && v != null).join(" · "));
        if (row.reason) append(row.reason);
        if (row.chat_id !== undefined) append(chromeText("Chat · {id}", { id: row.chat_id }, `Чат · ${row.chat_id}`), "dim-label");
        if (exactWorkTarget(row.task_id)) {
          const task = row.task_id;
          const action = button(chromeText("Open task", undefined, "Открыть задачу"), () => {
            if (!this.closed && !this.stale && this.snapshot === value) this.openTask(task);
          });
          action.set_sensitive(!this.stale);this.body.append(action);
        }
      }
    }
  }
}
