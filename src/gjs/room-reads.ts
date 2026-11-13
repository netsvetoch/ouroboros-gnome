import { type Gateway } from "./gateway.js";
import { Gio, GLib } from "./gi.js";
import type { Room } from "./chat.js";

type Span = [number, number];
export interface RoomRevision { id: string; chat_id: number; visible_revision?: number | null }
interface Preferences {
  ok?: boolean;
  main_seen_revision?: number | null;
  project_seen_revision?: Record<string, number>;
  read_ahead_revisions?: Record<string, Span[]>;
}
interface Receipt { room: Room; revision: number }

const path = "/api/ui/preferences";
export const isRevision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function mergeSpans(spans: Span[], floor: number): Span[] {
  const merged: Span[] = [];
  for (const [from, to] of spans.filter((entry) => Array.isArray(entry) && isRevision(entry[0]) && isRevision(entry[1])
    && entry[0] > 0 && entry[0] <= entry[1] && entry[1] > floor).sort((a, b) => a[0] - b[0])) {
    const lo = Math.max(floor + 1, from);
    const last = merged.at(-1);
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], to);
    else merged.push([lo, to]);
  }
  return merged;
}

export class RoomReads {
  private readonly cancel = new Gio.Cancellable();
  private readonly revisions = new Map<number, number | null>();
  private readonly rooms = new Map<number, string>();
  private readonly projectSeen = new Map<string, number>();
  private readonly ahead = new Map<number, Span[]>();
  private readonly pending = new Map<number, Receipt>();
  private readonly shared = new Set<string>();
  private readonly sent = new Set<string>();
  private mainSeen?: number | null;
  private projectsLoaded = false;
  private readTimer = 0;
  private writeTimer = 0;
  private reading = false;
  private readAgain = false;
  private writing = false;
  private failures = 0;
  private closed = false;
  private readonly poll: number;

