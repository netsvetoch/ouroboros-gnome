import { Gtk, Pango } from "./gi.js";
import { bindChrome, chromeText, watchNativeI18n } from "./native-i18n.js";
import { button, clear, column, label } from "./ui.js";
const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));
const number = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const waitLabels = {
  usage_lock_wait: ["Waiting for accounting access", "Accounting wait ended", "Accounting waits"],
  control_store_wait: ["Waiting for control storage", "Control storage wait ended", "Control storage waits"],
} as const;
type WaitKind = keyof typeof waitLabels;
interface Episode { ended: boolean; elapsed: number | null }
export interface CheckpointEntry { event: Record<string, unknown>; epoch: number; source?: string }
const captions: Record<string, string> = {
  context_fit_low_retry: "Books shown as chapter navigation during context-size recovery",
  context_fit_refused: "Context-size check found no room for results", context_fit_route_rebound: "Context fit rebound the route",
  context_fit_physical_mode: "Context starts in a smaller mode (window too small)", context_view: "Context inspected",
  context_reclaim_emergency: "Context shrunk during context-size recovery (no model)",
  context_memory_coarsened: "Memory shown coarser during context-size recovery", context_view_renewed: "Working view renewed: same task, fresh window",
  context_reclaim_manual: "Context reclaimed on request", context_reclaim_automatic: "Context reclaimed automatically",
  prompt_prefix_break: "Prompt prefix rebuilt", cost_budget_milestone: "Cost budget milestone", cost_budget_wrapup: "Cost budget wrap-up",
  time_budget_milestone: "Time budget milestone", intrinsic_pacing: "Pacing check", nanny_economics_reminder: "Economics reminder",
  nanny_finalization_nudge: "Finalization nudge", budget_scope_paused: "Budget scope paused", budget_pause_hold: "Budget pause hold",
  services_stopped: "Background services stopped", services_kept: "Background services kept", service_finalization_error: "Background service cleanup unconfirmed",
  forced_candidate_drift: "Forced candidate drifted",
};
export function checkpointData(event: unknown): Record<string, unknown> | undefined {
  if (!object(event)) return;
  const data = object(event.data) ? event.data : event;
  if (event.type === "task_checkpoint" || data.type === "task_checkpoint" || data.system_type === "task_checkpoint") return data;
}
export function checkpointLabel(data: Record<string, unknown>): string {
  const kind = typeof data.checkpoint_kind === "string" ? data.checkpoint_kind : "";
  if (Object.hasOwn(waitLabels, kind)) return chromeText(waitLabels[kind as WaitKind][data.phase === "ended" ? 1 : 0]);
  if (!kind && number(data.checkpoint_number) && Number.isSafeInteger(data.checkpoint_number) && data.checkpoint_number > 0) return chromeText("Checkpoint {n} · periodic self-check", { n: data.checkpoint_number });
  if (kind === "context_reclaim_emergency" && data.cause === "output_exhaustion") return chromeText("Source-address recovery after empty length-limited replies (no model)");
  if (kind === "context_view" && data.status === "applied" && number(data.reclaimed_tokens) && Number.isSafeInteger(data.reclaimed_tokens) && data.reclaimed_tokens > 0) return chromeText("Context folded · {n} tokens reclaimed", { n: data.reclaimed_tokens });
  const retired = data.reasoning_retired;
  if (kind === "prompt_prefix_break" && object(retired) && number(retired.turns) && Number.isSafeInteger(retired.turns)) return chromeText("Earlier reasoning not replayed · {n} turns", { n: retired.turns });
  return Object.hasOwn(captions, kind) ? chromeText(captions[kind]) : kind ? chromeText("Checkpoint · {kind}", { kind }) : chromeText("Task checkpoint");
}
export function waitEpisode(data: Record<string, unknown>): { kind: WaitKind; id: string; ended: boolean; elapsed: number | null } | undefined {
  if (typeof data.checkpoint_kind !== "string" || !Object.hasOwn(waitLabels, data.checkpoint_kind)
    || typeof data.episode_id !== "string" || !data.episode_id.trim() || (typeof data.phase !== "string" || !["entered", "ended"].includes(data.phase))) return;
  return { kind: data.checkpoint_kind as WaitKind, id: data.episode_id, ended: data.phase === "ended", elapsed: number(data.elapsed_sec) ? data.elapsed_sec : null };
}
function seconds(s: number): string {
  if (s < 10) return `${s.toFixed(1)} s`;
  const whole = Math.round(s);
  return whole < 60 ? `${whole} s` : `${Math.floor(whole / 60)} min${whole % 60 ? ` ${whole % 60} s` : ""}`;
}
export function waitFoldLine(kind: WaitKind, episodes: Map<string, Episode>): string {
  const closed = [...episodes.values()].filter(episode => episode.ended), known = closed.flatMap(episode => episode.elapsed === null ? [] : [episode.elapsed]);
  const longest = known.length ? seconds(Math.max(...known)) : "", captions = waitLabels[kind];
  const done = closed.length === 1 ? [chromeText(captions[1]), longest].filter(Boolean).join(" · ")
    : closed.length ? chromeText("{caption} ×{n}", { caption: chromeText(captions[2]), n: closed.length })
      + (longest ? " · " + chromeText("longest {duration}", { duration: longest }) : "") : "";
  return [closed.length < episodes.size ? chromeText(captions[0]) : "", done].filter(Boolean).join(" · ");
}

