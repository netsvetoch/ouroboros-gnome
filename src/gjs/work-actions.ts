import { chromeText } from "./native-i18n.js";
import { chooseResumeUnknown } from "./work-resume.js";
import { choosePauseReason } from "./work-pause.js";
import { WorkJournal, workRequestId, type StableWorkBody } from "./work-journal.js";
import { workAccepted, workRefused } from "./work-receipt.js";
import { type Gateway, HttpError } from "./gateway.js";
import { Gio, GLib } from "./gi.js";
import { gatewayStatePath, readGatewayState, writeGatewayState } from "./gateway-state.js";
import { object } from "./settings-write.js";
import { confirm, errorText } from "./ui.js";

export type WorkAction = "stop" | "stop_earlier" | "wrap_up" | "pause" | "resume" | "hurry" | "continue";
export interface WorkControl { action: WorkAction; target: string; scope?: string }
export interface WorkResult { text: string; failed?: boolean; successor?: string }
export interface PendingWorkRequest { key: string; control: WorkControl; attempt: string; request_id: string }
interface Reply {
  ok?: boolean;
  task_id?: string;
  state?: string;
  status?: string;
  error?: string;
  cancel_state?: string;
  latch_pending?: boolean;
  stop_policy?: string;
  held?: boolean;
  late_phase?: string;
  tree_only?: boolean;
  duplicate?: boolean;
  unconfirmed?: boolean;
  successor_task_id?: string;
  predecessor_task_id?: string;
  replay?: boolean;
  blockers?: unknown[];
  membership_gaps?: { count?: number; rows?: { task_id?: string }[] };
}
interface Detail { status?: string; cancel_state?: string }
const terminal = new Set(["completed", "failed", "cancelled", "rejected_duplicate"]);

export const workActionNames: Record<WorkAction, string> = {
  stop: "Остановить", stop_earlier: "Остановить прежнюю попытку",
  wrap_up: "Завершить с частичным результатом", pause: "Пауза", resume: "Возобновить",
  hurry: "Ускорить", continue: "Продолжить задачу",
};

export function exactWorkTarget(target: unknown): target is string {
  return typeof target === "string" && target !== "active" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(target);
}

export type ContinueOffer = { kind: "offer" | "retry" | "successor" | "refusal" | "none"; successor?: string; nonce?: string; message?: string };

function actionNonce(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/u.test(value);
}

export function continuationOf(raw: unknown, task: string): ContinueOffer {
  const row = object(raw);
  if (row.parent_task_id || object(row.metadata).parent_task_id) return { kind: "none" };
  const offer = object(row.continuation_offer);
  const claim = object(row.continued_by);
  const link = Object.hasOwn(row, "continuation_offer") ? offer : claim;
  const successor = exactWorkTarget(link.successor_task_id) && link.successor_task_id !== task ? link.successor_task_id : undefined;
  if (link.state === "admitted" && successor) return { kind: "successor", successor };
  if (link.state === "bound" && successor && actionNonce(link.action_nonce)) return { kind: "retry", nonce: link.action_nonce };
  if (offer.eligible === true && !link.state && !link.successor_task_id) return { kind: "offer" };
  if (offer.refusal === "execution_budget_unknown") {
    return { kind: "refusal", message: "Продолжение недоступно. Шлюз не смог определить оставшееся время выполнения." };
  }
  if (offer.refusal === "hard_limit_reached") {
    const cause = offer.cause === "deadline" ? "Истёк срок задачи." : offer.cause === "execution_deadline" ? "Исчерпано время выполнения."
      : offer.cause === "budget_exhausted" ? "Исчерпан бюджет." : "Достигнут жёсткий лимит задачи.";
    return { kind: "refusal", message: `Продолжение недоступно. ${cause}` };
  }
  return { kind: "none" };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { resolve(); return GLib.SOURCE_REMOVE; }));
}

function blockers(values: unknown): string {
  return Array.isArray(values) ? values.slice(0, 8).map((value) => {
    const row = object(value);
    return [row.task_id, row.operation_id, row.attempt_id, row.run_id, row.tool, row.kind, row.state, row.reason]
      .filter((field) => typeof field === "string" && field).join(" · ");
  }).filter(Boolean).join("\n") : "";
}

function detailText(detail?: Detail): string {
  return detail?.cancel_state === "pending" ? "Шлюз показывает, что остановка ещё выполняется."
    : detail?.status ? `Текущее состояние задачи · ${detail.status}` : "";
}

