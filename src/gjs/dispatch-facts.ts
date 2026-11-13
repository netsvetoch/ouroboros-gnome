import { Gtk, Pango } from "./gi.js";
import { bindChrome, chromeText, watchNativeI18n } from "./native-i18n.js";
import { clear, column, label } from "./ui.js";

const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));
const effortKeys = ["effort_level", "effort_requested", "effort_source"] as const;
const coordinatorKeys = ["coordinator_route", "coordinator_billing", "coordinator_provenance"] as const;
const capacityCounts = ["active_subagent_count", "max_active_subagents"] as const;
const capacityFlags = ["queued_behind_active_cap", "worker_saturation_warning"] as const;
const cognitiveKeys = ["model", "effort", "source_role", "follows_role", "credential_profile_id", "processing_preference", "chosen_by", "supervisor_row", "supervisor_subagent_id"] as const;
export interface DispatchFacts {
  effort: Partial<Record<typeof effortKeys[number], string>>;
  coordinator: Partial<Record<typeof coordinatorKeys[number], string>> & { use_local_model?: boolean };
  cognitive?: Partial<Record<typeof cognitiveKeys[number], string>> & { schema?: number; use_local_model?: boolean; selected?: string[] };
  capacity: Partial<Record<typeof capacityCounts[number], number>> & Partial<Record<typeof capacityFlags[number], boolean>>;
  issues: string[]; present: boolean;
}
export function readDispatchFacts(raw: unknown): DispatchFacts {
  const result: DispatchFacts = { effort: {}, coordinator: {}, capacity: {}, issues: [], present: false };
  if (!object(raw)) return result;
  const scopes = [raw, raw.progress_meta, raw.metadata, raw.task_metadata].filter(object);
  const get = (key: string): unknown => {
    const scope = scopes.find(value => Object.hasOwn(value, key));
    if (scope) result.present = true;
    return scope?.[key];
  };
  for (const [keys, target] of [[effortKeys, result.effort], [coordinatorKeys, result.coordinator]] as const) for (const key of keys) {
    const value = get(key);
    if (value !== undefined && typeof value !== "string") result.issues.push(key);
    else if (typeof value === "string" && value.trim()) (target as Record<string, unknown>)[key] = value;
  }
  for (const key of capacityCounts) {
    const value = get(key);
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) result.capacity[key] = value;
    else if (value !== undefined) result.issues.push(key);
  }
  for (const key of capacityFlags) {
    const value = get(key);
    if (typeof value === "boolean") result.capacity[key] = value;
    else if (value !== undefined) result.issues.push(key);
  }
  const local = get("use_local_model");
  if (local !== undefined && typeof local !== "boolean") result.issues.push("use_local_model");
  else if (typeof local === "boolean") result.coordinator.use_local_model = local;
  const cognitive = get("parent_cognitive_route");
  if (cognitive !== undefined) {
    let valid = false;
    if (object(cognitive)) {
      valid = cognitiveKeys.every(key => cognitive[key] === undefined || typeof cognitive[key] === "string")
        && (cognitive.schema === undefined || typeof cognitive.schema === "number" && Number.isSafeInteger(cognitive.schema) && cognitive.schema > 0)
        && (cognitive.use_local_model === undefined || typeof cognitive.use_local_model === "boolean");
      const selected = cognitive.selected_supervisor_snapshot;
      valid = valid && (selected === undefined || object(selected) && ["handle", "selected_subagent_id"].every(key => selected[key] === undefined || typeof selected[key] === "string"));
      if (valid) {
        result.cognitive = {};
        for (const key of cognitiveKeys) if (typeof cognitive[key] === "string") result.cognitive[key] = cognitive[key];
        if (typeof cognitive.schema === "number") result.cognitive.schema = cognitive.schema;
        if (typeof cognitive.use_local_model === "boolean") result.cognitive.use_local_model = cognitive.use_local_model;
        if (object(selected)) result.cognitive.selected = [selected.handle, selected.selected_subagent_id].filter((v): v is string => typeof v === "string" && Boolean(v));
      }
    }
    if (!valid) result.issues.push("parent_cognitive_route");
  }
  return result;
}

