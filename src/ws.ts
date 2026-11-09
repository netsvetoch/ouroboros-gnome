import { resolveConfig, type GatewayConfig } from "./config.js";
import type { ChatInbound } from "./types.js";

export type WsHandler = (msg: Record<string, unknown>) => void;

/**
 * Живой чат поверх /ws. Протокол — как у веба (см. gateway/ws.py):
 * туда  {type:"chat", content, chat_id, client_message_id},
 * оттуда ChatOutbound и служебные кадры.
 *
 * Правила, скопированные с web/modules чтобы не разъехаться:
 * - client_message_id делает повтор безопасным (сервер склеивает дубли);
 * - неотправленное ждёт в памяти и уходит после reconnect, reload его теряет;
 * - Panic/Restart идут командными кадрами, обычный текст — никогда не команда.
 */
export class WsChat {
  private ws: WebSocket | null = null;
  private queue: ChatInbound[] = [];
  private wantClose = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private cfg: GatewayConfig = resolveConfig(),
    private onMessage: WsHandler = () => {},
  ) {}

  connect(): void {
    this.wantClose = false;
    this.open();
  }

  close(): void {
    this.wantClose = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }

  send(content: string, chatId = 1): void {
    const frame: ChatInbound = {
      type: "chat",
      content,
      chat_id: chatId,
      client_message_id: `web-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    };
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    } else {
      this.queue.push(frame); // уйдёт при reconnect, как в вебе
    }
  }

  sendCommand(cmd: string): void {
    const frame = { type: "command", cmd };
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  private open(): void {
    if (this.wantClose) return;
    const ws = new WebSocket(this.cfg.wsUrl);
    this.ws = ws;
    ws.onopen = () => {
      for (const f of this.queue.splice(0)) ws.send(JSON.stringify(f));
    };
    ws.onmessage = (ev) => {
      try {
        this.onMessage(JSON.parse(String(ev.data)));
      } catch {
        /* чужой кадр — игнорируем, как веб */
      }
    };
    ws.onclose = () => {
      this.ws = null;
      if (!this.wantClose) {
        // ограниченный экспоненциальный backoff, как в web/modules/ws.js
        this.timer = setTimeout(() => this.open(), 2000);
      }
    };
    ws.onerror = () => ws.close();
  }
}
