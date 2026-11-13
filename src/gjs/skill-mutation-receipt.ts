import { Gtk, Pango } from "./gi.js";
import { bindChrome, chromeText, watchNativeI18n } from "./native-i18n.js";
import { clear, column, label } from "./ui.js";
const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));
export type SkillMutation = "toggle" | "delete";
export interface SkillMutationReceipt {
  action: SkillMutation; skill: string; jobId?: string; enabled?: boolean;
  contentHash?: string; payloadRoot?: string; deletedState?: boolean; source?: string;
}
export function readSkillMutationReceipt(action: SkillMutation, skill: string, body: unknown, request: unknown): SkillMutationReceipt | undefined {
  if (!object(body) || !object(request) || body.ok !== undefined && body.ok !== true
    || body.skill !== undefined && body.skill !== skill
    || ["extension_action", "extension_reason", "load_error", "extension_load_error", "setup_error", "error", "message", "status"].some(key => body[key] !== undefined && body[key] !== null && typeof body[key] !== "string")
    || body.pending !== undefined && typeof body.pending !== "boolean") return undefined;
  if (action === "toggle" && typeof request.enabled !== "boolean") return undefined;
  if (action === "delete" && (typeof request.expected_content_hash !== "string" || !request.expected_content_hash
    || typeof request.payload_root !== "string" || !request.payload_root)) return undefined;
  if (body.pending === true) {
    if (body.ok !== true || typeof body.job_id !== "string" || !body.job_id.trim() || action === "toggle" && body.skill !== skill) return undefined;
    return { action, skill, jobId: body.job_id };
  }
  if (body.skill !== skill || body.error) return undefined;
  if (action === "toggle") {
    // The synchronous toggle envelope deliberately has no `ok`; its skill + boolean are the receipt.
    if (typeof request.enabled !== "boolean" || typeof body.enabled !== "boolean" || body.enabled !== request.enabled) return undefined;
    return { action, skill, enabled: body.enabled };
  }
  if (body.ok !== true || typeof request.expected_content_hash !== "string" || !request.expected_content_hash
    || body.content_hash !== request.expected_content_hash || typeof request.payload_root !== "string" || !request.payload_root
    || body.deleted_payload_root !== request.payload_root || typeof body.deleted_state !== "boolean" || typeof body.source !== "string") return undefined;
  return { action, skill, contentHash: body.content_hash as string, payloadRoot: body.deleted_payload_root as string, deletedState: body.deleted_state, source: body.source };
}
/** A checked response snapshot. Fresh installed state and lifecycle queue remain separate observations. */
export class SkillMutationReceiptView {
  readonly widget = new Gtk.Expander({ label: "Recorded skill mutation receipt", child: column(4), visible: false });
  private receipt?: SkillMutationReceipt;
  private closed = false;
  private readonly unwatch: () => void;
  private readonly unbind: () => void;
  constructor() {
    this.unbind = bindChrome(this.widget, "label", "Recorded skill mutation receipt");
    this.unwatch = watchNativeI18n(() => this.paint());
  }
  update(receipt?: SkillMutationReceipt): void { if (this.closed) return;this.receipt = receipt;this.paint(); }
  close(): void { if (this.closed) return;this.closed = true;this.unwatch();this.unbind(); }
  private paint(): void {
    if (this.closed) return;
    const body = this.widget.get_child();clear(body);this.widget.visible = Boolean(this.receipt);
    if (!this.receipt) return;
    const fact = (source: string, value?: string) => {
      const item = label(chromeText(source, value === undefined ? undefined : { value }));item.set_selectable(true);item.set_wrap_mode(Pango.WrapMode.WORD_CHAR);item.set_max_width_chars(64);body.append(item);
    };
    const r = this.receipt;
    fact("This receipt describes one request. Current installed state is read separately.");
    fact("Receipt skill · {value}", r.skill);
    fact(r.action === "toggle" ? "Receipt action · toggle" : "Receipt action · local delete");
    if (r.jobId) { fact("Admitted lifecycle job · {value}", r.jobId);fact("Admission is not completion. Follow the queue and read the skill again for the outcome.");return; }
    if (r.enabled !== undefined) fact(r.enabled ? "Receipt enabled · true" : "Receipt enabled · false");
    if (r.contentHash !== undefined) fact("Deleted revision · {value}", r.contentHash);
    if (r.payloadRoot !== undefined) fact("Deleted payload path · {value}", r.payloadRoot);
    if (r.deletedState !== undefined) fact(r.deletedState ? "Receipt deleted-state flag · true" : "Receipt deleted-state flag · false");
    if (r.source !== undefined) fact("Receipt payload source · {value}", r.source);
  }
}
