import { type Gateway } from "./gateway.js";
import { Gio, GLib } from "./gi.js";
import { exactWorkTarget, type WorkControl, WorkActions, workActionNames } from "./work-actions.js";
import { validWorkSnapshot } from "./work-read.js";

export interface WorkReason { code?: string; text?: string; count?: number;
  by?: { actor?: string; text?: string }; wake?: { kind?: string; name?: string; count?: number; at?: string }[] }
export interface WorkResume { at?: unknown; by?: { actor?: string }; error?: string; text?: string }
export interface WorkGap { reason: string; task_id?: string }
export interface Work {
  work_id: string;
  room?: number | string;
  name?: string;
  project_id?: string;
  episode?: { task_id?: string; live?: boolean };
  activity?: string;
  transition?: string;
  call?: string;
  because?: WorkReason[];
  tails?: WorkReason[];
  turn?: { kind?: string; task_id?: string; quiz_id?: string; wait_id?: string; code?: string }[];
  controls?: WorkControl[];
  confirmed?: boolean;
  mark?: string;
  focus?: { text?: string };
  outcome?: string;
  last_resume?: WorkResume;
  members?: { ids?: string[]; states?: Record<string, { activity?: string; last_resume?: WorkResume; reasons?: WorkReason[] }> };
}

interface RoomStatus { activity?: string; transition?: string; call?: string; amber?: boolean; confirmed?: boolean }
interface Snapshot {
  works?: Work[];
  rooms?: Record<string, RoomStatus>;
  works_complete?: boolean;
  works_gaps?: unknown;
  supervisor_ready?: boolean;
  active_chat_activities?: { activity_id?: string; task_attempt?: unknown }[];
}

function unconfirmed(work: Work): Work {
  return { ...work, confirmed: false, activity: "unknown", transition: undefined, call: undefined,
    because: [], tails: [], turn: [], controls: [], members: { ids: work.members?.ids },
    focus: undefined, last_resume: undefined, mark: "ring" };
}

export function activityWord(work: RoomStatus): string {
  if (work.confirmed === false) return "Не подтверждено";
  if (work.transition === "pausing") return "Переходит на паузу";
  if (work.transition === "finalizing") return "Завершает работу";
  if (work.activity === "working") {
    if (work.call === "preparing") return "Готовит запрос";
    if (work.call === "sending") return "Отправляет запрос";
    if (work.call === "thinking") return "Думает";
    return "В работе";
  }
  const words: Record<string, string> = { queued: "В очереди", waiting: "Ожидает", paused: "На паузе", idle: "Нет активной работы" };
  return Object.hasOwn(words, work.activity ?? "") ? words[work.activity!]! : "Не подтверждено";
}

function knownControl(control: WorkControl): boolean {
  return Boolean(control && exactWorkTarget(control.target) && control.action !== "continue" && Object.hasOwn(workActionNames, control.action)
    && (control.scope === undefined || control.scope === "cascade" || control.scope === "single"));
}

export class WorkState {
  readonly actions: WorkActions;
  private readonly cancel = new Gio.Cancellable();
  private readonly listeners = new Set<() => void>();
  private works: Work[] = [];
  private rooms: Record<string, RoomStatus> = {};
  private attempts = new Map<string, string>();
  private at = 0;
  private connectedAt = 0;
  private connected = false;
  private ready = false;
  private closed = false;
  private reading?: Promise<boolean>;
  private readingAt = 0;
  loaded = false;
  legacy = false;
  complete = false;
  readUnavailable = false;
  gaps: WorkGap[] = [];
  gapsUnavailable = false;

  constructor(private readonly gateway: Gateway) { this.actions = new WorkActions(gateway); }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  changed(): void { if (!this.closed) for (const listener of this.listeners) listener(); }

  setConnected(connected: boolean): void {
    if (connected === this.connected || this.closed) return;
    this.connected = connected;
    this.connectedAt = GLib.get_monotonic_time();
    this.ready = false;
    this.complete = false;
    this.legacy = false;
    this.readUnavailable = this.loaded;
    if (this.gaps.length) this.gapsUnavailable = true;
    if (!connected) this.works = this.works.map(unconfirmed);
    this.changed();
    if (connected) void this.refresh();
  }