export class WorkActions {
  private readonly cancel = new Gio.Cancellable();
  private readonly journal: WorkJournal;
  private readonly inFlight = new Set<string>();
  private closed = false;

  constructor(private readonly gateway: Gateway) { this.journal = new WorkJournal(gateway.base); }

  busy(target: string): boolean { return this.inFlight.has(target); }

  pending(target: string): PendingWorkRequest[] {
    return this.journal.forTask(target).map(({ key, body }) => {
      const [owner, kind, cascade, attempt] = JSON.parse(key) as [string, string, boolean | null, string];
      const action = kind === "immediate" ? "stop" : kind === "finalize_then_cancel" ? "wrap_up" : kind as "pause" | "hurry";
      return { key, control: { target: owner, action, ...(cascade === null ? {} : { scope: cascade ? "cascade" : "single" }) },
        attempt, request_id: workRequestId(body) };
    });
  }

  async retry(parent: any, pending: PendingWorkRequest, allowed: () => boolean): Promise<WorkResult> {
    try {
      const current = this.pending(pending.control.target).find(item => item.key === pending.key && item.request_id === pending.request_id);
      if (!current) return { text: "Этот запрос уже подтверждён или заменён. Обновите окно задачи.", failed: true };
      return await this.run(parent, current.control, current.attempt, allowed, { editPauseReason: current.control.action === "pause" });
    } catch (error) { return { text: `Запрос не отправлен. ${errorText(error)}`, failed: true }; }
  }

  close(): void {
    this.closed = true;
    this.cancel.cancel();
  }