export class TaskCheckpointsView {
  readonly widget = new Gtk.Expander({ child: column(5), visible: false });
  private entries: CheckpointEntry[] = [];
  private epoch = 0;
  private trimmed = false;
  private closed = false;
  private generation = 0;
  private readonly expanded = new Set<string>();
  private readonly unwatch: () => void;
  private unbind = () => {};
  constructor(private readonly open?: (event: Record<string, unknown>, title: string) => void) {
    this.unwatch = watchNativeI18n(() => this.paint());
  }
  update(entries: CheckpointEntry[], epoch = 0, trimmed = false): void {
    if (this.closed) return;this.entries = entries;this.epoch = epoch;this.trimmed = trimmed;this.paint();
  }
  close(): void { if (this.closed) return;this.closed = true;this.generation++;this.unwatch();this.unbind(); }
  private paint(): void {
    if (this.closed) return;this.generation++;const generation = this.generation;
    this.unbind();this.widget.set_label(chromeText("Task checkpoints and host waits"));this.unbind = bindChrome(this.widget, "label", "Task checkpoints and host waits");
    const body = this.widget.get_child();clear(body);
    const records = this.entries.flatMap(entry => { const data = checkpointData(entry.event);return data ? [{ entry, data }] : []; });
    this.widget.set_visible(records.length > 0);if (!records.length) { this.expanded.clear();return; }
    const fact = (target: any, source: string, params?: Record<string, string | number>, css?: string) => {
      const field = label(chromeText(source, params), css);field.set_selectable(true);field.set_wrap_mode(Pango.WrapMode.WORD_CHAR);field.set_max_width_chars(64);target.append(field);
    };
    fact(body, "Only checkpoint observations in the retained, selected event window are shown. Host waits do not prove task progress, current liveness or completion.", undefined, "dim-label");
    if (this.trimmed) fact(body, "Earlier events are outside the retained window; episode totals are partial.", undefined, "warning");
    const activeKeys = new Set<string>();
    const panel = (key: string, title: string, content: any) => {
      activeKeys.add(key);
      const widget = new Gtk.Expander({ label: title, child: content, expanded: this.expanded.has(key) });
      const heading = widget.get_label_widget();heading.set_wrap(true);heading.set_wrap_mode(Pango.WrapMode.WORD_CHAR);heading.set_max_width_chars(64);
      widget.connect("notify::expanded", () => {
        if (this.closed || generation !== this.generation) return;
        if (widget.expanded) this.expanded.add(key);else this.expanded.delete(key);
      });body.append(widget);return widget;
    };
    const folds = new Map<string, { kind: WaitKind; task: string; epoch: number; episodes: Map<string, Episode>; sources: CheckpointEntry[]; invalidElapsed: boolean }>();
    const ordinary = new Map<string, { entry: CheckpointEntry; data: Record<string, unknown> }>();
    let invalidWaits = 0;
    for (const record of records) {
      const { entry, data } = record, task = typeof entry.event.task_id === "string" ? entry.event.task_id : typeof data.task_id === "string" ? data.task_id : "";
      const episode = waitEpisode(data);
      if (episode && task.trim()) {
        const key = JSON.stringify([entry.epoch, task, episode.kind]);
        const fold = folds.get(key) ?? { kind: episode.kind, task, epoch: entry.epoch, episodes: new Map<string, Episode>(), sources: [], invalidElapsed: false };
        const previous = fold.episodes.get(episode.id);
        fold.episodes.set(episode.id, { ended: Boolean(previous?.ended) || episode.ended, elapsed: episode.ended ? episode.elapsed : previous?.elapsed ?? null });
        fold.sources.push(entry);fold.invalidElapsed ||= data.elapsed_sec !== undefined && data.elapsed_sec !== null && !number(data.elapsed_sec);folds.set(key, fold);
      } else {
        if (typeof data.checkpoint_kind === "string" && Object.hasOwn(waitLabels, data.checkpoint_kind)) invalidWaits++;
        const identity = JSON.stringify([entry.epoch, task, data.ts ?? entry.event.ts, data.checkpoint_kind, data.phase, data.round, data.checkpoint_number, data.budget_axis, data.milestone]);
        ordinary.set(identity, record);
      }
    }
    if (invalidWaits) fact(body, "Wait episode identity, task or phase could not be read · {n} source rows", { n: invalidWaits }, "warning");
    const sourceButton = (target: any, entry: CheckpointEntry) => {
      if (!this.open) return;
      target.append(button(chromeText("Open checkpoint source event…"), () => { if (!this.closed && generation === this.generation) this.open?.(entry.event, checkpointLabel(checkpointData(entry.event)!)); }));
    };
    for (const [key, fold] of folds) {
      const content = column(4);panel("wait:" + key, waitFoldLine(fold.kind, fold.episodes), content);
      if (fold.epoch < this.epoch) fact(content, "Previous event read", undefined, "dim-label");
      if (fold.task) fact(content, "Checkpoint task · {value}", { value: fold.task });
      if (fold.invalidElapsed) fact(content, "Some wait durations could not be read; they are not zero.", undefined, "warning");
      for (const [id, episode] of fold.episodes) {
        fact(content, episode.ended ? "Ended wait episode · {value}" : "Open wait episode observed · {value}", { value: id });
        if (episode.ended) fact(content, episode.elapsed === null ? "Episode duration is not published." : "Recorded episode duration · {value} s", episode.elapsed === null ? undefined : { value: episode.elapsed });
      }
      sourceButton(content, fold.sources.at(-1)!);
    }
    for (const [key, { entry, data }] of ordinary) {
      const content = column(4);panel("checkpoint:" + key, checkpointLabel(data), content);
      if (entry.epoch < this.epoch) fact(content, "Previous event read", undefined, "dim-label");
      const task = entry.event.task_id ?? data.task_id;
      if (typeof task === "string" && task) fact(content, "Checkpoint task · {value}", { value: task });
      const invalid: string[] = [];
      const bounds: Record<string, string> = { in_task_cost_ceiling: "Cost ceiling", whole_work_allowance: "Whole-work cost allowance", hard_tree_cap: "Task tree cost cap", shared_wallet: "Shared wallet" };
      if (typeof data.budget_axis === "string" && Object.hasOwn(bounds, data.budget_axis)) fact(content, bounds[data.budget_axis], undefined, "heading");
      if (data.spend_basis === "own_fallback_tree_unknown") fact(content, "Own-call spend is a lower bound while task-tree spend is unknown.", undefined, "dim-label");
      if (data.reasoning_retired !== undefined && data.reasoning_retired !== null) {
        const retired = data.reasoning_retired;
        if (!object(retired) || !number(retired.turns) || !Number.isSafeInteger(retired.turns)) invalid.push("reasoning_retired");
        else fact(content, "Recorded retired reasoning turns · {value}", { value: retired.turns });
      }
      for (const [key, source] of [["checkpoint_kind", "Recorded checkpoint kind · {value}"], ["phase", "Recorded checkpoint phase · {value}"],
        ["status", "Recorded checkpoint status · {value}"], ["episode_id", "Wait episode ID · {value}"], ["cause", "Checkpoint cause · {value}"],
        ["reason", "Checkpoint reason · {value}"], ["detail", "Checkpoint detail · {value}"], ["budget_axis", "Budget bound · {value}"],
        ["milestone", "Budget threshold · {value}"], ["spend_basis", "Recorded spend basis · {value}"], ["model", "Checkpoint model · {value}"]] as const) {
        if (data[key] !== undefined && typeof data[key] !== "string") invalid.push(key);
        else if (typeof data[key] === "string" && data[key]) fact(content, source, { value: data[key] as string });
      }
      for (const [key, source] of [["checkpoint_number", "Checkpoint number · {value}"], ["round", "Checkpoint round · {value}"],
        ["elapsed_sec", "Recorded elapsed seconds · {value}"], ["reclaimed_tokens", "Recorded reclaimed tokens · {value}"],
        ["base_usd", "Recorded budget base · {value} USD"], ["deciding_spend_usd", "Recorded deciding spend · {value} USD"],
        ["wallet_baseline_usd", "Recorded wallet baseline · {value} USD"], ["wallet_remaining_known_usd", "Recorded known wallet remainder · {value} USD"]] as const) {
        if (data[key] === undefined || data[key] === null) continue;
        if (typeof data[key] !== "number" || !Number.isFinite(data[key]) || key !== "wallet_remaining_known_usd" && !number(data[key])
          || ["checkpoint_number", "round", "reclaimed_tokens"].includes(key) && !Number.isSafeInteger(data[key])) invalid.push(key);
        else fact(content, source, { value: data[key] as number });
      }
      if (invalid.length) fact(content, "Checkpoint fields could not be read · {value}", { value: invalid.join(", ") }, "warning");
      sourceButton(content, entry);
    }
    for (const key of this.expanded) if (!activeKeys.has(key)) this.expanded.delete(key);
  }
}
