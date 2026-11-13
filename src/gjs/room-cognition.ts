import type { Room } from "./chat.js";
import { type Gateway, HttpError, query } from "./gateway.js";
import { Gio, GLib } from "./gi.js";
import { object, ownerHeaders, settingsFailure, unsaved } from "./settings-write.js";
import { errorText } from "./ui.js";

export const contextModes = ["nano", "low", "max"];
export const subagentModes = ["off", "auto", "swarm"];
export const effortLevels = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const fields = ["min", "recommended", "max"] as const;

export interface EffortRange { min: string; recommended: string; max: string }
export interface Cognition { context_mode?: string; subagents_mode?: string; effort_range?: EffortRange }
export type RoomChange = { setting: "context-mode" | "subagents-mode"; mode: string } | { setting: "effort-range"; range: EffortRange };
export type Availability = "available" | "disabled" | "unsaved";
interface Result { ok: boolean; message: string }
interface Entry { value: Cognition; readAt: number }
interface ProjectCognition { id?: string; lifecycle?: string; cognition?: unknown }
type Snapshot = Cognition & { subagents_availability?: Availability; projects?: ProjectCognition[] };

export function cognitionScope(room: Room): string | undefined {
  return room.chatId === 1 ? "" : room.projectId || undefined;
}

export function validEffort(range: EffortRange): boolean {
  return fields.every((key) => effortLevels.includes(range[key])) && effortLevels.indexOf(range.min) <= effortLevels.indexOf(range.max);
}

function readCognition(input: unknown, legacyProject = false): Cognition | undefined {
  const value = object(input);
  const range = object(value.effort_range);
  const effort = { min: String(range.min ?? ""), recommended: String(range.recommended ?? ""), max: String(range.max ?? "") };
  const context_mode = typeof value.context_mode === "string" && contextModes.includes(value.context_mode) ? value.context_mode : undefined;
  const subagents_mode = typeof value.subagents_mode === "string" && subagentModes.includes(value.subagents_mode)
    ? value.subagents_mode : legacyProject && value.subagents_mode == null ? "auto" : undefined;
  const effort_range = validEffort(effort) ? effort : undefined;
  if (context_mode || subagents_mode || effort_range) return { context_mode, subagents_mode, effort_range };
  return undefined;
}

function matches(value: Cognition, change: RoomChange): boolean {
  if (change.setting === "context-mode") return value.context_mode === change.mode;
  if (change.setting === "subagents-mode") return value.subagents_mode === change.mode;
  if (change.setting !== "effort-range") return false;
  return fields.every((key) => value.effort_range?.[key] === change.range[key]);
}

export class RoomCognition {
  private readonly cancel = new Gio.Cancellable();
  private readonly listeners = new Set<() => void>();
  private readonly values = new Map<string, Entry>();
  private readonly reads = new Map<string, Promise<void>>();
  private readonly saves = new Map<string, Promise<Result>>();
  private readonly feedbacks = new Map<string, string>();
  private readonly readErrors = new Map<string, string>();
  private readonly lastSave = new Map<string, number>();
  private stateRead?: Promise<{ snapshot: Snapshot; readAt: number }>;
  private availabilityAt = 0;
  private closed = false;
  availability?: Availability;

  constructor(private readonly gateway: Gateway) {}

  get(scope: string | undefined): Cognition | undefined { return scope === undefined ? undefined : this.values.get(scope)?.value; }

  pending(scope: string | undefined): Promise<Result> | undefined { return scope === undefined ? undefined : this.saves.get(scope); }

  feedback(scope: string | undefined): string {
    return scope === undefined ? "" : this.feedbacks.get(scope) ?? this.readErrors.get(scope) ?? "";
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    this.cancel.cancel();
    this.listeners.clear();
  }

