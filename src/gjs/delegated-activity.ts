import { Gtk } from "./gi.js";
import { object } from "./settings-write.js";
import { column, label } from "./ui.js";
import { usd } from "./cost-view.js";
import { exactWorkTarget } from "./work-actions.js";

type Span = [number, number];
type Data = Record<string, unknown>;
interface Part extends Data {
  kind: "message" | "thinking" | "problem";
  text: string;
  actor?: string;
  seq?: number;
  last_seq?: number;
  final?: boolean;
  speech?: { key?: string; op?: string };
}
interface Gap { after_seq: number; through_seq: number; reason?: string; final?: boolean }
export interface DelegatedActivity {
  task_id: string;
  run_id: string;
  after_seq: number;
  through_seq: number;
  parts: Part[];
  source: Data & { kind: string; read_through?: number; provisional?: boolean; ref?: unknown };
  technical?: Data;
  gaps?: Gap[];
  omitted?: Data;
  speech_abandoned?: Data[];
}
interface PartView { part: Part; text: string; note?: string; abandoned?: boolean }
export interface ActivityView {
  activity: DelegatedActivity;
  parts: PartView[];
  gaps: Gap[];
  technical: number;
  recent: Data[];
  repeatedCount: boolean;
  superseded: boolean;
  omitted: boolean;
  source: boolean;
  hidden: boolean;
}

const unread = new Set(["not_served", "unreadable", "not_read"]);
const number = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown): string => typeof value === "string" ? value : "";
const objects = (value: unknown): Data[] => Array.isArray(value) ? value.map(object) : [];

export function delegatedActivity(row: unknown): DelegatedActivity | undefined {
  const message = object(row);
  const activity = object(message.delegated_activity ?? object(message.progress_meta).delegated_activity);
  const source = object(activity.source);
  if (activity.v !== 1 || !exactWorkTarget(message.task_id) || activity.task_id !== message.task_id
    || !text(activity.run_id) || !number(activity.after_seq) || !number(activity.through_seq) || activity.after_seq >= activity.through_seq
    || !["run_events", "timeline_window"].includes(text(source.kind)) || !Array.isArray(activity.parts)) return undefined;
  if (activity.parts.some((value) => {
    const part = object(value);
    return !["message", "thinking", "problem"].includes(text(part.kind)) || typeof part.text !== "string";
  })) return undefined;
  return activity as unknown as DelegatedActivity;
}

export function delegatedKey(activity: DelegatedActivity): string {
  return JSON.stringify([activity.task_id, activity.run_id, activity.after_seq, activity.through_seq,
    activity.source.kind, activity.source.read_through, activity.source.provisional, object(activity.source.ref).sha256]);
}

function runKey(activity: DelegatedActivity): string {
  return JSON.stringify([activity.task_id, activity.run_id]);
}

function readRange(activity: DelegatedActivity): Span | undefined {
  const through = activity.source.read_through;
  if (activity.source.kind === "run_events" && number(through) && through > activity.after_seq && through <= activity.through_seq) {
    return [activity.after_seq + 1, through];
  }
  return undefined;
}

function gapsOf(activity: DelegatedActivity): Gap[] {
  return Array.isArray(activity.gaps) ? activity.gaps.filter((gap) =>
    number(gap?.after_seq) && number(gap.through_seq) && gap.after_seq < gap.through_seq) : [];
}

