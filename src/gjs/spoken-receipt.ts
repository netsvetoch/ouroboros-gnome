import { GLib, Gtk, Pango } from "./gi.js";
import { bindChrome, chromeText, watchNativeI18n } from "./native-i18n.js";
import { clear, column, label } from "./ui.js";

const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));
export interface SpokenReceipt { call_id: string; item_id: string; played_ms: number; status: string }
export function readSpokenReceipt(raw: unknown): SpokenReceipt | undefined {
  if (!object(raw) || !Object.hasOwn(raw, "spoken")) return;
  const receipt = raw.spoken;
  if (!object(receipt) || ["call_id", "item_id", "status"].some(key => typeof receipt[key] !== "string" || !(receipt[key] as string).trim())
    || typeof receipt.played_ms !== "number" || !Number.isSafeInteger(receipt.played_ms) || receipt.played_ms < 0
    || raw.role !== undefined && raw.role !== "assistant"
    || ["call_id", "item_id"].some(key => raw[key] !== undefined && raw[key] !== receipt[key])) {
    throw new Error("Call speech receipt could not be read");
  }
  return { call_id: receipt.call_id as string, item_id: receipt.item_id as string, played_ms: receipt.played_ms, status: receipt.status as string };
}
export function spokenReceiptIdentity(raw: unknown): string | undefined {
  try {
    const receipt = readSpokenReceipt(raw);
    return receipt ? JSON.stringify([receipt.call_id, receipt.item_id]) : undefined;
  } catch { return undefined; }
}
function messageFingerprint(raw: Record<string, unknown>): string {
  const value = JSON.stringify([raw.ts, raw.task_id ?? "", raw.role, raw.source ?? "", raw.text ?? raw.content ?? ""]);
  return GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, new TextEncoder().encode(value));
}
/** Exact server row address plus unchanged message facts; never a text-only guess. */
export class LiveSpokenReceipts {
  private readonly entries = new Map<string, { fingerprint: string; receipt: SpokenReceipt | null }>();
  frame(raw: unknown): void {
    if (!object(raw) || raw.type !== "chat" || raw._historical !== undefined && raw._historical !== false || !Object.hasOwn(raw, "spoken")
      || typeof raw.row_address !== "string" || !/^row:[0-9]+@[^\x00-\x1f]+#[a-f0-9]{12}$/u.test(raw.row_address)) return;
    let receipt: SpokenReceipt | null = null;
    try { receipt = readSpokenReceipt(raw) ?? null; } catch { /* Keep a read warning, never prior valid facts. */ }
    this.entries.delete(raw.row_address);this.entries.set(raw.row_address, { fingerprint: messageFingerprint(raw), receipt });
    if (this.entries.size > 128) this.entries.delete(this.entries.keys().next().value!);
  }
  decorate<T>(raw: T): T {
    if (!object(raw) || Object.hasOwn(raw, "spoken") || typeof raw.row_address !== "string") return raw;
    const entry = this.entries.get(raw.row_address);
    return entry?.fingerprint === messageFingerprint(raw) ? { ...raw, spoken: entry.receipt, _native_spoken_live: true } : raw;
  }
  clear(): void { this.entries.clear(); }
}

/** Historical host receipt, with no reconnect, playback, account or task authority. */
export class SpokenReceiptView {
  readonly widget = new Gtk.Expander({ child: column(4), visible: false });
  private closed = false;
  private readonly unwatch: () => void;
  private unbind = () => {};
  constructor(private readonly raw: unknown, private readonly historyMissing = false) { this.unwatch = watchNativeI18n(() => this.paint());this.paint(); }
  close(): void { if (this.closed) return;this.closed = true;this.unwatch();this.unbind(); }
  private paint(): void {
    if (this.closed) return;
    this.unbind();const content = this.widget.get_child();clear(content);
    let receipt: SpokenReceipt | undefined, invalid = false;
    try { receipt = readSpokenReceipt(this.raw); } catch { invalid = true; }
    this.widget.set_visible(invalid || Boolean(receipt) || this.historyMissing);
    if (!this.widget.visible) return;
    const title = invalid ? "Call speech receipt unavailable" : !receipt ? "Call speech · receipt not published in chat history" : receipt.status === "played" ? "Call speech · playback recorded"
      : receipt!.status === "generated" ? "Call speech · generated, playback unconfirmed" : receipt!.status === "interrupted" ? "Call speech · interrupted"
        : "Call speech · recorded status {status}";
    const params = receipt ? { status: receipt.status } : undefined;
    this.widget.set_label(chromeText(title, params));this.unbind = bindChrome(this.widget, "label", title, params);
    const heading = this.widget.get_label_widget();heading.set_wrap(true);heading.set_wrap_mode(Pango.WrapMode.WORD_CHAR);heading.set_max_width_chars(64);
    const fact = (source: string, value?: string | number) => {
      const field = label(chromeText(source, value === undefined ? undefined : { value }));field.set_selectable(true);
      field.set_wrap_mode(Pango.WrapMode.WORD_CHAR);field.set_max_width_chars(64);content.append(field);
    };
    if (invalid) { fact("Receipt metadata could not be read. The original message text remains available.");return; }
    if (!receipt) {
      fact("The original call text is retained. No playback state can be inferred from its words.");
      fact("The task event log may retain a speech receipt; it can be read from the task's events.");return;
    }
    if (object(this.raw) && this.raw._native_spoken_live === true) fact("Receipt retained from this client's live frame for this exact message; chat history did not publish it.");
    fact("Recorded call ID · {value}", receipt!.call_id);fact("Recorded speech item · {value}", receipt!.item_id);
    fact("Recorded speech state · {value}", receipt!.status);fact("Recorded playback acknowledgement · {value} ms", receipt!.played_ms);
    if (receipt!.status === "generated") fact("Speech was generated; playback is not confirmed by this receipt.");
    if (receipt!.status === "interrupted") fact("Speech was interrupted. The text is not a transcript of only the played portion.");
    fact("This recorded receipt does not prove that a person heard the words, that the call is live, or that the task completed.");
  }
}