/** Recorded dispatch choices. No inference from the child model, credentials or ledger. */
export class DispatchFactsView {
  readonly widget = new Gtk.Expander({ child: column(4), visible: false });
  private facts: DispatchFacts = readDispatchFacts(undefined);
  private closed = false;
  private readonly unwatch: () => void;
  private unbind = () => {};
  constructor(raw?: unknown) { this.unwatch = watchNativeI18n(() => this.paint());this.update(raw); }
  update(raw: unknown): void { if (this.closed) return;this.facts = readDispatchFacts(raw);this.paint(); }
  close(): void { if (this.closed) return;this.closed = true;this.unwatch();this.unbind(); }
  private paint(): void {
    if (this.closed) return;
    this.unbind();this.widget.set_label(chromeText("Recorded dispatch choices"));
    this.unbind = bindChrome(this.widget, "label", "Recorded dispatch choices");
    this.widget.set_visible(this.facts.present);
    const body = this.widget.get_child();clear(body);
    const fact = (source: string, value?: string | number, css?: string) => {
      const field = label(chromeText(source, value === undefined ? undefined : { value }), css);
      field.set_selectable(true);field.set_wrap_mode(Pango.WrapMode.WORD_CHAR);field.set_max_width_chars(64);body.append(field);
    };
    if (!this.facts.present) return;
    fact("Dispatch choices do not prove physical execution, an observed account, a charge or a current route.", undefined, "dim-label");
    if (this.facts.issues.length) fact("Some dispatch fields could not be read · {value}", this.facts.issues.join(", "), "warning");
    const { effort, coordinator, cognitive, capacity } = this.facts;
    if (Object.keys(capacity).length) {
      fact("Recorded scheduling capacity", undefined, "heading");
      fact("These observations describe scheduling time. They do not report current capacity or prove that execution started.", undefined, "dim-label");
      if (capacity.active_subagent_count !== undefined) fact("Active subagents at scheduling · {value}", capacity.active_subagent_count);
      if (capacity.max_active_subagents !== undefined) fact("Active-subagent limit at scheduling · {value}", capacity.max_active_subagents);
      if (capacity.queued_behind_active_cap !== undefined) fact(capacity.queued_behind_active_cap
        ? "Queued behind the active-subagent limit at scheduling · true" : "Queued behind the active-subagent limit at scheduling · false");
      if (capacity.worker_saturation_warning !== undefined) fact(capacity.worker_saturation_warning
        ? "All worker slots busy at scheduling · true" : "All worker slots busy at scheduling · false");
    }
    for (const [key, source] of [["effort_level", "Applied dispatch effort · {value}"], ["effort_requested", "Requested dispatch effort · {value}"],
      ["effort_source", "Effort decision source · {value}"]] as const) if (effort[key]) fact(source, effort[key]);
    if (!effort.effort_level && (effort.effort_requested || effort.effort_source)) fact("Applied dispatch effort is not published.", undefined, "dim-label");
    for (const [key, source] of [["coordinator_route", "Recorded coordinator route · {value}"], ["coordinator_billing", "Recorded coordinator billing basis · {value}"],
      ["coordinator_provenance", "Recorded coordinator provenance · {value}"]] as const) if (coordinator[key]) fact(source, coordinator[key]);
    if (coordinator.use_local_model !== undefined) fact(coordinator.use_local_model ? "Recorded coordinator local-model flag · true" : "Recorded coordinator local-model flag · false");
    if (cognitive) {
      fact("Captured parent cognitive route", undefined, "heading");
      if (cognitive.schema !== undefined) fact("Captured route schema · {value}", cognitive.schema);
      for (const [key, source] of [["model", "Captured parent model · {value}"], ["effort", "Captured parent effort · {value}"],
        ["source_role", "Captured source role · {value}"], ["follows_role", "Captured following role · {value}"],
        ["processing_preference", "Captured processing preference · {value}"], ["chosen_by", "Captured route chosen by · {value}"],
        ["supervisor_row", "Captured supervisor row · {value}"], ["supervisor_subagent_id", "Captured supervisor subagent · {value}"]] as const) if (cognitive[key]) fact(source, cognitive[key]);
      if (cognitive.credential_profile_id !== undefined) {
        if (cognitive.credential_profile_id) fact("Captured account intent · {value}", cognitive.credential_profile_id);
        else fact("Captured account intent · Automatic (no observed account claim)");
      }
      if (cognitive.use_local_model !== undefined) fact(cognitive.use_local_model ? "Captured parent local-model flag · true" : "Captured parent local-model flag · false");
      for (const value of cognitive.selected ?? []) fact("Captured selected supervisor · {value}", value);
    }
  }
}
