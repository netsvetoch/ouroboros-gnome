import { gatewayStatePath, readGatewayState, writeGatewayState } from "./gateway-state.js";
import { GLib } from "./gi.js";

export interface RoutingRequest { decision_id: string; request_id: string; option_index: number; comment?: string }
interface PendingRoute { chat: number; request: RoutingRequest; optionKey: string }
const record = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 2048
  && value === value.trim() && !/[\x00-\x1f\x7f]/u.test(value);
const key = (chat: number, decision: string) => JSON.stringify([chat, decision]);

function retained(value: unknown): PendingRoute | undefined {
  if (!record(value) || !Number.isSafeInteger(value.chat) || !record(value.request) || typeof value.optionKey !== "string") return undefined;
  const request = value.request;
  if (!identity(request.decision_id) || !/^routing:.+:[^:]+$/u.test(request.decision_id) || !identity(request.request_id)
    || !Number.isSafeInteger(request.option_index) || request.option_index < 0
    || (request.comment !== undefined && (typeof request.comment !== "string" || [...request.comment].length > 2000))
    || Object.keys(request).some(field => !["decision_id", "request_id", "option_index", "comment"].includes(field))) return undefined;
  let option: unknown;
  try { option = JSON.parse(value.optionKey); } catch { return undefined; }
  if (!Array.isArray(option) || option.length !== 5 || typeof option[3] !== "string"
    || (option[1] !== null && typeof option[1] !== "string") || (option[2] !== null && typeof option[2] !== "string")
    || (option[4] !== null && typeof option[4] !== "string")
    || (option[0] === "steer_task" ? !identity(option[1])
      : option[0] === "new_task_in_project" ? !identity(option[2]) : true)) return undefined;
  return { chat: value.chat, optionKey: value.optionKey, request: {
    decision_id: request.decision_id, request_id: request.request_id, option_index: request.option_index,
    ...(request.comment === undefined ? {} : { comment: request.comment }),
  } };
}

/** Pending owner decisions, scoped to one gateway. Each synchronous update merges fresh disk state
 * so independent Main/project controllers in the same application do not overwrite one another. */
export class RoutingJournal {
  private readonly path: string;
  constructor(base: string) { this.path = gatewayStatePath(base, "routing-decisions"); }

  private read(): Map<string, PendingRoute> {
    const entries = new Map<string, PendingRoute>();
    if (!GLib.file_test(this.path, GLib.FileTest.EXISTS)) return entries;
    try {
      const value = readGatewayState(this.path);
      if (!record(value) || value.version !== 1 || !Array.isArray(value.entries)) throw new Error();
      for (const raw of value.entries) {
        const item = retained(raw);
        if (!item || entries.has(key(item.chat, item.request.decision_id))) throw new Error();
        entries.set(key(item.chat, item.request.decision_id), item);
      }
      return entries;
    } catch { throw new Error("Не удалось прочитать журнал маршрутов клиента. Новые отправки не сохраняются поверх него."); }
  }

  pending(chat: number): PendingRoute[] { return [...this.read().values()].filter(item => item.chat === chat); }

  put(chat: number, request: RoutingRequest, optionKey: string): void {
    const item = retained({ chat, request, optionKey });
    if (!item) throw new Error("Не удалось сохранить точный запрос маршрутизации.");
    const entries = this.read();
    const previous = entries.get(key(chat, request.decision_id));
    if (previous && (JSON.stringify(previous.request) !== JSON.stringify(item.request) || previous.optionKey !== optionKey)) {
      throw new Error("Для этого маршрута уже сохранён другой запрос. Переоткройте окно и проверьте прежнюю отправку.");
    }
    entries.set(key(chat, request.decision_id), item);
    writeGatewayState(this.path, { version: 1, entries: [...entries.values()] });
  }

  forget(chat: number, request: RoutingRequest): void {
    const entries = this.read(), selected = key(chat, request.decision_id);
    if (entries.get(selected)?.request.request_id !== request.request_id) return;
    entries.delete(selected);
    writeGatewayState(this.path, { version: 1, entries: [...entries.values()] });
  }
}
