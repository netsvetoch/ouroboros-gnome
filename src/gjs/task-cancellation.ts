import { Pango } from "./gi.js";
import { bindChrome, chromeText } from "./native-i18n.js";
import { clear, column, label } from "./ui.js";

export interface CancellationFields { cancel_state?: unknown; stop_policy?: unknown; cancel_reason?: unknown }
type Snapshot = { state: string; policy?: string; reason?: string } | "unavailable" | undefined;
function read(task?: CancellationFields): Snapshot {
  if (task?.cancel_state == null || task.cancel_state === "") return undefined;
  if (typeof task.cancel_state !== "string" || [task.stop_policy, task.cancel_reason].some(value => value != null && typeof value !== "string")) return "unavailable";
  return { state: task.cancel_state, policy: task.stop_policy as string | undefined, reason: task.cancel_reason as string | undefined };
}
function caption(value: Snapshot): string {
  if (!value) return "";
  if (value === "unavailable") return chromeText("Stop details are unavailable", undefined, "Сведения об остановке недоступны");
  if (value.state !== "pending") return chromeText("Stop state · {state}", { state: value.state }, `Состояние остановки · ${value.state}`);
  return value.policy === "finalize_then_cancel"
    ? chromeText("Finalizing before stop", undefined, "Завершение перед остановкой")
    : chromeText("Stop in progress", undefined, "Идёт остановка");
}
export function cancellationCaption(task: CancellationFields): string { return caption(read(task)); }

/** An open stop intent is independent of lifecycle outcome and work-control authority. */
export class TaskCancellationView {
  readonly widget = column(5);
  private snapshot: Snapshot;
  private closed = false;
  private readonly releases: (() => void)[] = [];
  constructor() { this.widget.set_visible(false); }
  observed(): boolean { return Boolean(this.snapshot); }
  waiting(): boolean { return !this.closed && (this.snapshot === "unavailable" || this.snapshot?.state === "pending"); }
  update(task?: CancellationFields): void {
    if (this.closed) return;
    this.snapshot = read(task);
    this.release();clear(this.widget);
    const value = this.snapshot;
    this.widget.set_visible(Boolean(value));
    if (!value) return;
    const append = (english: string, fallback: string, params?: Record<string, string>, style?: string) => {
      const field = label(chromeText(english, params, fallback), style);
      field.set_selectable(true);field.set_wrap_mode(Pango.WrapMode.WORD_CHAR);field.set_max_width_chars(64);
      this.widget.append(field);this.releases.push(bindChrome(field, "label", english, params));
    };
    if (value === "unavailable") {
      append("Stop details are unavailable", "Сведения об остановке недоступны", undefined, "warning");return;
    }
    if (value.state !== "pending") append("Stop state · {state}", `Состояние остановки · ${value.state}`, { state: value.state }, "heading");
    else if (value.policy === "finalize_then_cancel") append("Finalizing before stop", "Завершение перед остановкой", undefined, "heading");
    else append("Stop in progress", "Идёт остановка", undefined, "heading");
    if (value.state === "pending") append("The stop is recorded. The task has not yet been confirmed stopped.",
      "Запрос остановки записан. Остановка задачи ещё не подтверждена.", undefined, "dim-label");
    if (value.policy && !["immediate", "finalize_then_cancel"].includes(value.policy)) append("Stop policy · {policy}", `Политика остановки · ${value.policy}`, { policy: value.policy });
    if (value.reason) append("Stop reason · {reason}", `Причина остановки · ${value.reason}`, { reason: value.reason });
  }
  private release(): void { for (const release of this.releases.splice(0)) release(); }
  close(): void { if (this.closed) return;this.closed = true;this.release(); }
}
