import { Gtk, Pango } from "./gi.js";
import { bindChrome, chromeText, watchNativeI18n } from "./native-i18n.js";
import { button, clear, column, label } from "./ui.js";
import { exactWorkTarget } from "./work-actions.js";

export interface SkillLifecycleJob {
  id: string; kind: string; target: string; status: string;
  source?: string; message?: string; error?: string; dedupe_key?: string;
  chat_id?: number; group_id?: string; task_id?: string; root_task_id?: string;
  origin_task_id?: string; origin_root_task_id?: string; presentation_owner_task_id?: string; chat_task_id?: string;
  queued_at?: string; started_at?: string; finished_at?: string; age_seconds?: number;
  stale?: boolean; stale_reason?: string; recovery_hint?: string;
}
export interface SkillLifecycleQueue { active: SkillLifecycleJob | null; events: SkillLifecycleJob[] }
const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));
const strings = ["source", "message", "error", "dedupe_key", "group_id", "task_id", "root_task_id", "origin_task_id", "origin_root_task_id",
  "presentation_owner_task_id", "chat_task_id", "queued_at", "started_at", "finished_at", "stale_reason", "recovery_hint"] as const;
function job(v: unknown): v is SkillLifecycleJob {
  return object(v) && ["id", "kind", "target", "status"].every(key => typeof v[key] === "string" && v[key])
    && strings.every(key => v[key] === undefined || typeof v[key] === "string")
    && (v.chat_id === undefined || typeof v.chat_id === "number" && Number.isSafeInteger(v.chat_id))
    && (v.age_seconds === undefined || typeof v.age_seconds === "number" && Number.isFinite(v.age_seconds) && v.age_seconds >= 0)
    && (v.stale === undefined || typeof v.stale === "boolean");
}
export function readSkillLifecycleQueue(raw: unknown): SkillLifecycleQueue {
  if (!object(raw) || !Array.isArray(raw.events) || !raw.events.every(job) || !(raw.active === null || job(raw.active))
    || new Set(raw.events.map(row => row.id)).size !== raw.events.length) throw new Error("Skill lifecycle queue details could not be read.");
  const previous = raw.events.find(row => row.id === (raw.active as SkillLifecycleJob | null)?.id);
  if (previous && raw.active && (previous.target !== raw.active.target || previous.kind !== raw.active.kind)) throw new Error("Skill lifecycle job identity is inconsistent.");
  return raw as unknown as SkillLifecycleQueue;
}
export const skillJobSettled = (status: string): boolean => ["succeeded", "failed", "cancelled"].includes(status);
export function lifecycleJobs(queue: SkillLifecycleQueue): SkillLifecycleJob[] {
  const jobs = new Map(queue.events.map(row => [row.id, row]));
  if (queue.active && !skillJobSettled(jobs.get(queue.active.id)?.status ?? "")) jobs.set(queue.active.id, queue.active);
  return [...jobs.values()];
}

