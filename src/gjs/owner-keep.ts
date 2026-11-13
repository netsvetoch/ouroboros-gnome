import { Adw, Gio, Gtk, Pango } from "./gi.js";
import { type Gateway, HttpError } from "./gateway.js";
import { bindChrome, chromeText, watchNativeI18n } from "./native-i18n.js";
import { button, clear, column, confirm, errorText, label, sheet } from "./ui.js";

const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));
export interface OwnerKeepReceipt { task_id: string; keep: boolean; status: string; reason: string; retained: string[]; retired: string[]; unknown: string[]; releases: Record<string, string> }
export function readOwnerKeepReceipt(raw: unknown, task: string): OwnerKeepReceipt {
  if (!object(raw) || raw.task_id !== task || typeof raw.keep !== "boolean" || typeof raw.status !== "string" || !raw.status.trim()
    || typeof raw.reason !== "string" || ["retained", "retired", "unknown"].some(key => !Array.isArray(raw[key]) || !(raw[key] as unknown[]).every(v => typeof v === "string" && v.trim()))
    || !object(raw.releases) || Object.entries(raw.releases).some(([key, v]) => !key.trim() || typeof v !== "string")
    || (raw.retained as string[]).some(place => (raw.retired as string[]).includes(place))
    || ["kept", "partly_retired", "release_unconfirmed"].includes(raw.status) && raw.keep !== true
    || raw.status === "released" && raw.keep !== false) throw new Error("Material protection receipt could not be read");
  return raw as unknown as OwnerKeepReceipt;
}
interface KeepFact { keep: boolean; at?: string; note?: string; scope?: string; basis?: string; route?: string; issues: string[] }
export function readOwnerKeepFact(raw: unknown, task: string): KeepFact {
  if (!object(raw) || raw.task_id !== undefined && raw.task_id !== task || typeof raw.status !== "string" || !raw.status.trim()) throw new Error("Task protection state could not be read");
  if (raw.owner_keep === undefined || raw.owner_keep === null) return { keep: false, issues: [] };
  if (!object(raw.owner_keep)) throw new Error("Task protection fact could not be read");
  const value = raw.owner_keep, fact: KeepFact = { keep: true, issues: [] };
  for (const key of ["at", "note", "scope"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") fact.issues.push(key);
    else if (typeof value[key] === "string") fact[key] = value[key];
  }
  if (value.source !== undefined) {
    if (!object(value.source)) fact.issues.push("source");
    else for (const key of ["basis", "route"] as const) {
      if (value.source[key] !== undefined && typeof value.source[key] !== "string") fact.issues.push("source." + key);
      else if (typeof value.source[key] === "string") fact[key] = value.source[key];
    }
  }
  return fact;
}
const statuses: Record<string, [string, string]> = {
  kept: ["Material protection saved", "Защита материалов сохранена"], released: ["Material protection released", "Защита материалов снята"],
  partly_retired: ["Protection saved for remaining material", "Защита сохранена для оставшихся материалов"],
  already_retired: ["All discovered material retired or accepted for deletion; no new keep fact saved", "Найденные материалы уже выведены из хранения или переданы на удаление; новая защита не сохранена"],
  release_unconfirmed: ["Protection saved; some release outcomes remain unconfirmed", "Защита сохранена; исход освобождения части материалов не подтверждён"],
  inflight: ["Material custody is busy; this request was not applied", "Материалы заняты; запрос не применён"],
  refused: ["Material protection request refused", "Запрос защиты материалов отклонён"],
};

export class OwnerKeepDialog {
  readonly dialog: any;
  private readonly content = column(6);
  private readonly protection = label("");
  private readonly metadata = column(3);
  private readonly note = new Gtk.Entry({ max_length: 500 });
  private readonly feedback = label("", "dim-label");
  private readonly results = column(4);
  private readonly keepButton: any;
  private readonly releaseButton: any;
  private readonly readButton: any;
  private readonly cancel = new Gio.Cancellable();
  private readonly unwatch: () => void;
  private unbind = () => {};
  private readonly parentSignal: number;
  private readonly path: string;
  private fact?: KeepFact;
  private confirmed = false;
  private receipt?: OwnerKeepReceipt;
  private uncertain = false;
  private refusal = "";
  private issue = "";
  private requestedNote = "";
  private busy = false;
  private closed = false;
  constructor(private readonly parent: any, private readonly gateway: Gateway, private readonly task: string, private readonly closedCallback: () => void) {
    this.path = `/api/tasks/${encodeURIComponent(task)}`;
    this.dialog = sheet(chromeText("Task material retention", undefined, "Хранение материалов задачи"), this.content);
    this.keepButton = button("", () => void this.apply(true));this.releaseButton = button("", () => void this.apply(false));
    this.readButton = button("", () => void this.read());
    const actions = new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.NONE, column_spacing: 6, row_spacing: 6 });actions.append(this.keepButton);actions.append(this.releaseButton);actions.append(this.readButton);
    for (const item of [this.protection, this.metadata, this.note, actions, this.feedback, this.results]) this.content.append(item);
    for (const field of [this.protection, this.feedback]) { field.set_selectable(true);field.set_wrap_mode(Pango.WrapMode.WORD_CHAR);field.set_max_width_chars(64); }
    this.parentSignal = parent instanceof Adw.Dialog ? parent.connect("closed", () => this.close()) : 0;
    this.dialog.connect("closed", () => this.dispose());
    this.unwatch = watchNativeI18n(() => this.paint());this.paint();this.dialog.present(parent);void this.read();
  }
  close(): void { if (this.closed) return;this.dispose();this.dialog.force_close(); }
  private dispose(): void {
    if (this.closed) return;
    this.closed = true;this.cancel.cancel();this.unwatch();this.unbind();
    if (this.parentSignal) this.parent.disconnect(this.parentSignal);
    this.closedCallback();
  }
  private async readFact(): Promise<void> {
    try {
      const raw = await this.gateway.json<unknown>("GET", this.path, undefined, undefined, false, this.cancel);
      if (this.closed) return;
      this.fact = readOwnerKeepFact(raw, this.task);this.confirmed = true;
    } catch (error) {
      if (this.closed) return;
      this.confirmed = false;this.issue = errorText(error);
    }
  }
  async read(): Promise<void> {
    if (this.closed || this.busy) return;
    this.busy = true;this.issue = "";this.paint();
    try { await this.readFact(); } finally { if (!this.closed) { this.busy = false;this.paint(); } }
  }
  async apply(keep: boolean): Promise<void> {
    if (this.closed || this.busy || !this.confirmed) return;
    this.busy = true;this.paint();
    try {
      if (!keep && !await confirm(this.dialog, chromeText("Release material protection?", undefined, "Снять защиту материалов?"),
        chromeText("This task's material can become eligible for automatic cleanup again.", undefined, "Материалы этой задачи снова могут попасть в автоматическую очистку."),
        chromeText("Release protection", undefined, "Снять защиту"))) return;
      if (this.closed) return;
      this.receipt = undefined;this.uncertain = false;this.refusal = "";this.issue = "";this.paint();
      const note = this.note.get_text().trim();
      this.requestedNote = keep ? note : "";
      try {
        const raw = await this.gateway.json<unknown>("POST", `${this.path}/owner-keep`, { keep, ...(keep && note ? { note } : {}) }, undefined, false, this.cancel);
        if (this.closed) return;
        this.receipt = readOwnerKeepReceipt(raw, this.task);
      } catch (error) {
        if (this.closed) return;
        const refused = error instanceof HttpError && (error.status === 400 && error.reason === "unexpected_fields"
          || error.status === 404 && error.reason === "task_not_found"
          || error.status === 503 && ["task_unreadable", "source_missing", "migrating"].includes(error.reason ?? ""));
        this.refusal = refused ? (error as HttpError).reason! : "";
        this.uncertain = !refused;this.issue = errorText(error);
      }
      if (!this.closed) await this.readFact();
    } finally { if (!this.closed) { this.busy = false;this.paint(); } }
  }
  private paint(): void {
    if (this.closed) return;
    this.unbind();this.unbind = bindChrome(this.dialog, "title", "Task material retention");
    this.note.set_placeholder_text(chromeText("Note when enabling protection", undefined, "Примечание при включении защиты"));
    this.keepButton.set_label(chromeText("Protect from cleanup", undefined, "Защитить от очистки"));
    this.releaseButton.set_label(chromeText("Release protection", undefined, "Снять защиту"));
    this.readButton.set_label(chromeText("Read current protection", undefined, "Перечитать защиту"));
    this.keepButton.set_sensitive(!this.busy && this.confirmed);this.releaseButton.set_sensitive(!this.busy && this.confirmed);
    this.readButton.set_sensitive(!this.busy);this.note.set_sensitive(!this.busy);
    this.protection.set_label(this.confirmed ? this.fact?.keep ? chromeText("Current protection · enabled", undefined, "Текущая защита · включена")
      : chromeText("Current protection · absent", undefined, "Текущая защита · отсутствует")
      : this.fact ? chromeText("Previous protection observation · {value} (unconfirmed)", { value: this.fact.keep ? chromeText("Enabled") : chromeText("Absent") })
        : chromeText("Current material protection is unavailable.", undefined, "Текущая защита материалов неизвестна."));
    this.feedback.set_label([this.busy ? chromeText("Waiting for material protection response…", undefined, "Ожидаю ответ о защите материалов…") : "",
      this.uncertain ? chromeText("Operation receipt unavailable; the request outcome is unconfirmed. Rereading current protection does not recover its inventory receipt.") : "",
      this.refusal ? chromeText("Gateway declined material protection request · {value}", { value: this.refusal }) : "",
      this.issue].filter(Boolean).join("\n"));
    clear(this.metadata);clear(this.results);
    const fact = (target: any, source: string, value?: string | number, css?: string) => {
      const field = label(chromeText(source, value === undefined ? undefined : { value }), css);field.set_selectable(true);
      field.set_wrap_mode(Pango.WrapMode.WORD_CHAR);field.set_max_width_chars(64);target.append(field);
    };
    fact(this.metadata, "Protection applies only to this task's material, not its descendants. It does not stop task execution.");
    fact(this.metadata, "Task · {value}", this.task);
    if (this.fact) {
      for (const [key, source] of [["at", "Keep fact recorded at · {value}"], ["note", "Saved keep note · {value}"], ["scope", "Recorded keep scope · {value}"],
        ["basis", "Recorded keep source basis · {value}"], ["route", "Recorded keep source route · {value}"]] as const) if (this.fact[key]) fact(this.metadata, source, this.fact[key]);
      if (this.fact.issues.length) fact(this.metadata, "Some keep fact metadata could not be read · {value}", this.fact.issues.join(", "), "warning");
      if (this.confirmed && this.fact.keep && this.requestedNote && this.fact.note !== this.requestedNote) fact(this.metadata, "The current saved note differs from the requested note. No note edit is confirmed.", undefined, "warning");
    }
    if (!this.receipt) return;
    const receipt = this.receipt;
    const caption = Object.hasOwn(statuses, receipt.status) ? statuses[receipt.status] : undefined;
    if (caption) this.results.append(label(chromeText(caption[0], undefined, caption[1]), "heading"));
    else fact(this.results, "Recorded operation status · {value}", receipt.status, "heading");
    fact(this.results, receipt.keep ? "Protection reported by operation response · enabled" : "Protection reported by operation response · absent");
    if (receipt.reason) fact(this.results, "Recorded protection reason · {value}", receipt.reason);
    if (this.confirmed && this.fact?.keep !== receipt.keep) fact(this.results, "Current readback differs from the operation response; the observations were made at different times.", undefined, "warning");
    fact(this.results, "Inventory and release states are observations from this operation. Retirement or future-reuse release does not prove deletion of bytes.", undefined, "dim-label");
    for (const [source, values] of [["Retained material", receipt.retained], ["Retired or accepted for deletion", receipt.retired], ["Material classes with unknown state", receipt.unknown]] as const) if (values.length) {
      fact(this.results, source, undefined, "heading");
      for (const value of values) { const item = label(value);item.set_selectable(true);item.set_wrap_mode(Pango.WrapMode.WORD_CHAR);item.set_max_width_chars(64);this.results.append(item); }
    }
    for (const [place, state] of Object.entries(receipt.releases)) fact(this.results, "Last recorded release · {value}", `${place} · ${state}`);
  }
}
