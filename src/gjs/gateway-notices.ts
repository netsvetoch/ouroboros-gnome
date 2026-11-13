import { Adw, GLib, Gtk, Pango } from "./gi.js";
import { bindChrome, chromeText } from "./native-i18n.js";
import { button, column, label, sheet } from "./ui.js";
import { exactWorkTarget } from "./work-actions.js";

type Tone = "danger" | "warn" | "ok" | "muted" | "info";
interface Notice { key: string; kind: "incident" | "reminder"; incident: string; text: string; task?: string; tone: Tone; recordedTone?: string;
  reminder?: { values: Record<string, string>; invalid: string[] } }
function checksum(value: string): string { return GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, new TextEncoder().encode(value)); }
const object = (raw: unknown): raw is Record<string, unknown> => Boolean(raw && typeof raw === "object" && !Array.isArray(raw));
function tone(value: unknown): Tone {
  const raw = typeof value === "string" ? value.toLowerCase() : "";
  if (["ok", "success"].includes(raw)) return "ok";
  if (["warn", "warning"].includes(raw)) return "warn";
  if (["muted", "neutral"].includes(raw)) return "muted";
  if (raw === "info") return "info";
  return "danger";
}
function notice(raw: unknown): Notice | undefined {
  if (!object(raw) || raw.type !== "chat" || raw._historical !== undefined && raw._historical !== false) return;
  if (raw.system_type === "reminder") {
    if (raw.role !== "system" || raw.is_progress !== undefined && raw.is_progress !== false
      || typeof raw.ts !== "string" || !raw.ts.trim()) return;
    const text = typeof raw.content === "string" && raw.content ? raw.content : typeof raw.text === "string" ? raw.text : "";
    if (!text.trim()) return;
    const values: Record<string, string> = { ts: raw.ts }, invalid: string[] = [];
    for (const key of ["source", "set_at", "scheduled_for", "delivered_at", "delivery_id"] as const) {
      if (raw[key] !== undefined && typeof raw[key] !== "string") invalid.push(key);
      else if (typeof raw[key] === "string" && raw[key]) values[key] = raw[key];
    }
    if (raw.chat_id !== undefined) {
      if (typeof raw.chat_id === "number" && Number.isSafeInteger(raw.chat_id)) values.chat_id = String(raw.chat_id);
      else invalid.push("chat_id");
    }
    const key = values.delivery_id?.trim() || checksum(JSON.stringify([values.chat_id ?? null, raw.ts, text]));
    return { key, kind: "reminder", incident: "", text, tone: "info", reminder: { values, invalid } };
  }
  if (raw.is_progress !== true || typeof raw.task_incident !== "string" || !raw.task_incident.trim()
    || raw.toast_once !== undefined && typeof raw.toast_once !== "string") return;
  const incident = raw.task_incident.trim(), task = typeof raw.task_id === "string" ? raw.task_id : undefined;
  const key = (raw.toast_once || `${task ?? ""}:${incident}`).trim();
  if (!key) return;
  const text = typeof raw.content === "string" && raw.content ? raw.content : typeof raw.text === "string" && raw.text ? raw.text : incident;
  return { key, kind: "incident", incident, text, task, tone: tone(raw.toast_tone), recordedTone: typeof raw.toast_tone === "string" ? raw.toast_tone : undefined };
}
const captions: Record<Tone, [string, string, string]> = {
  danger: ["Gateway alert", "Предупреждение шлюза", "dialog-error-symbolic"],
  warn: ["Gateway warning", "Предупреждение шлюза", "dialog-warning-symbolic"],
  ok: ["Gateway success", "Подтверждение шлюза", "emblem-ok-symbolic"],
  muted: ["Gateway notice", "Сообщение шлюза", "dialog-information-symbolic"],
  info: ["Gateway information", "Информация шлюза", "dialog-information-symbolic"],
};

