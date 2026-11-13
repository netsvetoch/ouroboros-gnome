import { type Gateway, HttpError } from "./gateway.js";
import { Gio, GLib } from "./gi.js";
import { ownerHeaders } from "./settings-write.js";
import { confirm, errorText } from "./ui.js";
import { exactWorkTarget, type WorkAction, type WorkActions } from "./work-actions.js";

export interface ModelWait {
  wait_id: string;
  revision: number;
  task_attempt: number;
  model_wait_owner_id?: string;
  role?: string;
  model?: string;
  reason?: string;
  state: "waiting" | "resolved";
  requires_owner_action?: boolean;
  availability_observation?: string;
  credential_harness?: string;
  credential_profile_id?: string;
  reset_at?: string;
  auto_continue?: boolean;
  worker_slot_held?: boolean;
  review_operation?: object;
  pending_action?: { request_id?: string; action?: string; auto_continue?: boolean };
  applied_request_id?: string;
  saved_request_id?: string;
}

interface Activity {
  task_id?: string;
  activity_id?: string;
  task_attempt?: number;
  task_name?: string;
  title?: string;
  chat_id?: number;
  project_id?: string;
  project_name?: string;
  phase?: string;
  pause_cause?: string;
  attention_reason?: string;
  can_resume?: boolean;
  cancelable?: boolean;
  model_waits?: Record<string, ModelWait>;
}

export interface AttentionGap { reason: string; task_id?: string; wait_id?: string }

interface Snapshot {
  main_attention_gaps?: unknown;
  supervisor_ready?: boolean;
  active_chat_activities?: Activity[];
  active_chat_activities_complete?: boolean;
  main_attention?: Activity[];
  main_attention_complete?: boolean;
  works?: { room?: number; name?: string; confirmed?: boolean;
    turn?: { kind?: string; code?: string; task_id?: string; wait_id?: string }[] }[];
}

interface ProjectedActivity extends Activity { id: string; confirmed: boolean; attention: boolean; unconfirmedWaits?: string[] }
export interface WaitTarget { taskId: string; row: ModelWait }
export interface WaitItem extends WaitTarget { task: ProjectedActivity; confirmed: boolean }
export type WaitAction = { action: "retry" } | { action: "auto_continue"; auto_continue: boolean }
  | { action: "switch"; model: string; credential_profile_id: string; use_local: boolean; persist_role: boolean };
type WaitRequest = WaitAction & { decision_id: string; request_id: string; revision: number };
interface Receipt { ok?: boolean; applied?: boolean; saved?: boolean | null; wait?: ModelWait; reason_code?: string }
interface Attempt {
  latest?: ModelWait;
  latestAt?: number;
  request?: WaitRequest;
  sending?: boolean;
  message?: string;
  saved?: boolean | null;
  saveRequest?: string;
  sent?: string;
  applied?: string;
  accepted?: boolean;
}

function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }

export function modelWait(value: ModelWait | undefined, id: string): value is ModelWait {
  return Boolean(value && value.wait_id === id && exactWorkTarget(id) && positive(value.task_attempt) && positive(value.revision)
    && (value.state === "waiting" || value.state === "resolved"));
}

export function waitKey({ taskId, row }: WaitTarget): string {
  return JSON.stringify([taskId, row.wait_id, row.task_attempt, row.model_wait_owner_id || ""]);
}

function newer(previous: ModelWait | undefined, current: ModelWait): ModelWait {
  if (!previous || previous.revision < current.revision) return current;
  if (previous.revision > current.revision || previous.state === "resolved") return previous;
  if (current.state === "resolved") return current;
  return { ...current, pending_action: previous.pending_action ?? current.pending_action,
    saved_request_id: current.saved_request_id || previous.saved_request_id };
}

function waitPending(row: ModelWait): string | undefined {
  const id = row.pending_action?.request_id;
  return id && id !== row.applied_request_id ? id : undefined;
}

function project(rows: Activity[] | undefined, previous: ProjectedActivity[], complete: boolean, attention: boolean): ProjectedActivity[] {
  const next = new Map<string, ProjectedActivity>();
  const prior = new Map(previous.map((row) => [row.id, row]));
  if (Array.isArray(rows)) for (const row of rows) {
    const id = row?.task_id || row?.activity_id;
    if (!exactWorkTarget(id) || row.task_id && row.activity_id && row.task_id !== row.activity_id) continue;
    const old = prior.get(id);
    const validWaits = Object.fromEntries(Object.entries(row.model_waits ?? {}).filter(([waitId, wait]) => modelWait(wait, waitId)));
    const missing = !complete && old?.task_attempt === row.task_attempt
      ? Object.entries(old?.model_waits ?? {}).filter(([wait]) => !Object.hasOwn(validWaits, wait)) : [];
    const model_waits = { ...Object.fromEntries(missing), ...validWaits };
    next.set(id, { ...row, model_waits, id, confirmed: positive(row.task_attempt) && Boolean(row.phase && row.phase !== "unknown"),
      attention, unconfirmedWaits: missing.map(([wait]) => wait) });
  }
  if (!complete) for (const row of previous) if (!next.has(row.id)) next.set(row.id, { ...row, confirmed: false });
  return [...next.values()];
}