  observe(value: unknown, readAt: number): boolean {
    if (this.closed || readAt < this.connectedAt) return false;
    if (readAt < this.at) return this.ready;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      this.failed(readAt);
      return false;
    }
    const body = value as Snapshot;
    this.at = readAt;
    if (!Array.isArray(body.works)) {
      if (!this.loaded && !Object.hasOwn(body, "works") && typeof body.supervisor_ready === "boolean") {
        this.legacy = this.connected && body.supervisor_ready;
        this.readUnavailable = !this.legacy;
        this.changed();
      } else this.unavailable();
      return false;
    }
    if (!validWorkSnapshot(body)) { this.unavailable();return false; }
    this.loaded = true;
    this.legacy = false;
    this.readUnavailable = false;
    this.ready = this.connected && body.supervisor_ready === true;
    this.complete = this.ready && body.works_complete === true;
    if (body.works_gaps === undefined) { this.gaps = [];this.gapsUnavailable = false; }
    else if (Array.isArray(body.works_gaps) && body.works_gaps.every(item => item && typeof item === "object" && !Array.isArray(item)
      && typeof item.reason === "string" && item.reason.length > 0
      && (item.task_id === undefined || typeof item.task_id === "string"))) {
      this.gaps = body.works_gaps.map(item => ({ reason: item.reason, ...(item.task_id === undefined ? {} : { task_id: item.task_id }) }));
      this.gapsUnavailable = !this.ready;
    } else this.gapsUnavailable = true;
    const seen = new Set<string>();
    const fresh: Work[] = [];
    for (const item of body.works) {
      if (!item || typeof item.work_id !== "string" || !item.work_id || seen.has(item.work_id)) continue;
      seen.add(item.work_id);
      fresh.push(this.ready && item.confirmed === true ? item : unconfirmed(item));
    }
    this.works = this.complete ? fresh : [...fresh, ...this.works.filter((work) => !seen.has(work.work_id)).map(unconfirmed)];
    this.rooms = body.rooms && typeof body.rooms === "object" ? body.rooms : {};
    this.attempts = new Map((Array.isArray(body.active_chat_activities) ? body.active_chat_activities : [])
      .filter((item) => exactWorkTarget(item?.activity_id))
      .map((item) => [item.activity_id!, JSON.stringify(item.task_attempt ?? null)]));
    this.changed();
    return true;
  }

  failed(readAt: number): void {
    if (!this.closed && readAt >= this.at && readAt >= this.connectedAt) {
      this.at = readAt;
      this.unavailable();
    }
  }

  refresh(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    if (this.reading) return this.readingAt >= this.connectedAt ? this.reading : this.reading.then(() => this.refresh());
    const readAt = GLib.get_monotonic_time();
    this.readingAt = readAt;
    this.reading = this.gateway.json<Snapshot>("GET", "/api/state", undefined, undefined, false, this.cancel)
      .then((body) => this.observe(body, readAt)).catch(() => {
        this.failed(readAt);
        return false;
      }).finally(() => { this.reading = undefined; });
    return this.reading;
  }

  close(): void {
    this.closed = true;
    this.cancel.cancel();
    this.actions.close();
    this.listeners.clear();
  }

  list(chatId?: number): Work[] {
    return chatId === undefined ? this.works : this.works.filter((work) => String(work.room ?? "") === String(chatId));
  }

  room(chatId: number): RoomStatus {
    const room = this.rooms[String(chatId)];
    const unknownRoom = this.works.some(work => work.room == null || work.room === ""
      || typeof work.room === "string" && !Number.isSafeInteger(Number(work.room)));
    const absent = this.complete && !unknownRoom && !this.list(chatId).length;
    return this.ready && room ? (room.confirmed === true ? room : { activity: "unknown", confirmed: false })
      : { activity: absent ? "idle" : "unknown", confirmed: absent };
  }

  controls(work: Work): WorkControl[] {
    if (!this.ready || !this.works.includes(work) || work.confirmed !== true || !Array.isArray(work.controls)) return [];
    return work.controls.filter(knownControl);
  }

  forTask(taskId: string): { work: Work; control: WorkControl }[] {
    return this.works.flatMap((work) => this.controls(work).filter((control) => control.target === taskId)
      .map((control) => ({ work, control })));
  }

  attempt(control: WorkControl): string { return this.attempts.get(control.target) ?? ""; }

  allows(workId: string, control: WorkControl, attempt: string): boolean {
    const work = this.works.find((item) => item.work_id === workId);
    return Boolean(work && this.attempt(control) === attempt && this.controls(work)
      .some((candidate) => candidate.action === control.action && candidate.target === control.target && candidate.scope === control.scope));
  }

  private unavailable(): void {
    this.ready = false;
    this.complete = false;
    this.legacy = false;
    this.readUnavailable = true;
    if (this.gaps.length) this.gapsUnavailable = true;
    this.works = this.works.map(unconfirmed);
    this.changed();
  }
}