  async run(parent: any, control: WorkControl, attempt: string, allowed: () => boolean,
    options?: { editPauseReason?: boolean }): Promise<WorkResult> {
    const { target, action } = control;
    if (action === "continue") return this.continueTask(target, allowed);
    if (this.closed || !exactWorkTarget(target) || !allowed()) return { text: "Действие больше недоступно для этой работы.", failed: true };
    if (this.busy(target)) return { text: "Действие для этой работы уже выполняется.", failed: true };
    const stop = action === "stop" || action === "stop_earlier" || action === "wrap_up";
    const path = `/api/tasks/${encodeURIComponent(target)}`;
    const door = stop ? "cancel" : action;
    const policy = action === "wrap_up" ? "finalize_then_cancel" : "immediate";
    const cascade = control.scope !== "single";
    const key = JSON.stringify([target, stop ? policy : action, stop ? cascade : null, attempt]);
    let sent = false, saved: StableWorkBody | undefined;
    const post = (body: object) => {
      sent = true;
      return this.gateway.json<Reply>("POST", `${path}/${door}`, body, undefined, false, this.cancel);
    };
    const forget = (items = saved ? [{ key, body: saved }] : []): string => {
      try { this.journal.forget(items); return ""; }
      catch (error) { return `Не удалось обновить журнал действий клиента. ${errorText(error)}`; }
    };
    this.inFlight.add(target);
    let unknownDecisionSent = false;
    const decisionNotice = () => unknownDecisionSent ? chromeText(
      "Your decision about the selected unknown outcomes may have been recorded. Read the task before another decision.", undefined,
      "Решение о выбранных неизвестных исходах могло быть записано. Перечитайте задачу перед следующим решением.") : "";
    try {
      const retained = action === "resume" ? undefined : this.journal.pending(key);
      const oldPauses = action === "resume" ? this.journal.pauses(target) : [];
      const request = retained ? ("request_id" in retained ? retained.request_id : retained.stop_action_id) : GLib.uuid_string_random();
      let pauseBody = retained && "actor" in retained
        ? retained as { request_id: string; actor: "owner"; reason?: string } : undefined;
      if (action === "pause" && options?.editPauseReason) {
        const choice = await choosePauseReason(parent, target, this.cancel, pauseBody);
        if (!choice) return { text: "Запрос паузы не отправлен." };
        if (this.closed || !allowed()) return { text: "Цель паузы изменилась.", failed: true };
        pauseBody ??= Object.freeze({ request_id: request, actor: "owner" as const, reason: choice.reason });
      }
      if (action === "pause") {
        pauseBody ??= Object.freeze({ request_id: request, actor: "owner" as const });
      }
      const payload = retained ?? (stop ? { cascade, stop_policy: policy, stop_action_id: request } as StableWorkBody
        : action === "pause" ? pauseBody!
          : action === "hurry" ? { request_id: request } : {});
      if (action !== "resume") {
        saved = payload as StableWorkBody;
        this.journal.put(key, saved);
      }
      let reply: Reply;
      try { reply = await post(payload); }
      catch (error) {
        const body = error instanceof HttpError && error.status === 409 ? object(error.body) : {};
        const named = body.acceptable_unknown;
        if (action !== "resume" || !Array.isArray(named) || !named.length
          || named.some((entry) => typeof entry !== "string" || !entry)) throw error;
        if (body.task_id !== undefined && body.task_id !== target) throw error;
        const decision = await chooseResumeUnknown(parent, target, [...new Set(named as string[])], body.blockers, this.cancel, typeof body.message === "string" ? body.message : undefined);
        if (!decision) return { text: "Решение о неизвестных исходах не отправлено." };
        if (this.closed || !allowed()) return { text: "Цель возобновления изменилась.", failed: true };
        unknownDecisionSent = true;
        reply = await post(decision);
      }
      if (!workAccepted(reply, action, target, request, cascade)) throw new Error("Шлюз не подтвердил действие подходящей квитанцией.");
      if (action === "pause") {
        for (const ms of [250, 500, 1000, 2000]) {
          if (!reply.latch_pending || this.closed || !allowed()) break;
          await delay(ms);
          if (this.closed || !allowed()) break;
          try {
            const next = await post(payload);
            if (workAccepted(next, action, target, request, cascade)) reply = next;
          } catch { /* the previous acknowledgement remains valid */ }
        }
        if (reply.latch_pending) return { text: "Пауза записана. Очередь ещё подтверждает остановку. Повтор сохранит идентификатор действия." };
      }
      const warning = action === "resume" ? forget(oldPauses) : forget();
      const receipt = this.receipt(action, reply);
      return warning ? { ...receipt, text: `${receipt.text}\n${warning}`, failed: true } : receipt;
    } catch (error) {
      if (!sent) return { text: `Запрос не отправлен. ${errorText(error)}`, failed: true };
      if (stop && error instanceof HttpError && error.status === 404 && workRefused(error.body, target)) {
        const warning = forget();
        const detail = await this.detail(path);
        const fact = detailText(detail);
        const settled = detail?.cancel_state === "pending" || terminal.has(detail?.status ?? "");
        return { text: [settled ? "" : "Шлюз не нашёл активной работы для остановки.", fact, warning].filter(Boolean).join("\n"), failed: !settled || Boolean(warning) };
      }
      if (error instanceof HttpError && error.status < 500 && workRefused(error.body, target)) {
        const warning = forget();
        const facts = blockers(object(error.body).blockers);
        return { text: [errorText(error), facts, decisionNotice(), warning].filter(Boolean).join("\n"), failed: true };
      }
      if (stop && error instanceof HttpError && error.reason === "cancel_intent_write_failed" && workRefused(error.body, target)) {
        return { text: "Остановка не записана. Можно повторить запрос с тем же идентификатором.", failed: true };
      }
      if (stop && error instanceof HttpError && error.reason === "cancel_intent_projection_corrupt" && workRefused(error.body, target)) {
        return { text: "Шлюз отказал в остановке из-за повреждённых данных о запросах остановки.", failed: true };
      }
      const fact = stop || action === "resume" ? detailText(await this.detail(path)) : "";
      return { text: [`Результат действия неизвестен. ${errorText(error)}`, fact, decisionNotice()].filter(Boolean).join("\n"), failed: true };
    } finally { this.inFlight.delete(target); }
  }

