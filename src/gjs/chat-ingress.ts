import type { GatewayFrame } from "./gateway.js";
import { gatewayStatePath, readGatewayState, writeGatewayState } from "./gateway-state.js";
import { GLib } from "./gi.js";
import { object } from "./settings-write.js";

export interface SendAttachment { filename: string; display_name: string; mime: string }
export interface ChatSend extends GatewayFrame {
  type: "chat";
  chat_id: number;
  project_id?: string;
  content: string;
  client_message_id: string;
  client_surface?: Record<string, unknown>;
  sender_session_id?: string;
  reply_to?: string;
  attachments: SendAttachment[];
}
interface Tracked { frame: ChatSend; saved: boolean }
export type IngressState = "pending" | "dispatched" | "saved";

export function messageId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/u.test(value);
}

export function ingressState(value: unknown): IngressState | undefined {
  const row = object(value);
  if (row.role !== "user" || !messageId(row.client_message_id) || row.ingress_accepted !== true
    || row.origin_projected === true || row.lifecycle_virtual === true) return undefined;
  if (row.ingress_dispatched === true && row.ingress_pending !== true) return "dispatched";
  if (row.ingress_pending === true && row.ingress_dispatched !== true) return "pending";
  return "saved";
}

function retained(value: unknown): ChatSend | undefined {
  const row = object(value);
  const chat = row.chat_id;
  if (row.type !== "chat" || typeof chat !== "number" || !Number.isSafeInteger(chat) || chat <= 0
    || !messageId(row.client_message_id) || typeof row.content !== "string" || !Array.isArray(row.attachments)
    || (row.project_id !== undefined && typeof row.project_id !== "string")
    || (row.reply_to !== undefined && typeof row.reply_to !== "string")
    || (row.sender_session_id !== undefined && typeof row.sender_session_id !== "string")
    || (row.client_surface !== undefined && (!row.client_surface || typeof row.client_surface !== "object" || Array.isArray(row.client_surface)))) return undefined;
  const attachments: SendAttachment[] = [];
  for (const item of row.attachments) {
    const file = object(item);
    if (typeof file.filename !== "string" || !file.filename || typeof file.display_name !== "string"
      || typeof file.mime !== "string") return undefined;
    attachments.push({ filename: file.filename, display_name: file.display_name, mime: file.mime });
  }
  if (!row.content.trim() && !attachments.length) return undefined;
  return { type: "chat", chat_id: chat, client_message_id: row.client_message_id, content: row.content,
    project_id: row.project_id, reply_to: row.reply_to, attachments,
    ...(row.client_surface === undefined ? {} : { client_surface: row.client_surface as Record<string, unknown> }),
    ...(row.sender_session_id === undefined ? {} : { sender_session_id: row.sender_session_id }) };
}

export class ChatIngress {
  private readonly path: string;
  private readonly entries = new Map<string, Tracked>();
  private readonly retries = new Set<string>();
  issue = "";

  constructor(base: string) {
    this.path = gatewayStatePath(base, "chat-sends");
    if (!GLib.file_test(this.path, GLib.FileTest.EXISTS)) return;
    try {
      const data = readGatewayState(this.path);
      if (!Array.isArray(data)) throw new Error("invalid journal");
      for (const raw of data) {
        const item = object(raw);
        const frame = retained(item.frame);
        if (!frame || typeof item.saved !== "boolean") {
          this.issue = "Часть сохранённых отправок клиента не удалось восстановить.";
          continue;
        }
        const key = this.key(frame.chat_id, frame.client_message_id);
        this.entries.set(key, { frame, saved: item.saved });
        if (item.saved) this.retries.add(key);
      }
    } catch { this.issue = "Не удалось прочитать сохранённые отправки клиента."; }
  }

  private key(chat: number, id: string): string { return JSON.stringify([chat, id]); }

  draft(chat: number): ChatSend | undefined {
    return [...this.entries.values()].find(({ frame, saved }) => frame.chat_id === chat && !saved)?.frame;
  }

  track(frame: ChatSend): void {
    const key = this.key(frame.chat_id, frame.client_message_id);
    if (this.entries.has(key)) return;
    this.entries.set(key, { frame, saved: false });
    try { this.save(); }
    catch (error) {
      this.entries.delete(key);
      throw error;
    }
  }

  adopt(chat: number, id: string, state: IngressState, live: boolean): void {
    const key = this.key(chat, id);
    const entry = this.entries.get(key);
    if (!entry) return;
    if (live || state !== "pending") this.retries.delete(key);
    if (state === "pending") {
      if (entry.saved) return;
      entry.saved = true;
    } else this.entries.delete(key);
    this.saveObserved();
  }

  forget(frame: ChatSend): void {
    const key = this.key(frame.chat_id, frame.client_message_id);
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    try { this.save(); }
    catch (error) {
      this.entries.set(key, entry);
      throw error;
    }
    this.retries.delete(key);
  }

  disconnected(): void {
    for (const [key, entry] of this.entries) if (entry.saved) this.retries.add(key);
  }

  retryable(chat: number, id: string): ChatSend | undefined {
    const key = this.key(chat, id);
    return this.retries.has(key) ? this.entries.get(key)?.frame : undefined;
  }

  waiting(chat: number): boolean {
    return [...this.entries.values()].some(({ frame }) => frame.chat_id === chat);
  }

  private save(): void { writeGatewayState(this.path, [...this.entries.values()]); }

  private saveObserved(): void {
    try { this.save(); }
    catch { this.issue = "Не удалось обновить сохранённые отправки клиента."; }
  }
}
