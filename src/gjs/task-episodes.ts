import { skillProgressRow } from "./skill-progress.js";
import { object } from "./settings-write.js";
import { originAddressed, taskReferencePending } from "./submission-notices.js";
import { continuationOf, exactWorkTarget, type ContinueOffer } from "./work-actions.js";

export interface EpisodeFacts {
  task: string;
  name?: string;
  started?: string | number;
  ended?: string | number;
  outcome?: string;
  offer: ContinueOffer;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function time(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  return text(value);
}

export function episodeTask(value: unknown): string | undefined {
  const row = object(value);
  if (taskReferencePending(row) || skillProgressRow(row) || row.system_type === "reminder") return undefined;
  if (row.admission_outcome === "never_admitted" || (typeof row.system_type === "string" && originAddressed(row.system_type))) return undefined;
  return exactWorkTarget(row.task_id) && !row.parent_task_id && !object(row.metadata).parent_task_id
    && !(row.subagent_task_id && row.subagent_task_id !== row.task_id) ? row.task_id : undefined;
}

export function noteEpisode(facts: Map<string, EpisodeFacts>, raw: unknown, detail = false): void {
  const task = episodeTask(raw);
  if (!task) return;
  const row = object(raw);
  const previous = facts.get(task);
  const terminal = object(row.terminal_time);
  const final = row.outcome_final === true || detail;
  const offer = continuationOf(row, task);
  facts.set(task, {
    task,
    name: text(row.suggested_name) ?? text(row.task_name) ?? text(row.title) ?? previous?.name,
    started: time(object(terminal.attempt).started_at) ?? time(row.started_at) ?? previous?.started,
    ended: time(terminal.occurred_at) ?? (row.outcome_final === true ? time(row.ts) : undefined) ?? previous?.ended,
    outcome: (final ? text(row.outcome_phase) ?? text(row.task_terminal_status) ?? text(row.status) : undefined) ?? previous?.outcome,
    offer: previous?.offer.kind === "successor" && offer.kind !== "successor" ? previous.offer
      : Object.hasOwn(row, "continuation_offer") || Object.hasOwn(row, "continued_by") ? offer : previous?.offer ?? offer,
  });
}

/** Each unambiguous, acyclic sequence of explicitly admitted edges. */
export function episodeChains(facts: Map<string, EpisodeFacts>): Map<string, string[]> {
  const parents = new Map<string, string[]>();
  for (const { task, offer } of facts.values()) {
    if (offer.successor) parents.set(offer.successor, [...(parents.get(offer.successor) ?? []), task]);
  }
  const grouped = new Map<string, string[]>();
  for (const { task, offer } of facts.values()) {
    if (!offer.successor || parents.has(task)) continue;
    const chain = [task];
    const seen = new Set(chain);
    let next: string | undefined = offer.successor;
    while (next && parents.get(next)?.length === 1 && !seen.has(next)) {
      seen.add(next);
      chain.push(next);
      next = facts.get(next)?.offer.successor;
    }
    if (next || chain.length < 2) continue;
    for (const id of chain) grouped.set(id, chain);
  }
  return grouped;
}

export function episodeLayout<Row>(rows: Row[], facts: Map<string, EpisodeFacts>, keepSeparate: (row: Row) => boolean) {
  const chains = episodeChains(facts);
  const groups = new Map<Row, string[]>();
  const past = new Map<Row, string>();
  const actions = new Map<string, Row>();
  const placed = new Set<string[]>();
  for (const row of rows) {
    const task = episodeTask(row);
    if (!task) continue;
    const chain = chains.get(task);
    if (chain) {
      if (!placed.has(chain)) {
        groups.set(row, chain);
        placed.add(chain);
      }
      if (chain.at(-1) !== task && !keepSeparate(row)) past.set(row, task);
    } else if ((facts.get(task)?.offer.kind ?? "none") !== "none") {
      actions.set(task, row);
    }
  }
  return { groups, past, actions };
}

function clock(raw: string | number | undefined): string | undefined {
  if (!raw) return undefined;
  const value = new Date(typeof raw === "number" && raw < 1e12 ? raw * 1000 : raw);
  return Number.isFinite(value.getTime()) ? value.toLocaleString("ru", { dateStyle: "short", timeStyle: "short" }) : undefined;
}

export function episodeTitle(id: string, index: number, facts?: EpisodeFacts): string {
  const started = clock(facts?.started);
  const ended = clock(facts?.ended);
  const period = started && ended ? `${started} – ${ended}` : started ? `Начало ${started}` : ended ? `Завершение ${ended}` : undefined;
  const outcome = facts?.outcome;
  const status = outcome ? ({ completed: "Завершена", done: "Завершена", failed: "Ошибка", cancelled: "Остановлена",
    scheduled: "Запланирована", running: "В работе", interrupted: "Прервана", best_effort: "Частичный результат" } as Record<string, string>)[outcome] ?? outcome : "";
  return [`Попытка ${index + 1}`, facts?.name, id, period, status].filter(Boolean).join(" · ");
}
