import { Gtk, Pango } from "./gi.js";
import { bindChrome, chromeText, watchNativeI18n } from "./native-i18n.js";
import { clear, column, label } from "./ui.js";

const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));
const strings = ["error", "code", "detail", "skill", "source", "content_hash", "review_status", "deps_status", "process", "server_reconcile"] as const;
const nullable = ["extension_action", "extension_reason", "load_error"] as const;
const lists = ["allowed_keys", "allowed_permissions", "rejected_items"] as const;
const flags = ["ok", "review_stale", "executable_review", "enabled"] as const;
const documents = ["review_gate", "grants", "conflict"] as const;
export function readSkillActionRefusal(raw: unknown, skill: string): Record<string, unknown> | undefined {
  if (!object(raw) || typeof raw.error !== "string" || !raw.error.trim() || raw.ok === true
    || raw.skill !== undefined && raw.skill !== skill
    || strings.some(key => raw[key] !== undefined && typeof raw[key] !== "string")
    || nullable.some(key => raw[key] !== undefined && raw[key] !== null && typeof raw[key] !== "string")
    || flags.some(key => raw[key] !== undefined && typeof raw[key] !== "boolean")
    || lists.some(key => raw[key] !== undefined && (!Array.isArray(raw[key]) || !(raw[key] as unknown[]).every(value => typeof value === "string")))
    || documents.some(key => raw[key] !== undefined && !object(raw[key]))
    || raw.status_code !== undefined && !(Number.isInteger(raw.status_code) && Number(raw.status_code) >= 400 && Number(raw.status_code) <= 599)) return undefined;
  return Object.fromEntries([...strings, ...nullable, ...lists, ...flags, ...documents, "status_code"].filter(key => Object.hasOwn(raw, key)).map(key => [key, raw[key]]));
}

/** An operation response snapshot, independent of the installed-skill index and its controls. */
export class SkillActionRefusalView {
  readonly widget = new Gtk.Expander({ label: "Skill action response details", visible: false, child: column(4) });
  private raw: unknown;
  private status?: number;
  private path?: string;
  private closed = false;
  private readonly unwatch: () => void;
  private readonly unbind: () => void;
  constructor(private readonly skill: string) {
    this.unbind = bindChrome(this.widget, "label", "Skill action response details");
    this.unwatch = watchNativeI18n(() => this.paint());
  }
  update(raw?: unknown, status?: number, path?: string): void { if (this.closed) return;this.raw = raw;this.status = status;this.path = path;this.paint(); }
  close(): void { if (this.closed) return;this.closed = true;this.unwatch();this.unbind(); }
  private paint(): void {
    if (this.closed) return;
    this.widget.visible = this.raw !== undefined || this.status !== undefined;
    const body = this.widget.get_child();clear(body);
    if (this.raw === undefined && this.status === undefined) return;
    const fact = (source: string, value?: string | number) => {
      const item = label(chromeText(source, value === undefined ? undefined : { value }));item.set_selectable(true);
      item.set_wrap_mode(Pango.WrapMode.WORD_CHAR);item.set_max_width_chars(64);body.append(item);
    };
    fact("These details belong to one action response. They do not confirm whether the skill changed. Read the installed skill again before choosing another action.");
    if (this.path !== undefined) fact("Request endpoint · {value}", this.path);
    if (this.status !== undefined) fact("HTTP response · {value}", this.status);
    const data = readSkillActionRefusal(this.raw, this.skill);
    if (!data) { fact("The skill action refusal could not be read. No response facts were applied to the installed skill.");return; }
    if (data.status_code !== undefined) fact("Declared response status · {value}", data.status_code as number);
    for (const [key, source] of [["error", "Response error · {value}"], ["code", "Refusal code · {value}"], ["detail", "Refusal detail · {value}"],
      ["skill", "Response skill · {value}"], ["source", "Response source · {value}"], ["content_hash", "Response content hash · {value}"],
      ["review_status", "Response review status · {value}"], ["deps_status", "Response dependency status · {value}"],
      ["extension_action", "Response extension action · {value}"], ["extension_reason", "Response extension reason · {value}"],
      ["process", "Response process · {value}"], ["server_reconcile", "Response reconciliation · {value}"], ["load_error", "Response load error · {value}"]] as const) {
      if (data[key] !== undefined) fact(source, data[key] === null ? "null" : data[key] as string);
    }
    for (const [key, source] of [["allowed_keys", "Allowed keys in this response · {value}"], ["allowed_permissions", "Allowed permissions in this response · {value}"],
      ["rejected_items", "Rejected items in this response · {value}"], ["review_stale", "Response review stale · {value}"],
      ["executable_review", "Response executable review · {value}"], ["enabled", "Response enabled · {value}"],
      ["review_gate", "Response review gate · {value}"], ["grants", "Response grants · {value}"], ["conflict", "Response conflict · {value}"]] as const) {
      if (data[key] !== undefined) fact(source, JSON.stringify(data[key], null, 2));
    }
  }
}
