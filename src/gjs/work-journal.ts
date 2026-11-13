import { gatewayStatePath, readGatewayState, writeGatewayState } from "./gateway-state.js";
import { GLib } from "./gi.js";

export type StableWorkBody = { request_id: string; actor: "owner"; reason?: string }
  | { request_id: string } | { cascade: boolean; stop_policy: "immediate" | "finalize_then_cancel"; stop_action_id: string };
interface Entry { key: string; body: StableWorkBody }
const record = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && value.length <= 128 && value.trim() === value && !/[\x00-\x1f\x7f]/u.test(value);
export const workRequestId = (body: StableWorkBody): string => "request_id" in body ? body.request_id : body.stop_action_id;

function entry(raw: unknown): Entry | undefined {
  if (!record(raw) || typeof raw.key !== "string" || !record(raw.body)
    || Object.keys(raw).some(field => !["key", "body"].includes(field))) return undefined;
  let key: unknown;
  try { key = JSON.parse(raw.key); } catch { return undefined; }
  if (!Array.isArray(key) || key.length !== 4 || JSON.stringify(key) !== raw.key
    || typeof key[0] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(key[0]) || key[0] === "active"
    || typeof key[3] !== "string") return undefined;
  const body = raw.body;
  if (key[1] === "pause") {
    if (key[2] !== null || body.actor !== "owner" || !identity(body.request_id)
      || (Object.hasOwn(body, "reason") && typeof body.reason !== "string")
      || Object.keys(body).some(field => !["request_id", "actor", "reason"].includes(field))) return undefined;
    return { key: raw.key, body: { request_id: body.request_id, actor: "owner", ...(Object.hasOwn(body, "reason") ? { reason: body.reason } : {}) } };
  }
  if (key[1] === "hurry") {
    if (key[2] !== null || !identity(body.request_id) || Object.keys(body).some(field => field !== "request_id")) return undefined;
    return { key: raw.key, body: { request_id: body.request_id } };
  }
  if (!["immediate", "finalize_then_cancel"].includes(key[1]) || typeof key[2] !== "boolean"
    || body.cascade !== key[2] || body.stop_policy !== key[1] || !identity(body.stop_action_id)
    || Object.keys(body).some(field => !["cascade", "stop_policy", "stop_action_id"].includes(field))) return undefined;
  return { key: raw.key, body: { cascade: body.cascade, stop_policy: body.stop_policy, stop_action_id: body.stop_action_id } };
}

/** Synchronous read/merge/write preserves separate controllers' entries in this process.
 * Reading never sends a request. Resume has no idempotency token and is never journaled. */
export class WorkJournal {
  private readonly path: string;
  constructor(base: string) { this.path = gatewayStatePath(base, "work-actions"); }

  private read(): Map<string, StableWorkBody> {
    const entries = new Map<string, StableWorkBody>();
    if (!GLib.file_test(this.path, GLib.FileTest.EXISTS)) return entries;
    try {
      const value = readGatewayState(this.path);
      if (!record(value) || value.version !== 1 || !Array.isArray(value.entries)) throw new Error();
      for (const raw of value.entries) {
        const item = entry(raw);
        if (!item || entries.has(item.key)) throw new Error();
        entries.set(item.key, item.body);
      }
      return entries;
    } catch { throw new Error("Не удалось прочитать журнал действий клиента. Исходные запросы сохранены без изменений."); }
  }

  pending(key: string): StableWorkBody | undefined { return this.read().get(key); }

  forTask(target: string): Entry[] {
    return [...this.read()].filter(([key]) => JSON.parse(key)[0] === target).map(([key, body]) => ({ key, body }));
  }

  pauses(target: string): Entry[] {
    return this.forTask(target).filter(({ key }) => JSON.parse(key)[1] === "pause");
  }

  put(key: string, body: StableWorkBody): void {
    const item = entry({ key, body });
    if (!item) throw new Error("Не удалось сохранить точный запрос действия.");
    const entries = this.read(), prior = entries.get(key);
    if (prior && JSON.stringify(prior) !== JSON.stringify(item.body)) {
      throw new Error("Для этого действия уже сохранён другой запрос. Переоткройте форму перед повтором.");
    }
    entries.set(key, item.body);
    this.write(entries);
  }

  forget(items: Entry[]): void {
    const entries = this.read();
    let changed = false;
    for (const { key, body } of items) {
      const prior = entries.get(key);
      if (prior && workRequestId(prior) === workRequestId(body)) { entries.delete(key); changed = true; }
    }
    if (changed) this.write(entries);
  }

  private write(entries: Map<string, StableWorkBody>): void {
    writeGatewayState(this.path, { version: 1, entries: [...entries].map(([key, body]) => ({ key, body })) });
  }
}