export class OwnerAttention {
  private readonly cancel = new Gio.Cancellable();
  private readonly listeners = new Set<() => void>();
  private readonly attempts = new Map<string, Attempt>();
  private readonly taskPending = new Set<string>();
  private readonly discovered = new Map<string, ProjectedActivity>();
  private proofs = new Map<string, { chat_id: number; title?: string }>();
  private active: ProjectedActivity[] = [];
  private attention: ProjectedActivity[] = [];
  private activeComplete = false;
  private connected = false;
  private closed = false;
  private epoch = 0;
  private at = 0;
  gaps: AttentionGap[] = [];
  gapsUnavailable = false;
  loaded = false;
  complete = false;

  constructor(private readonly gateway: Gateway, private readonly workActions: WorkActions, private readonly changed: () => void) {}

  subscribe(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private notify(): void { if (!this.closed) for (const callback of this.listeners) callback(); }

  setConnected(connected: boolean): void {
    if (this.closed || connected === this.connected) return;
    this.connected = connected;
    this.epoch = GLib.get_monotonic_time();
    this.observe(undefined, this.epoch);
  }

  observe(value: unknown, readAt: number): void {
    if (this.closed || readAt < this.epoch || readAt < this.at || !this.connected && value !== undefined) return;
    this.at = readAt;
    const snapshot = value as Snapshot | undefined;
    const state = snapshot?.supervisor_ready === false ? undefined : snapshot;
    if (!state) this.gapsUnavailable = true;
    else if (state.main_attention_gaps === undefined) { this.gaps = [];this.gapsUnavailable = false; }
    else if (Array.isArray(state.main_attention_gaps) && state.main_attention_gaps.every(item => item && typeof item === "object"
      && !Array.isArray(item) && typeof item.reason === "string" && item.reason.trim()
      && ["task_id", "wait_id"].every(key => item[key] === undefined || typeof item[key] === "string"))) {
      this.gaps = state.main_attention_gaps.map(item => ({ reason: item.reason,
        ...(item.task_id === undefined ? {} : { task_id: item.task_id }), ...(item.wait_id === undefined ? {} : { wait_id: item.wait_id }) }));
      this.gapsUnavailable = false;
    } else this.gapsUnavailable = true;
    this.activeComplete = Array.isArray(state?.active_chat_activities) && state?.active_chat_activities_complete === true;
    this.complete = Array.isArray(state?.main_attention) && state?.main_attention_complete === true;
    this.loaded ||= state?.main_attention_gaps !== undefined || Array.isArray(state?.main_attention) || Array.isArray(state?.active_chat_activities);
    this.active = project(state?.active_chat_activities, this.active, this.activeComplete, false);
    this.attention = project(state?.main_attention, this.attention, this.complete, true);
    this.proofs = new Map();
    if (Array.isArray(state?.works)) for (const work of state.works) {
      if (!work || work.confirmed !== true || !Number.isSafeInteger(work.room) || work.room! < 1 || !Array.isArray(work.turn)) continue;
      for (const turn of work.turn) if (turn?.kind === "action" && turn.code === "model_access"
        && exactWorkTarget(turn.task_id) && exactWorkTarget(turn.wait_id)) {
        this.proofs.set(`${turn.task_id}:${turn.wait_id}`, { chat_id: work.room!, title: work.name });
      }
    }
    for (const key of this.discovered.keys()) if (!this.proofs.has(key)) this.discovered.delete(key);
    for (const task of [...this.attention, ...this.active]) if (task.confirmed) {
      for (const [id, row] of Object.entries(task.model_waits ?? {})) {
        if (!modelWait(row, id) || row.task_attempt !== task.task_attempt || task.unconfirmedWaits?.includes(id)) continue;
        const attempt = this.attempts.get(waitKey({ taskId: task.id, row }));
        if (attempt && (readAt >= (attempt.latestAt ?? 0) || row.revision > (attempt.latest?.revision ?? 0))) {
          attempt.latest = newer(attempt.latest, row);
        }
      }
    }
    this.notify();
  }

  tasks(): ProjectedActivity[] {
    return this.attention.map((task) => this.active.some((row) => row.id === task.id && row.confirmed
      && row.task_attempt! > (task.task_attempt ?? 0)) ? { ...task, confirmed: false } : task);
  }
  gapInRoom(taskId: string | undefined, chatId: number): boolean {
    if (!taskId) return false;
    const rows = [...this.active, ...this.attention].filter(row => row.id === taskId);
    return rows.length > 0 && rows.every(row => row.chat_id === chatId);
  }
  waitsComplete(): boolean { return this.activeComplete && this.complete; }

  waits(): WaitItem[] {
    const waits = new Map<string, WaitItem>();
    const current = new Map<string, ProjectedActivity>();
    const tasks = [...this.discovered.values(), ...this.attention, ...this.active];
    for (const task of tasks) {
      if (task.confirmed && task.task_attempt! >= (current.get(task.id)?.task_attempt ?? 0)) current.set(task.id, task);
    }
    for (const task of tasks) {
      const latestTask = current.get(task.id) ?? task;
      if (["budget_paused", "budget_pausing"].includes(latestTask.phase ?? "") || latestTask.task_attempt !== task.task_attempt) continue;
      for (const [id, row] of Object.entries(task.model_waits ?? {})) {
        if (!modelWait(row, id) || row.task_attempt !== task.task_attempt) continue;
        const key = waitKey({ taskId: task.id, row });
        const previous = waits.get(key);
        const candidate = { taskId: task.id, task, row, confirmed: task.confirmed && !task.unconfirmedWaits?.includes(id) };
        if (!previous || candidate.confirmed && (!previous.confirmed || previous.row.revision <= row.revision)) {
          waits.set(key, { ...candidate, task: { ...task, attention: task.attention || previous?.task.attention === true } });
        }
      }
    }
    return [...waits.values()].map((item) => ({ ...item, row: this.latest(item) })).filter(({ row }) => row.state === "waiting");
  }

  latest(target: WaitTarget): ModelWait {
    const latest = this.attempts.get(waitKey(target))?.latest;
    return latest && latest.revision >= target.row.revision ? latest : target.row;
  }
  receipt(target: WaitTarget): Readonly<Attempt> { return this.attempts.get(waitKey(target)) ?? {}; }
  busy(taskId: string): boolean { return this.taskPending.has(taskId) || this.workActions.busy(taskId); }

  frame(taskId: string, row: ModelWait): void {
    if (!this.connected || !exactWorkTarget(taskId) || !modelWait(row, row.wait_id)) return;
    const target = { taskId, row };
    const attempt = this.attempts.get(waitKey(target));
    if (!attempt && !this.waits().some((item) => waitKey(item) === waitKey(target))) return;
    const record = this.record(target);
    record.latest = newer(attempt?.latest, row);
    record.latestAt = GLib.get_monotonic_time();
    this.notify();
  }

  canSend(item: WaitItem, replay: boolean): boolean {
    if (!this.connected || !item.confirmed || this.closed) return false;
    const attempt = this.receipt(item);
    const pending = waitPending(item.row);
    const reusable = Boolean(attempt.request && (pending ? pending === attempt.request.request_id
      : attempt.request.revision === item.row.revision && item.row.applied_request_id !== attempt.request.request_id));
    return replay ? reusable : !pending && !reusable;
  }

  async refresh(): Promise<boolean> {
    if (!this.connected || this.closed) return false;
    const readAt = GLib.get_monotonic_time();
    try {
      const snapshot = await this.gateway.json<Snapshot>("GET", "/api/state", undefined, undefined, false, this.cancel);
      this.observe(snapshot, readAt);
      return !this.closed && this.connected && readAt >= this.epoch;
    } catch {
      this.observe(undefined, readAt);
      return false;
    }
  }

  async discover(taskId: string, waitId: string): Promise<boolean> {
    const key = `${taskId}:${waitId}`;
    const proof = this.proofs.get(key);
    if (!this.connected || this.closed || !proof || !exactWorkTarget(taskId) || !exactWorkTarget(waitId)) return false;
    const epoch = this.epoch;
    try {
      const detail = await this.gateway.json<{ task_id?: string; id?: string; model_waits?: Record<string, ModelWait> }>(
        "GET", `/api/tasks/${encodeURIComponent(taskId)}`, undefined, undefined, false, this.cancel);
      const wait = detail?.model_waits?.[waitId];
      if (this.closed || !this.connected || epoch !== this.epoch || this.proofs.get(key)?.chat_id !== proof.chat_id
        || (detail?.task_id ?? detail?.id) !== taskId || !modelWait(wait, waitId)) return false;
      const target = { taskId, row: wait };
      const attempt = this.record(target);
      attempt.latest = newer(attempt.latest, wait);
      this.discovered.set(key, { ...proof, id: taskId, task_attempt: wait.task_attempt, confirmed: true,
        attention: false, model_waits: { [waitId]: wait } });
      this.notify();
      return this.latest(target).state === "waiting";
    } catch { return false; }
  }

  async submit(item: WaitItem, action: WaitAction | undefined, allowed: () => boolean): Promise<void> {
    if (!this.canSend(item, !action) || !allowed()) return;
    const attempt = this.record(item);
    const epoch = this.epoch;
    if (attempt.sending) return;
    attempt.sending = true;
    attempt.message = "Проверяю состояние ожидания…";
    this.notify();
    try {
      const fresh = await this.refresh();
      const discovered = this.discovered.has(`${item.taskId}:${item.row.wait_id}`);
      const detailConfirmed = fresh && allowed() && (!discovered || await this.discover(item.taskId, item.row.wait_id));
      const current = this.waits().find((other) => waitKey(other) === waitKey(item));
      if (!allowed() || epoch !== this.epoch || !detailConfirmed || !current
        || current.row.revision !== item.row.revision || !this.canSend(current, !action)) {
        attempt.message = "Шлюз не подтвердил доступность действия для этой версии ожидания.";
        return;
      }
      const request = action ? { ...action, decision_id: `model_wait:${item.taskId}:${item.row.wait_id}`,
        revision: item.row.revision, request_id: GLib.uuid_string_random() } : attempt.request!;
      attempt.request = request;
      attempt.sent = request.request_id;
      attempt.accepted = false;
      attempt.message = "Отправляю решение…";
      this.notify();
      try {
        const reply = await this.gateway.json<Receipt>("POST", "/api/decisions", request, ownerHeaders, true, this.cancel);
        this.accept(item, attempt, request, reply);
        if (reply?.ok === true && modelWait(reply.wait, item.row.wait_id) && waitKey({ taskId: item.taskId, row: reply.wait }) === waitKey(item)) {
          attempt.accepted = true;
          attempt.message = "";
          attempt.request = undefined;
        } else attempt.message = "Ответ шлюза не подтвердил решение. Можно повторить тот же запрос.";
      } catch (error) {
        const reply = error instanceof HttpError ? error.body as Receipt | undefined : undefined;
        this.accept(item, attempt, request, reply);
        if (error instanceof HttpError && error.status < 500 && error.status !== 408 && error.status !== 429
          || attempt.applied === request.request_id || attempt.latest?.applied_request_id === request.request_id) attempt.request = undefined;
        attempt.message = errorText(error);
      }
      if (!this.closed) this.changed();
    } finally {
      attempt.sending = false;
      this.notify();
    }
  }

  async runTask(parent: any, target: ProjectedActivity, action: WorkAction, inScope: () => boolean): Promise<string> {
    const epoch = this.epoch;
    const allowed = () => this.connected && this.epoch === epoch && !this.closed && inScope() && this.tasks().some((row) => row.id === target.id
      && row.task_attempt === target.task_attempt && row.confirmed && (action === "resume"
        ? row.can_resume === true && row.pause_cause !== "owner" : row.cancelable === true));
    if (!allowed() || this.busy(target.id)) return "Действие больше недоступно.";
    this.taskPending.add(target.id);
    this.notify();
    try {
      if (action !== "resume") {
        const caption = action === "wrap_up" ? "Завершить с частичным результатом" : "Остановить работу";
        if (!await confirm(parent, `${caption}?`, target.task_name || target.title || target.id, caption) || !allowed()) return "";
      }
      if (!await this.refresh() || !allowed()) return "Шлюз не подтвердил доступность действия.";
      const result = await this.workActions.run(parent, { action, target: target.id, scope: "cascade" },
        String(target.task_attempt), allowed);
      if (!this.closed) this.changed();
      return result.text;
    } finally {
      this.taskPending.delete(target.id);
      this.notify();
    }
  }

  close(): void { this.closed = true; this.cancel.cancel(); this.listeners.clear(); this.attempts.clear(); }

  private record(target: WaitTarget): Attempt {
    const id = waitKey(target);
    const existing = this.attempts.get(id);
    if (existing) return existing;
    const attempt: Attempt = {};
    this.attempts.set(id, attempt);
    return attempt;
  }

  private accept(item: WaitItem, attempt: Attempt, request: WaitRequest, reply?: Receipt): void {
    if (modelWait(reply?.wait, item.row.wait_id) && waitKey({ taskId: item.taskId, row: reply.wait }) === waitKey(item)) {
      const previous = attempt.latest;
      attempt.latest = previous?.revision === reply.wait.revision && previous.state === "waiting"
        ? reply.wait : newer(previous, reply.wait);
      attempt.latestAt = GLib.get_monotonic_time();
    }
    if (reply?.applied === true) attempt.applied = request.request_id;
    if (request.action === "switch" && request.persist_role) {
      attempt.saved = typeof reply?.saved === "boolean" ? reply.saved : null;
      attempt.saveRequest = request.request_id;
    }
  }
}