  observeState(snapshot: unknown, readAt: number): void {
    if (this.closed || !snapshot || typeof snapshot !== "object") return;
    const state = snapshot as Snapshot;
    let changed = false;
    const availability = state.subagents_availability;
    if (readAt >= this.availabilityAt && (availability === "available" || availability === "disabled" || availability === "unsaved")) {
      this.availabilityAt = readAt;
      changed = this.availability !== availability;
      this.availability = availability;
    }
    changed = this.accept("", readCognition(state), readAt) || changed;
    if (Array.isArray(state.projects)) {
      for (const item of state.projects) {
        if (!item.id || (item.lifecycle && item.lifecycle !== "active")) continue;
        changed = this.accept(item.id, readCognition(item.cognition, true), readAt) || changed;
      }
    }
    if (changed) this.notify();
  }

  refresh(scope = ""): Promise<void> {
    if (this.closed) return Promise.resolve();
    const pending = this.reads.get(scope);
    if (pending) return pending;
    const read = this.readScope(scope, false).then(() => {
      if (this.readErrors.delete(scope)) this.notify();
    }).catch((error: unknown) => {
      if (this.closed) return;
      this.readErrors.set(scope, "Не удалось прочитать настройки комнаты. " + errorText(error));
      this.notify();
    }).finally(() => { this.reads.delete(scope); });
    this.reads.set(scope, read);
    return read;
  }