function union(ranges: Span[], range: Span): Span[] {
  const merged: Span[] = [];
  for (const [start, end] of [...ranges, range].sort(([a], [b]) => a - b)) {
    const last = merged.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function remaining([start, end]: Span, ranges: Span[]): Span[] {
  const missing: Span[] = [];
  for (const [lo, hi] of ranges) {
    if (hi < start) continue;
    if (lo > end) break;
    if (lo > start) missing.push([start, lo - 1]);
    start = Math.max(start, hi + 1);
  }
  if (start <= end) missing.push([start, end]);
  return missing;
}

function contains(ranges: Span[], seq: number): boolean {
  return ranges.some(([start, end]) => seq >= start && seq <= end);
}

function speechKey(activity: DelegatedActivity, part: { actor?: unknown; key?: unknown }): string | undefined {
  return text(part.key) ? JSON.stringify([runKey(activity), text(part.actor), part.key]) : undefined;
}

function sourceIdentity(activity: DelegatedActivity): string {
  const sha = object(activity.source.ref).sha256;
  return typeof sha === "string" && /^[a-f0-9]{64}$/.test(sha) ? JSON.stringify([runKey(activity), sha]) : "";
}

function partView(part: Part, claimed: Span[]): PartView | undefined {
  if (!number(part.seq)) return { part, text: part.text };
  const last = number(part.last_seq) && part.last_seq >= part.seq ? part.last_seq : part.seq;
  const fresh = remaining([part.seq, last], claimed);
  if (!fresh.length) return undefined;
  if (fresh.length === 1 && fresh[0][0] === part.seq && fresh[0][1] === last) return { part, text: part.text };
  const chars = Array.from(part.text);
  const cuts = Array.isArray(part.cuts) ? part.cuts.filter((cut): cut is [number, number] => Array.isArray(cut)
    && number(cut[0]) && cut[0] > part.seq! && cut[0] <= last && number(cut[1]) && cut[1] <= chars.length) : [];
  const pieces = new Map<number, number>([[part.seq, 0], ...cuts]);
  if (fresh.length === 1 && fresh[0][1] === last && pieces.has(fresh[0][0])) {
    return { part, text: chars.slice(pieces.get(fresh[0][0])).join(""), note: "Продолжение ранее показанного фрагмента." };
  }
  return { part, text: part.text, note: "Часть текста может повторять показанные фрагменты." };
}

export function projectDelegated(activities: DelegatedActivity[]): Map<DelegatedActivity, ActivityView> {
  const seenRanges = new Map<string, Span[]>();
  const readWhole = new Map<string, Span[]>();
  const wholeByRecord = new Map<DelegatedActivity, Span[]>();
  for (const activity of activities) {
    const range = readRange(activity);
    if (!range) continue;
    const run = runKey(activity);
    seenRanges.set(run, union(seenRanges.get(run) ?? [], range));
    const holes = gapsOf(activity).filter((gap) => unread.has(gap.reason ?? ""))
      .reduce<Span[]>((spans, gap) => union(spans, [gap.after_seq + 1, gap.through_seq]), []);
    const whole = remaining(range, holes);
    wholeByRecord.set(activity, whole);
    readWhole.set(run, whole.reduce(union, readWhole.get(run) ?? []));
  }
  const superseded = (activity: DelegatedActivity) => activity.source.provisional === true
    && !remaining([activity.after_seq + 1, activity.through_seq], seenRanges.get(runKey(activity)) ?? []).length;
  const complete = new Map<string, { activity: DelegatedActivity; part: Part; exact: boolean }>();
  const abandoned = new Set<string>();
  for (const activity of activities) {
    if (superseded(activity)) continue;
    for (const part of activity.parts) {
      const key = part.kind === "message" && !part.final && speechKey(activity, { actor: part.actor, key: part.speech?.key });
      const exact = Boolean(readRange(activity));
      if (key && part.speech?.op === "complete" && (!complete.has(key) || (exact && !complete.get(key)?.exact))) {
        complete.set(key, { activity, part, exact });
      }
    }
    for (const mark of objects(activity.speech_abandoned)) {
      const key = speechKey(activity, mark);
      if (key) abandoned.add(key);
    }
  }
  const claimed = new Map<string, Span[]>();
  const sources = new Set<string>();
  const drafts = new Map<string, { last: number; view: PartView }>();
  const views = new Map<DelegatedActivity, ActivityView>();
  for (const activity of activities) {
    const run = runKey(activity);
    const prior = claimed.get(run) ?? [];
    const range = readRange(activity);
    const freshRange = range ? remaining(range, prior) : [];
    const replaced = superseded(activity);
    const parts = replaced ? [] : activity.parts.flatMap((part) => {
      const key = part.kind === "message" && !part.final && speechKey(activity, { actor: part.actor, key: part.speech?.key });
      const winner = key ? complete.get(key) : undefined;
      if (winner && (winner.part !== part || winner.activity !== activity)) return [];
      // A complete utterance replaces its own streamed fragments, even when its seq overlaps their range.
      const view = partView(part, winner || !range ? [] : prior);
      if (!view) return [];
      if (key && !winner && abandoned.has(key)) view.abandoned = true;
      if (key && !winner && part.speech?.op === "fragment") {
        const previous = drafts.get(key);
        drafts.delete(key);
        if (range && number(part.seq) && !view.note && part.truncated !== true) {
          const last = number(part.last_seq) ? Math.max(part.seq, part.last_seq) : part.seq;
          // Join only adjacent observed events. A gap, clipped preview or window breaks the draft.
          if (previous && previous.last + 1 === part.seq) {
            previous.view.text += view.text;
            drafts.set(key, { last, view: previous.view });
            return [];
          }
          if (view.text.trim()) drafts.set(key, { last, view });
        }
      }
      if (!view.text.trim() && !view.note) return [];
      return [view];
    });
    const gaps = replaced ? [] : gapsOf(activity).flatMap((gap) =>
      remaining([gap.after_seq + 1, gap.through_seq],
        (unread.has(gap.reason ?? "") ? readWhole : seenRanges).get(run) ?? [])
        .map(([lo, hi]) => ({ ...gap, after_seq: lo - 1, through_seq: hi })));
    const observed = object(activity.technical);
    const seqs = Array.isArray(observed.seqs) ? observed.seqs.filter((span): span is Span =>
      Array.isArray(span) && number(span[0]) && number(span[1]) && span[1] >= span[0]) : [];
    const count = number(observed.count) ? observed.count : 0;
    const technical = replaced ? 0 : range && seqs.length
      ? seqs.flatMap((span) => remaining(span, prior)).reduce((sum, [lo, hi]) => sum + hi - lo + 1, 0) : count;
    const recent = technical ? objects(observed.recent).filter((row) => !range || !number(row.seq) || !contains(prior, row.seq)) : [];
    const omitted = !replaced && (!range || freshRange.length > 0)
      && Object.values(object(activity.omitted)).some((value) => number(value) && value > 0);
    const handle = sourceIdentity(activity);
    const source = Boolean(handle && !sources.has(handle));
    if (handle) sources.add(handle);
    const hidden = !parts.length && !technical && !gaps.length && !omitted && !source && !replaced
      && !activity.source.rows_omitted && Boolean(range && !freshRange.length);
    const overlap = range && (freshRange.length !== 1 || freshRange[0][0] !== range[0] || freshRange[0][1] !== range[1]);
    views.set(activity, { activity, parts, gaps, technical, recent, omitted, source, hidden, superseded: replaced,
      repeatedCount: Boolean(range && (seqs.length ? technical < count : overlap)) });
    if (range) claimed.set(run, (wholeByRecord.get(activity) ?? []).reduce(union, prior));
  }
  return views;
}

function fact(target: any, ...values: unknown[]): void {
  const words = values.filter((value) => number(value) || (typeof value === "string" && value)).join(" · ");
  if (!words) return;
  const widget = label(words);
  widget.set_selectable(true);
  target.append(widget);
}

function disclosure(target: any, title: string): any {
  const body = column(4);
  target.append(new Gtk.Expander({ label: title, child: body }));
  return body;
}

export function renderDelegated(target: any, view: ActivityView,
  open: (target: any, task: string, ref: unknown) => boolean): void {
  const { activity } = view;
  fact(target, "Наблюдение за делегированным запуском", activity.run_id, `События ${activity.after_seq + 1}–${activity.through_seq}`);
  if (view.superseded) {
    fact(target, "Этот диапазон уточнён записями журнала.");
    return;
  }
  if (activity.source.kind === "timeline_window") fact(target, "Ограниченный снимок журнала", activity.source.reason, activity.source.rows_omitted
    ? `За пределами снимка · ${activity.source.rows_omitted}` : "");
  const thinking = view.parts.some(({ part }) => part.kind === "thinking") ? disclosure(target, "Рассуждение исполнителя") : undefined;
  for (const { part, text: words, note, abandoned } of view.parts) {
    const body = part.kind === "thinking" ? thinking : part.final ? disclosure(target, "Итоговый ответ исполнителя") : target;
    fact(body, part.actor, part.kind === "problem" ? part.label || "Проблема" : "",
      part.speech?.op === "fragment" ? "Фрагмент" : "", part.updated === true ? "Текст уточнён" : "");
    fact(body, words);
    if (note) fact(body, note);
    if (abandoned) fact(body, "Исполнитель оставил этот фрагмент незавершённым.");
    if (part.truncated === true) fact(body, "Показан сокращённый текст.", number(part.chars) ? `Символов в записи · ${part.chars}` : "");
  }
  for (const gap of view.gaps) fact(target, unread.has(gap.reason ?? "") ? "События прочитаны не полностью" : "События ещё не показаны",
    `${gap.after_seq + 1}–${gap.through_seq}`, gap.reason, gap.final === true ? "Ожидание закончилось" : "");
  if (view.technical) {
    const body = disclosure(target, `Технические события · ${view.technical}`);
    if (view.repeatedCount) fact(body, "Сводка типов относится ко всему исходному диапазону.");
    const technical = object(activity.technical);
    for (const pair of Array.isArray(technical.labels) ? technical.labels : []) {
      if (Array.isArray(pair)) fact(body, pair[0], pair[1]);
    }
    for (const row of view.recent) fact(body, row.seq, row.actor, row.label, row.detail);
    if (technical.recent_omitted) fact(body, "Ранние записи за пределами сводки", technical.recent_omitted);
    if (technical.other_kinds) fact(body, "Дополнительные типы", technical.other_kinds);
  }
  if (view.omitted) {
    const names: Record<string, string> = { message: "сообщения", thinking: "рассуждения", problem: "проблемы", speech_abandoned: "прерванные фрагменты" };
    const omitted = Object.entries(object(activity.omitted)).filter(([, count]) => number(count) && count > 0);
    fact(target, "За пределами предпросмотра", ...omitted.map(([kind, count]) => `${names[kind] ?? kind} ×${count}`));
  }
  if (view.source) {
    const ref = object(activity.source.ref);
    if (!text(ref.path).startsWith("source_handles/delegated_activity/") || !text(ref.path).endsWith(`-${ref.sha256}.jsonl`)
      || !open(target, activity.task_id, ref)) fact(target, "Сохранённый диапазон журнала недоступен.");
  } else if (activity.source.retained === false) fact(target, "Шлюз не сохранил копию диапазона.");
}

export function renderExecutor(target: any, raw: unknown): void {
  const row = object(raw);
  const metadata = object(row.progress_meta);
  const envelope = object(row.subagent_envelope);
  const observation = object(row.executor_observation ?? metadata.executor_observation);
  const task = row.subagent_task_id || row.task_id;
  const observed = exactWorkTarget(task) && observation.task_id === task && text(observation.run_id)
    && text(observation.attempt_id) && text(observation.harness_id) && text(observation.phase) && number(observation.revision);
  const evidence = object(row.execution_evidence ?? metadata.execution_evidence ?? envelope.execution_evidence);
  const route = row.executor_route || metadata.executor_route || envelope.executor_route;
  if (!observed && !Object.keys(evidence).length && !text(route)) return;
  const body = disclosure(target, "Сведения об исполнителе");
  if (text(route)) fact(body, "Назначенный маршрут", route);
  if (observed) {
    fact(body, "Последнее наблюдение", observation.harness_id, observation.phase, "Запуск", observation.run_id,
      "Попытка", observation.attempt_id, "Версия", observation.revision);
    if (observation.model_source === "requested" || observation.model_source === "observed") {
      fact(body, observation.model_source === "requested" ? "Запрошенная модель" : "Наблюдаемая модель", observation.model);
    }
  }
  if (evidence.evidence_read_failed === true) {
    fact(body, "Журнал выполнения прочитан частично. Итоговые количества неизвестны.");
    if (number(evidence.delegated_runs_started) && evidence.delegated_runs_started > 0) fact(body, "Подтверждено запусков как минимум", evidence.delegated_runs_started);
    return;
  }
  if (!Object.keys(evidence).length) return;
  const substrate = row.actual_substrate || metadata.actual_substrate || envelope.actual_substrate;
  if (substrate === "harness_used") fact(body, "Исполнение в движке подтверждено.");
  if (substrate === "harness_attempted") fact(body, "Подтверждена попытка исполнения в движке.");
  if (substrate === "native_only") fact(body, "Зафиксировано только выполнение внутри Ouroboros.");
  for (const [key, title] of [["started", "Начаты"], ["settled", "С исходом"], ["succeeded", "Успешны"],
    ["failed", "Ошибки или неподтверждённые исходы"], ["source_unresolved", "Недостаточно данных о запуске"]]) {
    const value = evidence[`delegated_runs_${key}`];
    if (number(value)) fact(body, title, value);
  }
  for (const [key, title] of [["delegated_run_failure_states", "Причины"], ["harness_models", "Модели движка"],
    ["applied_access_profiles", "Режимы доступа"]]) {
    if (Array.isArray(evidence[key]) && evidence[key].length) fact(body, title, ...evidence[key]);
  }
  if (evidence.subscription_cost_usd !== undefined) {
    fact(body, "Стоимость по подписке", usd(evidence.subscription_cost_usd), evidence.subscription_cost_estimated === true ? "оценка" : "",
      evidence.subscription_cost_partial === true ? "учтённая часть" : "");
  }
}