export class SkillLifecycleQueueView {
  readonly widget = new Gtk.Expander({ child: column(5) });
  private snapshot?: SkillLifecycleQueue;
  private stale = false;
  private issue = "";
  private closed = false;
  private generation = 0;
  private readonly expanded = new Set<string>();
  private readonly rows = new Map<string, any>();
  private readonly unwatch: () => void;
  private unbind = () => {};
  constructor(private readonly openTask?: (task: string) => void) {
    this.unwatch = watchNativeI18n(() => this.paint());this.paint();
  }
  update(queue: SkillLifecycleQueue): void {
    if (this.closed) return;
    this.snapshot = queue;this.stale = false;this.issue = "";this.generation++;this.paint();
  }
  unavailable(issue: string): void {
    if (this.closed) return;
    this.stale = true;this.issue = issue;this.generation++;this.paint();
  }
  close(): void { if (this.closed) return;this.closed = true;this.generation++;this.unwatch();this.unbind(); }
  private paint(): void {
    if (this.closed) return;
    this.unbind();const body = this.widget.get_child();clear(body);this.rows.clear();
    const jobs = this.snapshot ? lifecycleJobs(this.snapshot).toReversed() : [];
    if (!this.stale && this.snapshot) for (const id of this.expanded) if (!jobs.some(job => job.id === id)) this.expanded.delete(id);
    const count = jobs.filter(job => ["queued", "running"].includes(job.status)).length;
    this.widget.set_label(chromeText("Skill operations · active {n}", { n: count }, `Операции с навыками · в работе ${count}`));
    this.unbind = bindChrome(this.widget, "label", "Skill operations · active {n}", { n: count });
    const fact = (target: any, english: string, russian: string, params?: Record<string, string | number>, css?: string) => {
      const field = label(chromeText(english, params, russian), css);field.set_selectable(true);
      field.set_wrap_mode(Pango.WrapMode.WORD_CHAR);field.set_max_width_chars(64);target.append(field);
    };
    fact(body, "Recent operations are kept in gateway memory; an absent job has no confirmed outcome here.",
      "Недавние операции хранятся в памяти шлюза; отсутствие операции здесь не подтверждает её исход.", undefined, "dim-label");
    if (this.stale) fact(body, "Queue read failed. Previous observations are shown without navigation.",
      "Очередь прочитать не удалось. Показаны прежние сведения без переходов.", undefined, "warning");
    if (this.issue) fact(body, "Queue read detail · {value}", `Сведения об ошибке чтения · ${this.issue}`, { value: this.issue });
    if (!this.snapshot) { fact(body, "Queue observations are unavailable.", "Сведения очереди недоступны.");return; }
    if (!jobs.length) fact(body, "No recent operations are published.", "Недавние операции не опубликованы.");
    const generation = this.generation;
    for (const job of jobs) {
      const content = column(4), panel = new Gtk.Expander({ label: `${job.target} · ${job.kind} · ${job.status}`, child: content, expanded: this.expanded.has(job.id) });
      const heading = panel.get_label_widget();heading.set_wrap(true);heading.set_wrap_mode(Pango.WrapMode.WORD_CHAR);heading.set_max_width_chars(64);
      this.rows.set(job.id, panel);body.append(panel);
      const fill = () => {
      clear(content);
      fact(content, "Operation ID · {value}", `Идентификатор операции · ${job.id}`, { value: job.id });
      fact(content, "Recorded operation state · {value}", `Записанное состояние операции · ${job.status}`, { value: job.status });
      for (const [key, english, russian] of [["source", "Operation source · {value}", "Источник операции"],
        ["queued_at", "Queued at · {value}", "Поставлена в очередь"], ["started_at", "Started at · {value}", "Начало"],
        ["finished_at", "Finished at · {value}", "Завершение"], ["group_id", "Operation group · {value}", "Группа операций"],
        ["dedupe_key", "Deduplication key · {value}", "Ключ объединения запросов"], ["message", "Operation message · {value}", "Сообщение операции"],
        ["error", "Operation error · {value}", "Ошибка операции"], ["stale_reason", "Stale observation reason · {value}", "Причина устаревания"],
        ["recovery_hint", "Gateway recovery hint · {value}", "Подсказка шлюза для восстановления"],
        ["chat_task_id", "Progress stream identifier · {value}", "Идентификатор потока сообщений"]] as const) {
        if (job[key]) fact(content, english, `${russian} · ${job[key]}`, { value: job[key]! });
      }
      if (job.age_seconds !== undefined) fact(content, "Published age · {n} s", `Опубликованный возраст · ${job.age_seconds} с`, { n: job.age_seconds });
      if (job.stale === true) fact(content, "The gateway marks this operation stale; its outcome remains as recorded.",
        "Шлюз пометил операцию устаревшей; её исход остаётся записанным состоянием.", undefined, "warning");
      if (job.chat_id !== undefined) fact(content, job.chat_id === 0 ? "Progress chat · Skill Review panel ({n})" : job.chat_id === 1 ? "Progress chat · Main ({n})" : "Progress chat · {n}",
        `Чат сообщений · ${job.chat_id === 0 ? "Панель проверки навыков · " : job.chat_id === 1 ? "Main · " : ""}${job.chat_id}`, { n: job.chat_id });
      for (const [key, english, russian] of [["task_id", "Operation task · {value}", "Задача операции"], ["root_task_id", "Operation root task · {value}", "Корневая задача операции"],
        ["origin_task_id", "Initiating task · {value}", "Задача, инициировавшая операцию"], ["origin_root_task_id", "Initiating root task · {value}", "Корневая задача инициатора"],
        ["presentation_owner_task_id", "Presentation owner task · {value}", "Задача-владелец представления"]] as const) if (job[key]) {
        const id = job[key]!;fact(content, english, `${russian} · ${id}`, { value: id });
        if (this.openTask && exactWorkTarget(id) && !this.stale) content.append(button(chromeText("Open task · {id}", { id }, `Открыть задачу · ${id}`), () => {
          if (!this.closed && !this.stale && generation === this.generation) this.openTask?.(id);
        }));
      }
      };
      if (panel.expanded) fill();
      panel.connect("notify::expanded", () => {
        if (this.closed) return;
        if (panel.expanded) { this.expanded.add(job.id);fill(); }
        else { this.expanded.delete(job.id);clear(content); }
      });
    }
  }
}
