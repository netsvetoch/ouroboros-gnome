import { Gtk, Pango } from "./gi.js";
import type { Target } from "./accounts-quota.js";
import { bindChrome, chromeText, watchNativeI18n } from "./native-i18n.js";
import { clear, column, label } from "./ui.js";
const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));
interface Reply { snapshots: Record<string, unknown>[]; absences?: Record<string, unknown>[]; resources?: Record<string, unknown>[]; refreshed_at?: string; refresh_skipped?: unknown }
export function readQuotaRefresh(raw: unknown): Reply | undefined {
  if (!object(raw) || !Array.isArray(raw.snapshots) || !raw.snapshots.every(object)
    || ["absences", "resources"].some(key => raw[key] !== undefined && (!Array.isArray(raw[key]) || !(raw[key] as unknown[]).every(object)))
    || raw.refreshed_at !== undefined && typeof raw.refreshed_at !== "string") return undefined;
  return raw as unknown as Reply;
}
/** POST observation only. This view never promotes response rows to current quota or reset authority. */
export class QuotaRefreshView {
  readonly widget = new Gtk.Expander({ label: "Quota refresh response", visible: false, child: column(4) });
  private state: "idle" | "pending" | "received" | "failed" = "idle";
  private raw: unknown;
  private error = "";
  private closed = false;
  private readonly unwatch: () => void;
  private readonly unbind: () => void;
  constructor(private readonly target?: Target) {
    this.unbind = bindChrome(this.widget, "label", "Quota refresh response");
    this.unwatch = watchNativeI18n(() => this.paint());
  }
  begin(): void { if (this.closed) return;this.state = "pending";this.raw = undefined;this.error = "";this.paint(); }
  receive(raw: unknown): boolean { if (this.closed) return false;this.state = "received";this.raw = raw;this.paint();return Boolean(readQuotaRefresh(raw)); }
  fail(error: string): void { if (this.closed) return;this.state = "failed";this.raw = undefined;this.error = error;this.paint(); }
  close(): void { if (this.closed) return;this.closed = true;this.unwatch();this.unbind(); }
  private paint(): void {
    if (this.closed) return;
    this.widget.visible = this.state !== "idle";
    const body = this.widget.get_child();clear(body);
    const fact = (source: string, value?: string | number) => {
      const item = label(chromeText(source, value === undefined ? undefined : { value }));item.set_selectable(true);
      item.set_wrap_mode(Pango.WrapMode.WORD_CHAR);item.set_max_width_chars(64);body.append(item);
    };
    if (this.state === "idle") return;
    fact("This response is separate from current quota observations. It does not prove a provider check or a reset.");
    if (this.target) fact("Requested refresh account · {value}", `${this.target.harness} · ${this.target.profile_id}`);
    else fact("Requested refresh scope · all accounts");
    if (this.state === "pending") { fact("Waiting for the quota refresh response.");return; }
    if (this.state === "failed") { fact("Quota refresh response was not confirmed · {value}", this.error);return; }
    const reply = readQuotaRefresh(this.raw);
    if (!reply) { fact("The quota refresh response could not be read. Its rows were not applied to current quota.");return; }
    if (reply.refreshed_at !== undefined) fact("Reported refresh time · {value}", reply.refreshed_at);
    if (Object.hasOwn(reply, "refresh_skipped")) fact("Published refresh skip details · {value}", JSON.stringify(reply.refresh_skipped) ?? "undefined");
    else fact("No refresh skip details were published.");
    let omitted = 0;
    for (const [key, source] of [["snapshots", "Refresh response quota snapshot · {value}"], ["absences", "Refresh response absence · {value}"],
      ["resources", "Refresh response resources · {value}"]] as const) {
      const rows = reply[key];
      if (rows === undefined) continue;
      const selected = rows.filter(row => {
        if (!this.target) return true;
        const identity = key === "resources" ? row.target : row.subject;
        return object(identity) && identity.harness === this.target.harness
          && identity[key === "resources" ? "profile_id" : "subject_id"] === this.target.profile_id;
      });
      omitted += rows.length - selected.length;
      for (const row of selected) fact(source, JSON.stringify(row, null, 2));
      if (key === "snapshots" && !selected.length) fact("No matching quota snapshots were published in this response.");
    }
    if (omitted) fact("Response rows outside the requested account or without an exact account identity · {value}", omitted);
  }
}