/** One gateway session owns dedupe across all chat surfaces and socket reconnects. */
export class GatewayNotices {
  private readonly seen = new Set<string>();
  private readonly pending: Notice[] = [];
  private readonly details = new Set<any>();
  private current?: { toast: any; notice?: Notice; releases: (() => void)[] };
  private omitted = 0;
  private idle = 0;
  private closed = false;
  private readonly visibilitySignal: number;
  private readonly closeSignal: number;
  constructor(private readonly window: any, private readonly overlay: any, private readonly openTask?: (id: string) => void) {
    this.visibilitySignal = window.connect("notify::visible-dialog", () => this.schedule());
    this.closeSignal = window.connect("close-request", () => { this.close();return false; });
  }
  frame(raw: unknown): void {
    if (this.closed) return;
    const entry = notice(raw);
    if (!entry) return;
    const digest = checksum(JSON.stringify([entry.kind, entry.key]));
    if (this.seen.has(digest)) return;
    this.seen.add(digest);
    if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value!);
    if (this.pending.length >= 500) { this.pending.shift();this.omitted++; }
    this.pending.push(entry);this.drain();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;this.window.disconnect(this.visibilitySignal);this.window.disconnect(this.closeSignal);
    if (this.idle) GLib.Source.remove(this.idle);this.idle = 0;
    this.pending.length = 0;this.seen.clear();this.omitted = 0;
    this.current?.toast.dismiss();
    for (const dialog of [...this.details]) dialog.force_close();
  }
  private schedule(): void {
    if (this.closed || this.idle) return;
    this.idle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { this.idle = 0;this.drain();return GLib.SOURCE_REMOVE; });
  }
  private drain(): void {
    if (this.closed || this.current || this.window.get_visible_dialog() || !this.omitted && !this.pending.length) return;
    const releases: (() => void)[] = [];
    const toast = new Adw.Toast({ use_markup: false, timeout: 6 });
    let entry: Notice | undefined;
    if (this.omitted) {
      const n = this.omitted;this.omitted = 0;
      toast.set_title(chromeText("Older queued gateway notices omitted · {n}", { n }, `Пропущено прежних уведомлений шлюза в очереди · ${n}`));
      releases.push(bindChrome(toast, "title", "Older queued gateway notices omitted · {n}", { n }));
    } else {
      entry = this.pending.shift();
      if (!entry) return;
      const item = entry, [english, russian, iconName] = item.kind === "reminder" ? ["Scheduled reminder", "Напоминание расписания", "alarm-symbolic"] : captions[item.tone], title = new Gtk.Label({ wrap: true,
        wrap_mode: Pango.WrapMode.WORD_CHAR, max_width_chars: 48, lines: 3, ellipsize: Pango.EllipsizeMode.END, xalign: 0 });
      title.set_label(`${chromeText(english, undefined, russian)}\n${item.text}`);title.set_tooltip_text(item.text);
      releases.push(bindChrome(title, "label", `${english} · {message}`, { message: item.text }));
      const content = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
      const icon = new Gtk.Image({ icon_name: iconName });
      if (["danger", "warn", "ok"].includes(item.tone)) icon.add_css_class(item.tone === "danger" ? "error" : item.tone === "warn" ? "warning" : "success");
      content.append(icon);content.append(title);toast.set_custom_title(content);
      toast.set_button_label(chromeText("Details", undefined, "Подробнее"));releases.push(bindChrome(toast, "button-label", "Details"));
      toast.connect("button-clicked", () => { if (!this.closed && this.current?.toast === toast) { this.showDetails(item);toast.dismiss(); } });
    }
    this.current = { toast, notice: entry, releases };
    toast.connect("dismissed", () => {
      for (const release of releases.splice(0)) release();
      if (this.current?.toast === toast) this.current = undefined;
      this.schedule();
    });
    this.overlay.add_toast(toast);
  }
  private showDetails(entry: Notice): void {
    if (this.closed) return;
    const title = entry.kind === "reminder" ? "Scheduled reminder" : "Gateway notice";
    const content = column(6), dialog = sheet(chromeText(title), content), releases: (() => void)[] = [];
    dialog.set_content_width(650);dialog.set_content_height(480);
    releases.push(bindChrome(dialog, "title", title));
    this.details.add(dialog);
    const fact = (english: string, russian: string, value: string) => {
      const field = label(chromeText(english, { value }, `${russian} · ${value}`));
      field.set_selectable(true);field.set_wrap_mode(Pango.WrapMode.WORD_CHAR);field.set_max_width_chars(64);
      content.append(field);releases.push(bindChrome(field, "label", english, { value }));
    };
    if (entry.reminder) {
      for (const [key, english, russian] of [["source", "Reminder source · {value}", "Источник напоминания"],
        ["set_at", "Reminder written at · {value}", "Напоминание записано"], ["scheduled_for", "Reminder scheduled for · {value}", "Назначенное время"],
        ["delivered_at", "Reminder delivered at · {value}", "Время публикации"], ["ts", "Reminder message timestamp · {value}", "Время сообщения"],
        ["chat_id", "Reminder chat · {value}", "Чат напоминания"], ["delivery_id", "Reminder delivery ID · {value}", "Идентификатор доставки"]] as const) {
        if (entry.reminder.values[key]) fact(english, russian, entry.reminder.values[key]);
      }
      if (!["set_at", "scheduled_for", "delivered_at"].some(key => entry.reminder!.values[key])) {
        const field = label(chromeText("Structured reminder times are not published. The original reminder text is retained."));content.append(field);
        releases.push(bindChrome(field, "label", "Structured reminder times are not published. The original reminder text is retained."));
      }
      if (entry.reminder.invalid.length) fact("Reminder metadata could not be read · {value}", "Не удалось прочитать сведения напоминания", entry.reminder.invalid.join(", "));
    } else { fact("Incident · {value}", "Событие", entry.incident);fact("Notice key · {value}", "Ключ уведомления", entry.key); }
    if (entry.recordedTone) fact("Recorded notice tone · {value}", "Записанный тон уведомления", entry.recordedTone);
    if (entry.task) fact("Notice task · {value}", "Задача уведомления", entry.task);
    const text = new Gtk.TextView({ editable: false, wrap_mode: Gtk.WrapMode.WORD_CHAR });text.buffer.set_text(entry.text, -1);
    content.append(new Gtk.ScrolledWindow({ child: text, min_content_height: 120, max_content_height: 320, propagate_natural_height: true }));
    if (this.openTask && exactWorkTarget(entry.task)) {
      const task = entry.task, open = button(chromeText("Open task", undefined, "Открыть задачу"), () => {
        if (!this.closed && this.details.has(dialog)) { dialog.force_close();this.openTask?.(task); }
      });
      content.append(open);releases.push(bindChrome(open, "label", "Open task"));
    }
    dialog.connect("closed", () => { this.details.delete(dialog);for (const release of releases.splice(0)) release(); });
    dialog.present(this.window);
  }
}
