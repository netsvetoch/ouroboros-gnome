import { Gtk, Pango } from "./gi.js";
import { bindChrome, chromeText, watchNativeI18n } from "./native-i18n.js";
import { clear, column, label } from "./ui.js";

interface Hurry {
  state?: string; attempt_key?: number; request_id?: string; requested_by?: string; requested_at?: string;
  applied_at?: string; reconciled_at?: string; archived_at?: string; archived_reason?: string; reason?: string;
  effects?: Record<string, string>;
}
interface Projection { current?: Hurry; history: Hurry[] }
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
function readable(text: string, css?: string): any {
  const widget = label(text, css);widget.set_wrap_mode(Pango.WrapMode.WORD_CHAR);widget.set_max_width_chars(64);return widget;
}
function block(value: unknown): value is Hurry {
  return object(value) && ["state", "request_id", "requested_by", "requested_at", "applied_at", "reconciled_at", "archived_at", "archived_reason", "reason"]
    .every(key => !Object.hasOwn(value, key) || typeof value[key] === "string")
    && (!Object.hasOwn(value, "attempt_key") || Number.isSafeInteger(value.attempt_key) && value.attempt_key > 0)
    && (!Object.hasOwn(value, "effects") || object(value.effects) && Object.values(value.effects).every(item => typeof item === "string"));
}
function read(raw: unknown): Projection {
  if (!object(raw) || (raw.owner_hurry != null && !block(raw.owner_hurry))
    || (raw.owner_hurry_history != null && (!Array.isArray(raw.owner_hurry_history) || !raw.owner_hurry_history.every(block)))) throw new Error();
  return { current: raw.owner_hurry ?? undefined, history: raw.owner_hurry_history ?? [] };
}
function state(value?: string): string {
  if (value === "requested") return chromeText("Hurry requested; application is not yet confirmed.", undefined, "Ускорение запрошено; применение ещё не подтверждено.");
  if (value === "applied") return chromeText("Hurry control applied in this attempt.", undefined, "Команда ускорения применена в этой попытке.");
  if (value === "not_applied_before_terminal") return chromeText("The task ended before the hurry control was applied.", undefined, "Задача завершилась до применения команды ускорения.");
  return value ? chromeText("State · {value}", { value }, `Состояние · ${value}`)
    : chromeText("The gateway did not name the hurry state.", undefined, "Шлюз не указал состояние ускорения.");
}

/** A task-result detail, never a chat message or authority to change a task. */
export class TaskHurryView {
  private readonly body = column(6);
  readonly widget = new Gtk.Expander({ label: "Ускорение по запросу владельца", child: this.body, visible: false });
  private snapshot?: Projection;
  private stale = false;
  private closed = false;
  private readonly expanded = new Set<string>();
  private readonly unwatch: () => void;
  private readonly releaseTitle: () => void;

  constructor() { this.releaseTitle = bindChrome(this.widget, "label", "Owner hurry");this.unwatch = watchNativeI18n(() => this.render()); }
  close(): void { this.closed = true;this.unwatch();this.releaseTitle(); }
  waiting(): boolean { return !this.closed && this.snapshot?.current?.state === "requested"; }

  update(raw: unknown): void {
    if (this.closed) return;
    try { this.snapshot = read(raw);this.stale = false; }
    catch { this.stale = true; }
    this.render();
  }

  private render(): void {
    if (this.closed) return;
    clear(this.body);
    this.widget.set_visible(this.stale || Boolean(this.snapshot?.current) || Boolean(this.snapshot?.history.length));
    if (this.stale) this.body.append(readable(this.snapshot
      ? chromeText("Hurry details are unavailable. Showing the last confirmed snapshot.", undefined, "Сведения об ускорении недоступны. Показан последний подтверждённый снимок.")
      : chromeText("Hurry details are unavailable.", undefined, "Сведения об ускорении недоступны."), "warning"));
    const fact = (target: any, english: string, russian: string, value: string | number | undefined) => {
      if (value === undefined || value === "") return;
      const widget = readable(chromeText(english, { value }, `${russian} · ${value}`));widget.set_selectable(true);target.append(widget);
    };
    const render = (target: any, value: Hurry) => {
      target.append(readable(state(value.state)));
      fact(target, "Attempt · {value}", "Попытка", value.attempt_key);
      fact(target, "Request · {value}", "Запрос", value.request_id);
      fact(target, "Requested by · {value}", "Инициатор", value.requested_by);
      fact(target, "Requested at · {value}", "Запрошено", value.requested_at);
      fact(target, "Applied at · {value}", "Применено", value.applied_at);
      fact(target, "Reconciled at · {value}", "Сверено с завершением", value.reconciled_at);
      fact(target, "Reason · {value}", "Причина", value.reason);
      for (const [effect, outcome] of Object.entries(value.effects ?? {})) {
        if (effect === "plan_review" && outcome === "task_local_advisory") target.append(readable(chromeText(
          "Plan review is advisory for this task.", undefined, "Проверка плана носит рекомендательный характер для этой задачи.")));
        else { const text = readable(`${effect} · ${outcome}`);text.set_selectable(true);target.append(text); }
      }
      fact(target, "Archived at · {value}", "Архивировано", value.archived_at);
      fact(target, "Archive reason · {value}", "Причина архивации", value.archived_reason);
    };
    if (this.snapshot?.current) render(this.body, this.snapshot.current);
    for (const entry of this.snapshot?.history ?? []) {
      const key = JSON.stringify([entry.request_id, entry.attempt_key, entry.archived_at]);
      const content = column(4);render(content, entry);
      const item = new Gtk.Expander({ label: chromeText("Previous hurry record · {value}", { value: entry.attempt_key ?? "?" }, `Прежняя запись ускорения · ${entry.attempt_key ?? "?"}`),
        child: content, expanded: this.expanded.has(key) });
      item.connect("notify::expanded", () => { if (item.get_expanded()) this.expanded.add(key);else this.expanded.delete(key); });this.body.append(item);
    }
  }
}