  constructor(private readonly gateway: Gateway, private readonly changed: () => void,
    private readonly observeState?: (snapshot: unknown, readAt: number) => void) {
    this.poll = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
      this.refresh();
      return GLib.SOURCE_CONTINUE;
    });
    this.refresh();
  }

  revision(room: Room): number | undefined {
    if (room.chatId === 1 ? this.mainSeen === undefined : !room.projectId || !this.projectsLoaded) return undefined;
    return this.revisions.get(room.chatId) ?? undefined;
  }

  unread(room: Room): number | undefined {
    const revision = this.revision(room);
    if (revision === undefined) return undefined;
    const seen = this.seen(room);
    let count = Math.max(0, revision - seen);
    for (const [from, to] of this.ahead.get(room.chatId) ?? []) {
      count -= Math.max(0, Math.min(revision, to) - Math.max(seen + 1, from) + 1);
    }
    return Math.max(0, count);
  }

  observeProjects(rows: RoomRevision[]): void {
    if (!this.closed && this.applyProjects(rows)) this.changed();
  }

  private applyProjects(rows: RoomRevision[]): boolean {
    let changed = false;
    for (const project of rows) {
      if (!project.id || !isRevision(project.chat_id) || project.chat_id <= 1) continue;
      this.rooms.set(project.chat_id, project.id);
      changed = this.observe(project.chat_id, project.visible_revision) || changed;
    }
    return changed;
  }

  refresh(): void {
    if (this.closed || this.readTimer) return;
    if (this.reading) { this.readAgain = true; return; }
    this.readTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
      this.readTimer = 0;
      void this.read();
      return GLib.SOURCE_REMOVE;
    });
  }

  acknowledge(room: Room, revision: number): void {
    const current = this.revision(room);
    const previous = this.pending.get(room.chatId);
    if (this.closed || current === undefined || revision > current || (previous && previous.revision >= revision)
      || (revision <= this.seen(room) && !(room.chatId === 1 && this.mainSeen === null))) return;
    this.pending.set(room.chatId, { room, revision });
    this.planWrite();
  }

  recordShared(address: string): void {
    if (this.closed || !address.startsWith("row:") || this.sent.has(address) || this.shared.has(address)) return;
    this.shared.add(address);
    this.planWrite();
  }

  close(): void {
    this.closed = true;
    GLib.Source.remove(this.poll);
    if (this.readTimer) GLib.Source.remove(this.readTimer);
    if (this.writeTimer) GLib.Source.remove(this.writeTimer);
    this.cancel.cancel();
  }

  private observe(chatId: number, value: unknown): boolean {
    if (!isRevision(value) && value !== null) return false;
    const previous = this.revisions.get(chatId);
    const revision = isRevision(value) && isRevision(previous) ? Math.max(previous, value) : value;
    if (previous === revision) return false;
    this.revisions.set(chatId, revision);
    return true;
  }

  private seen(room: Room): number {
    return room.chatId === 1 ? this.mainSeen ?? 0 : this.projectSeen.get(room.projectId ?? "") ?? 0;
  }

  private merge(preferences: Preferences): boolean {
    let changed = false;
    const main = preferences.main_seen_revision;
    if ((main === null && this.mainSeen === undefined) || (isRevision(main) && main > (this.mainSeen ?? -1))) {
      this.mainSeen = main;
      changed = true;
    }
    if (preferences.project_seen_revision && typeof preferences.project_seen_revision === "object") {
      changed = !this.projectsLoaded || changed;
      this.projectsLoaded = true;
      for (const [key, value] of Object.entries(preferences.project_seen_revision)) {
        if (!isRevision(value) || value <= (this.projectSeen.get(key) ?? 0)) continue;
        this.projectSeen.set(key, value);
        changed = true;
      }
    }
    for (const [chat, spans] of Object.entries(preferences.read_ahead_revisions ?? {})) {
      const id = Number(chat);
      if (!Number.isSafeInteger(id) || !Array.isArray(spans)) continue;
      const previous = this.ahead.get(id) ?? [];
      const merged = mergeSpans([...previous, ...spans], this.seen({ chatId: id, projectId: this.rooms.get(id), name: "" }));
      if (JSON.stringify(previous) !== JSON.stringify(merged)) {
        if (merged.length) this.ahead.set(id, merged);
        else this.ahead.delete(id);
        changed = true;
      }
    }
    for (const [chatId, spans] of this.ahead) {
      const kept = mergeSpans(spans, this.seen({ chatId, projectId: this.rooms.get(chatId), name: "" }));
      if (kept.length) this.ahead.set(chatId, kept);
      else this.ahead.delete(chatId);
    }
    return changed;
  }

  private async read(): Promise<void> {
    this.reading = true;
    const readAt = GLib.get_monotonic_time();
    try {
      const [state, prefs] = await Promise.allSettled([
        this.gateway.json<{ main_visible_revision?: number | null; projects?: RoomRevision[];
          task_bindings?: Record<string, unknown>; task_bindings_revision?: string }>(
          "GET", "/api/state", undefined, undefined, false, this.cancel),
        this.gateway.json<Preferences>("GET", path, undefined, undefined, false, this.cancel),
      ]);
      if (this.closed) return;
      let changed = prefs.status === "fulfilled" && prefs.value ? this.merge(prefs.value) : false;
      if (state.status === "fulfilled" && state.value) {
        this.observeState?.(state.value, readAt);
        changed = this.observe(1, state.value.main_visible_revision) || changed;
        if (Array.isArray(state.value.projects)) changed = this.applyProjects(state.value.projects) || changed;
      } else this.observeState?.(undefined, readAt);
      if (changed) this.changed();
    } finally {
      this.reading = false;
      if (this.readAgain) { this.readAgain = false; this.refresh(); }
    }
  }

  private planWrite(): void {
    if (this.closed || this.writing || this.writeTimer) return;
    const delay = this.failures ? Math.min(15, 2 ** (this.failures - 1)) * 1000 : 90;
    this.writeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
      this.writeTimer = 0;
      void this.write();
      return GLib.SOURCE_REMOVE;
    });
  }

  private async post(body: Record<string, unknown>): Promise<Preferences> {
    const saved = await this.gateway.json<Preferences>("POST", path, body, undefined, false, this.cancel);
    if (!saved || saved.ok !== true) throw new Error("Шлюз не подтвердил отметку прочтения.");
    return saved;
  }

  private async write(): Promise<void> {
    this.writing = true;
    let failed = false;
    try {
      const receipts = [...this.pending.values()];
      if (receipts.length) {
        const patch: Record<string, unknown> = {};
        const projects: Record<string, number> = Object.create(null);
        for (const { room, revision } of receipts) {
          if (room.chatId === 1) patch.main_seen_revision = revision;
          else if (room.projectId) projects[room.projectId] = revision;
        }
        if (Object.keys(projects).length) patch.project_seen_revision = projects;
        try {
          const saved = await this.post(patch);
          if (this.closed) return;
          for (const receipt of receipts) if (this.pending.get(receipt.room.chatId) === receipt) this.pending.delete(receipt.room.chatId);
          if (this.merge(saved)) this.changed();
        } catch { failed = true; }
      }
      const shared = [...this.shared].slice(0, 64);
      if (shared.length && !this.closed) {
        try {
          const saved = await this.post({ shared_read: shared });
          if (this.closed) return;
          for (const address of shared) { this.shared.delete(address); this.sent.add(address); }
          while (this.sent.size > 4096) this.sent.delete(this.sent.values().next().value!);
          if (this.merge(saved)) this.changed();
        } catch { failed = true; }
      }
    } finally {
      this.writing = false;
      this.failures = failed ? Math.min(5, this.failures + 1) : 0;
      if (this.pending.size || this.shared.size) this.planWrite();
    }
  }
}
