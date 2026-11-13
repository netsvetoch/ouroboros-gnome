import { Gtk, Pango } from "./gi.js";
import { bindChrome, chromeText, watchNativeI18n } from "./native-i18n.js";
import { readSkillLifecycleQueue, type SkillLifecycleJob } from "./skill-lifecycle-view.js";
import { button, clear, column, label } from "./ui.js";
import { exactWorkTarget } from "./work-actions.js";

const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));
function payload(row: unknown, key: string): unknown {
  if (!object(row)) return undefined;
  if (Object.hasOwn(row, key)) return row[key];
  return object(row.progress_meta) ? row.progress_meta[key] : undefined;
}
/** Presence suppresses synthetic stream navigation even when its metadata cannot be read. */
export function skillProgressRow(row: unknown): boolean {
  return payload(row, "lifecycle") !== undefined || payload(row, "lifecycle_pointer") !== undefined;
}
export interface SkillProgress { pointer: boolean; job: SkillLifecycleJob; phase?: string }
export function readSkillProgress(row: unknown): SkillProgress | undefined {
  const progress = payload(row, "lifecycle"), pointer = payload(row, "lifecycle_pointer");
  if (progress === undefined && pointer === undefined) return undefined;
  if (progress !== undefined && pointer !== undefined) throw new Error("Ambiguous skill operation metadata");
  const value = pointer ?? progress;
  if (!object(value) || pointer !== undefined && (typeof value.job_id !== "string" || !value.job_id)
    || value.phase !== undefined && typeof value.phase !== "string") throw new Error("Unreadable skill operation metadata");
  const job = readSkillLifecycleQueue({ active: null, events: [{ ...value, id: pointer !== undefined ? value.job_id : value.id }] }).events[0];
  if (pointer === undefined && object(row) && typeof row.task_id === "string" && row.task_id) job.chat_task_id = row.task_id;
  return { pointer: pointer !== undefined, job, phase: typeof value.phase === "string" ? value.phase : undefined };
}
/** Live frames and durable history rows use different row addresses for the same observation. */
export function skillProgressIdentity(row: unknown): string | undefined {
  try {
    const entry = readSkillProgress(row);
    if (entry) return JSON.stringify([entry.pointer, entry.job.id, entry.job.status, entry.phase ?? ""]);
  } catch { /* Malformed metadata has no shared presentation identity. */ }
  return undefined;
}

/** A recorded chat observation, never a live queue authority or a review verdict. */
export class SkillProgressView {
  readonly widget = new Gtk.Expander({ child: column(4) });
  private closed = false;
  private generation = 0;
  private releases: (() => void)[] = [];
  private readonly unwatch: () => void;
  constructor(private readonly raw: unknown, private readonly openTask?: (task: string) => void,
    private readonly openReviews?: (task: string) => void) {
    this.unwatch = watchNativeI18n(() => this.paint());this.paint();
  }
  get rawMessage(): unknown { return this.raw; }
  close(): void { if (this.closed) return;this.closed = true;this.generation++;this.unwatch();this.release(); }
  private release(): void { for (const release of this.releases.splice(0)) release(); }
  private paint(): void {
    if (this.closed) return;
    this.release();this.generation++;const generation = this.generation, body = this.widget.get_child();clear(body);
    const fact = (english: string, params?: Record<string, string | number>, css?: string) => {
      const field = label(chromeText(english, params), css);field.set_selectable(true);
      field.set_wrap_mode(Pango.WrapMode.WORD_CHAR);field.set_max_width_chars(64);body.append(field);
    };
    let entry: SkillProgress | undefined;
    try { entry = readSkillProgress(this.raw); } catch { /* Original chat text remains readable. */ }
    const heading = entry?.pointer ? "Existing skill operation reference" : "Skill operation observation";
    this.widget.set_label(chromeText(heading));this.releases.push(bindChrome(this.widget, "label", heading));
    if (!entry) { fact("Skill operation metadata could not be read. No task or review links are offered.", undefined, "warning");return; }
    const { job, pointer, phase } = entry;
    fact(pointer ? "This request refers to an existing operation. Progress belongs to its original chat; no second operation is confirmed here."
      : "State recorded in this message; current queue state and a review verdict are separate facts.", undefined, "dim-label");
    for (const [english, value] of [["Operation ID · {value}", job.id], ["Skill · {value}", job.target],
      ["Operation kind · {value}", job.kind], ["Recorded operation state · {value}", job.status],
      ["Recorded operation phase · {value}", phase], ["Operation source · {value}", job.source],
      ["Operation group · {value}", job.group_id], ["Deduplication key · {value}", job.dedupe_key],
      ["Queued at · {value}", job.queued_at], ["Started at · {value}", job.started_at], ["Finished at · {value}", job.finished_at],
      ["Operation message · {value}", job.message], ["Operation error · {value}", job.error],
      ["Stale observation reason · {value}", job.stale_reason], ["Gateway recovery hint · {value}", job.recovery_hint],
      ["Progress stream identifier · {value}", job.chat_task_id]] as const) if (value) fact(english, { value });
    if (job.chat_id !== undefined) fact(job.chat_id === 0 ? "Progress chat · Skill Review panel ({n})" : job.chat_id === 1 ? "Progress chat · Main ({n})" : "Progress chat · {n}", { n: job.chat_id });
    if (job.age_seconds !== undefined) fact("Published age · {n} s", { n: job.age_seconds });
    if (job.stale === true) fact("The gateway marked this observation stale.", undefined, "warning");
    const action = (english: string, id: string, run: (id: string) => void) => body.append(button(chromeText(english, { id }), () => {
      if (!this.closed && generation === this.generation) run(id);
    }));
    for (const [key, caption] of [["task_id", "Operation task · {value}"], ["root_task_id", "Operation root task · {value}"],
      ["origin_task_id", "Initiating task · {value}"], ["origin_root_task_id", "Initiating root task · {value}"],
      ["presentation_owner_task_id", "Presentation owner task · {value}"]] as const) if (job[key]) {
      const id = job[key]!;fact(caption, { value: id });
      if (this.openTask && exactWorkTarget(id)) action("Open task · {id}", id, this.openTask);
    }
    if (this.openReviews && job.kind === "review" && job.group_id && exactWorkTarget(job.presentation_owner_task_id)) {
      action("Read current task reviews · {id}", job.presentation_owner_task_id, this.openReviews);
    }
  }
}