  save(scope: string, change: RoomChange, callerCancel?: any): Promise<Result> {
    const cancelled = { ok: false, message: "Ожидание сохранения отменено. Результат проверяется отдельно." };
    if (callerCancel?.is_cancelled()) return Promise.resolve({ ok: false, message: "Сохранение не отправлено: ожидание отменено." });
    const pending = this.saves.get(scope);
    if (pending) return Promise.resolve({ ok: false, message: "Сохранение параметров комнаты уже идёт." });
    if (this.closed) return Promise.resolve({ ok: false, message: "Соединение с комнатой закрыто." });
    // The initiating window may stop waiting, while shared room users still await reconciliation.
    const transportCancel = callerCancel ? new Gio.Cancellable() : this.cancel;
    let callerSignal: number | undefined, serviceSignal: number | undefined;
    let finishCaller: ((result: Result) => void) | undefined;
    const caller = callerCancel ? new Promise<Result>(resolve => { finishCaller = resolve; }) : undefined;
    if (callerCancel) {
      serviceSignal = this.cancel.connect(() => transportCancel.cancel());
      callerSignal = callerCancel.connect(() => { transportCancel.cancel(); finishCaller?.(cancelled); });
    }
    const saving = this.write(scope, change, transportCancel).then((result) => {
      if (!this.closed) this.feedbacks.set(scope, result.message);
      return result;
    }).finally(() => {
      this.lastSave.set(scope, GLib.get_monotonic_time());
      this.saves.delete(scope);
      if (callerCancel) GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        // Never disconnect Gio.Cancellable from inside its own cancellation callback.
        if (callerSignal !== undefined) callerCancel.disconnect(callerSignal);
        if (serviceSignal !== undefined) this.cancel.disconnect(serviceSignal);
        return GLib.SOURCE_REMOVE;
      });
      this.notify();
    });
    this.feedbacks.delete(scope);
    this.readErrors.delete(scope);
    this.saves.set(scope, saving);
    this.notify();
    if (caller) {
      void saving.then(result => finishCaller?.(result), error => finishCaller?.({ ok: false, message: errorText(error) }));
      return caller;
    }
    return saving;
  }

  private notify(): void {
    if (!this.closed) for (const listener of this.listeners) listener();
  }

  private accept(scope: string, value: Cognition | undefined, readAt: number, force = false): boolean {
    if (!value || this.closed || (!force && (this.saves.has(scope) || readAt < (this.lastSave.get(scope) ?? 0)))) return false;
    const previous = this.values.get(scope);
    if (previous && readAt < previous.readAt) return false;
    this.values.set(scope, { value, readAt });
    return JSON.stringify(previous?.value) !== JSON.stringify(value);
  }

  private state(): Promise<{ snapshot: Snapshot; readAt: number }> {
    if (!this.stateRead) {
      const readAt = GLib.get_monotonic_time();
      this.stateRead = this.gateway.json<Snapshot>("GET", "/api/state", undefined, undefined, false, this.cancel)
        .then((snapshot) => ({ snapshot, readAt })).finally(() => { this.stateRead = undefined; });
    }
    return this.stateRead;
  }

  private async readScope(scope: string, reconcile: boolean): Promise<void> {
    const readAt = GLib.get_monotonic_time();
    if (!scope) {
      const source = reconcile ? { snapshot: await this.gateway.json<Snapshot>("GET", "/api/state", undefined, undefined, false, this.cancel), readAt }
        : await this.state();
      const value = readCognition(source.snapshot);
      if (!value) throw new Error("Шлюз не вернул параметры Main.");
      this.observeState(source.snapshot, source.readAt);
      if (reconcile && this.accept("", value, source.readAt, true)) this.notify();
      return;
    }
    const state = !reconcile ? this.state().then((source) => {
      this.observeState(source.snapshot, source.readAt);
      const project = source.snapshot?.projects?.find((item) => item.id === scope && (!item.lifecycle || item.lifecycle === "active"));
      const value = readCognition(project?.cognition);
      return Boolean(value?.context_mode && value.effort_range);
    }).catch(() => false) : Promise.resolve(false);
    if (await state) return;
    const projectReadAt = GLib.get_monotonic_time();
    const { projects } = await this.gateway.json<{ projects?: ProjectCognition[] }>(
      "GET", "/api/projects" + query({ id: scope }), undefined, undefined, false, this.cancel);
    const row = projects?.find((item) => item.id === scope && (!item.lifecycle || item.lifecycle === "active"));
    const value = row && readCognition(row.cognition, true);
    if (!value) throw new Error("Шлюз не вернул параметры проекта.");
    if (this.accept(scope, value, projectReadAt, reconcile)) this.notify();
  }

  private async write(scope: string, change: RoomChange, transportCancel: any): Promise<Result> {
    if (change.setting === "effort-range" && !validEffort(change.range)) {
      return { ok: false, message: "Минимальное усилие должно быть не выше максимального. Основное усилие выбирается отдельно." };
    }
    if (change.setting === "context-mode" && !contextModes.includes(change.mode)) return { ok: false, message: "Неизвестный режим контекста." };
    if (change.setting === "subagents-mode" && (!subagentModes.includes(change.mode)
      || (change.mode !== "off" && (this.availability === "disabled" || this.availability === "unsaved")))) {
      return { ok: false, message: "Настройка субагентов недоступна. Сохранённый режим оставлен." };
    }
    const payload = change.setting === "effort-range" ? change.range : { mode: change.mode };
    try {
      const reply = await this.gateway.json<{ ok?: boolean; project_id?: string; cognition?: unknown }>("POST",
        `/api/owner/${change.setting}`, { ...payload, project_id: scope || undefined }, ownerHeaders, false, transportCancel);
      const value = readCognition(reply?.cognition);
      if (reply?.ok !== true || (reply.project_id ?? "") !== scope || !value || !matches(value, change)) {
        throw new Error("Шлюз не вернул подтверждённые параметры этой комнаты.");
      }
      this.accept(scope, value, GLib.get_monotonic_time(), true);
      return { ok: true, message: "Настройки комнаты сохранены." };
    } catch (error) {
      let message = settingsFailure(error);
      if (!this.closed && !unsaved(error)) {
        try { await this.readScope(scope, true); }
        catch { message += " Не удалось перечитать сохранённые параметры."; }
      }
      if (error instanceof HttpError && object(error.body).code === "project_unavailable") this.values.delete(scope);
      return { ok: false, message };
    }
  }
}
