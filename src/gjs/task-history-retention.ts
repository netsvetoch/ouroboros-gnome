import { Gtk, Pango } from "./gi.js";
import { bindChrome, chromeText, watchNativeI18n } from "./native-i18n.js";
import { clear, column, label } from "./ui.js";

interface Retention {
  status: string;
  pending_count?: number;
  problem_count?: number;
  promoted_ref_count?: number;
  promoted_source_handle_count?: number;
  problem_reasons?: { reason: string; count?: number }[];
}
const counts = ["pending_count", "problem_count", "promoted_ref_count", "promoted_source_handle_count"] as const;
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) >= 0;
function read(raw: unknown): Retention | undefined {
  if (!object(raw)) throw new Error();
  const value = raw.history_retention;
  if (value == null) return undefined;
  if (!object(value) || typeof value.status !== "string" || !value.status
    || counts.some(key => Object.hasOwn(value, key) && !count(value[key]))
    || Object.hasOwn(value, "problem_reasons") && (!Array.isArray(value.problem_reasons)
      || value.problem_reasons.some((row: unknown) => !object(row) || typeof row.reason !== "string"
        || Object.hasOwn(row, "count") && !count(row.count)))) throw new Error();
  return value as Retention;
}

/** Storage placement is a separate fact, never task completion or review authority. */
export class TaskHistoryRetentionView {
  private readonly body = column(6);
  readonly widget = new Gtk.Expander({ label: "Хранение истории задачи", child: this.body, visible: false });
  private snapshot?: Retention;
  private stale = false;
  private closed = false;
  private readonly unwatch: () => void;
  private release: () => void;
  private title = "Task history storage";

  constructor() {
    this.release = bindChrome(this.widget, "label", "Task history storage");
    this.unwatch = watchNativeI18n(() => this.render());
  }
  close(): void { this.closed = true;this.unwatch();this.release(); }
  waiting(): boolean { return !this.closed && ["pending", "deferred"].includes(this.snapshot?.status ?? ""); }
  update(raw: unknown): void {
    if (this.closed) return;
    try { this.snapshot = read(raw);this.stale = false; }
    catch { this.stale = true; }
    this.render();
  }
  private render(): void {
    if (this.closed) return;
    clear(this.body);
    this.widget.set_visible(this.stale || Boolean(this.snapshot));
    const append = (text: string, css?: string) => {
      const item = label(text, css);item.set_selectable(true);
      item.set_wrap_mode(Pango.WrapMode.WORD_CHAR);item.set_max_width_chars(64);this.body.append(item);
    };
    if (this.stale) append(this.snapshot
      ? chromeText("History storage details are unavailable. Showing the last confirmed snapshot.", undefined,
        "Сведения о хранении истории недоступны. Показан последний подтверждённый снимок.")
      : chromeText("History storage details are unavailable.", undefined, "Сведения о хранении истории недоступны."), "warning");
    const value = this.snapshot;
    const title = this.stale ? "History storage details are unavailable." : value?.status === "problem" ? "History storage problem" : "Task history storage";
    if (title !== this.title) {
      this.release();this.title = title;
      this.widget.set_label(chromeText(title, undefined, this.stale ? "Сведения о хранении истории недоступны."
        : value?.status === "problem" ? "Проблема хранения истории" : "Хранение истории задачи"));
      this.release = bindChrome(this.widget, "label", title);
    }
    this.widget.remove_css_class("warning");
    if (this.stale || value?.status === "problem") this.widget.add_css_class("warning");
    if (!value) return;
    if (value.status === "problem") append(chromeText("Some task history could not be saved.", undefined,
      "Часть истории задачи не удалось сохранить."), "warning");
    else if (value.status === "complete") append(chromeText("Task history has been saved.", undefined, "История задачи сохранена."));
    else if (this.waiting()) append(chromeText("Task history is being saved in the background.", undefined,
      "История задачи сохраняется в фоне."));
    else append(chromeText("History storage state · {value}", { value: value.status }, `Состояние хранения истории · ${value.status}`));
    append(chromeText("History storage does not change the task outcome.", undefined,
      "Состояние хранения истории не меняет итог задачи."), "dim-label");
    const captions = [
      ["pending_count", "Pending entries · {value}", "Ожидающие записи"],
      ["problem_count", "Problem entries · {value}", "Записи с проблемами"],
      ["promoted_ref_count", "Saved references · {value}", "Сохранённые ссылки"],
      ["promoted_source_handle_count", "Saved source handles · {value}", "Сохранённые дескрипторы источников"],
    ] as const;
    for (const [key, english, russian] of captions) if (value[key] !== undefined)
      append(chromeText(english, { value: value[key]! }, `${russian} · ${value[key]}`));
    for (const row of value.problem_reasons ?? []) append(row.count === undefined ? row.reason
      : chromeText("{count} × {reason}", { count: row.count, reason: row.reason }, `${row.count} × ${row.reason}`));
    if (value.status === "problem" && !value.problem_reasons?.some(row => row.reason))
      append(chromeText("No failure reason was recorded.", undefined, "Причина ошибки не записана."));
  }
}