  async continueTask(target: string, allowed: () => boolean): Promise<WorkResult> {
    if (this.closed || !exactWorkTarget(target) || !allowed()) return { text: "Действие больше недоступно для этой работы.", failed: true };
    if (this.busy(target)) return { text: "Действие для этой работы уже выполняется.", failed: true };
    const path = `/api/tasks/${encodeURIComponent(target)}`;
    const retainedPath = gatewayStatePath(this.gateway.base, `continue-${target}`);
    const readOffer = async (): Promise<ContinueOffer> => {
      const row = await this.gateway.json<Record<string, unknown>>("GET", path, undefined, undefined, false, this.cancel);
      if ((row?.task_id || row?.id) !== target) throw new Error("Шлюз вернул сведения о другой задаче.");
      return continuationOf(row, target);
    };
    this.inFlight.add(target);
    try {
      const offer = await readOffer();
      if (this.closed || !allowed()) return { text: "Действие больше недоступно для этой работы.", failed: true };
      if (offer.kind === "successor") return { text: "Шлюз подтвердил уже принятое продолжение.", successor: offer.successor };
      if (offer.kind !== "retry" && offer.kind !== "offer") return { text: offer.message || "Шлюз не предлагает продолжение задачи.", failed: true };
      let retained: unknown;
      if (!offer.nonce && GLib.file_test(retainedPath, GLib.FileTest.EXISTS)) retained = readGatewayState(retainedPath);
      if (retained !== undefined && !actionNonce(retained)) throw new Error("Сохранённый идентификатор продолжения повреждён.");
      const nonce = offer.nonce || (actionNonce(retained) ? retained : GLib.uuid_string_random());
      writeGatewayState(retainedPath, nonce);
      try {
        const reply = await this.gateway.json<Reply>("POST", `${path}/continue`, { action_nonce: nonce }, undefined, false, this.cancel);
        if (reply?.ok !== true || reply.unconfirmed || reply.predecessor_task_id !== target
          || !exactWorkTarget(reply.successor_task_id) || reply.successor_task_id === target || reply.task_id !== reply.successor_task_id
          || !workAccepted(reply, "continue", reply.successor_task_id)) {
          throw new Error(reply?.error || "Ответ шлюза не подтвердил продолжение этой задачи.");
        }
        return this.receipt("continue", reply);
      } catch (error) {
        const current = await readOffer().catch(() => undefined);
        if (current?.kind === "successor") return { text: "Шлюз подтвердил продолжение в сохранённой записи.", successor: current.successor };
        if (current?.kind === "retry") return { text: "Шлюз сохранил запрос. Повтор отправит его с тем же идентификатором.", failed: true };
        const body = error instanceof HttpError ? object(error.body) : {};
        const facts = Array.isArray(body.gaps) ? body.gaps.filter((gap): gap is string => typeof gap === "string").join(" · ") : "";
        const refused = error instanceof HttpError && error.status < 500 && body.unconfirmed !== true;
        return { text: [current?.message || (refused ? errorText(error) : `Продолжение пока не подтверждено. ${errorText(error)}`), facts]
          .filter(Boolean).join("\n"), failed: true };
      }
    } catch (error) {
      return { text: errorText(error), failed: true };
    } finally { this.inFlight.delete(target); }
  }

  private async detail(path: string): Promise<Detail | undefined> {
    if (this.closed) return undefined;
    try {
      const value = await this.gateway.json<Detail & { task_id?: string; id?: string }>(
        "GET", path, undefined, undefined, false, this.cancel);
      const target = decodeURIComponent(path.split("/").at(-1)!);
      const identities = value ? [value.task_id, value.id].filter(id => id !== undefined) : [];
      if (!value || !identities.length || identities.some(id => id !== target)
        || (value.status !== undefined && typeof value.status !== "string")
        || (value.cancel_state !== undefined && typeof value.cancel_state !== "string")) return undefined;
      return value;
    } catch { return undefined; }
  }

  private receipt(action: WorkAction, reply: Reply): WorkResult {
    let text: string;
    if (reply.cancel_state === "pending") text = "Остановка записана. Шлюз ещё завершает работу.";
    else if (action === "stop" || action === "stop_earlier" || action === "wrap_up") text = "Шлюз подтвердил завершение остановки.";
    else if (action === "pause") text = reply.state === "paused" ? "Пауза подтверждена."
      : reply.state === "released" ? "Эта пауза уже снята." : "Пауза записана. Работа сохраняет текущее состояние.";
    else if (action === "resume" || action === "continue") {
      text = reply.held ? ["Шлюз принял действие. Запуск ждёт завершения прежней работы.", blockers(reply.blockers)].filter(Boolean).join("\n")
        : reply.tree_only ? "Пауза снята с дерева задачи." : reply.late_phase === "settled" ? "Пауза снята. Завершённая задача не запускается повторно."
          : reply.late_phase === "resumed" ? "Возобновлена работа после уже доставленного ответа."
            : reply.late_phase ? `Шлюз подтвердил действие после доставки ответа. Состояние · ${reply.late_phase}`
          : action === "resume" ? "Возобновление принято." : reply.replay ? "Шлюз подтвердил уже принятое продолжение." : "Продолжение принято.";
    } else text = reply.duplicate ? "Ускорение уже было принято." : "Ускорение принято.";
    const gaps = reply.membership_gaps;
    if (gaps?.count && gaps.count > 0) {
      const names = (gaps.rows ?? []).map(({ task_id }) => task_id).filter(Boolean).join(", ");
      text += `\nНедоступные записи задач · ${gaps.count}${names ? ` · ${names}` : ""}`;
    }
    return { text, successor: action === "continue" ? reply.successor_task_id : undefined };
  }
}
