import { resolveConfig, type GatewayConfig } from "./config.js";
import type {
  ChatHistoryResponse,
  DecisionRequest,
  StateResponse,
  TaskCreateRequest,
  TaskCreateResponse,
} from "./types.js";

/**
 * Тонкий клиент поверх gateway. Ноль зависимостей: глобальный fetch Node 26.
 * Каждый метод — один HTTP-вызов, ответ — как есть, без кэша и ретраев:
 * ретраи — решение UI, не клиента (см. BIBLE P5 в репозитории сервера).
 */
export class ApiClient {
  constructor(private cfg: GatewayConfig = resolveConfig()) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {
      Accept: "application/json",
      ...extra,
    };
    if (this.cfg.password) h["Authorization"] = `Bearer ${this.cfg.password}`;
    return h;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(this.cfg.baseUrl + path, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
    return (await res.json()) as T;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(this.cfg.baseUrl + path, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`POST ${path} -> ${res.status} ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  health(): Promise<unknown> {
    return this.get("/api/health");
  }

  state(): Promise<StateResponse> {
    return this.get<StateResponse>("/api/state");
  }

  chatHistory(chatId = 1, limit = 50): Promise<ChatHistoryResponse> {
    const q = new URLSearchParams({
      chat_id: String(chatId),
      limit: String(limit),
    });
    return this.get<ChatHistoryResponse>(`/api/chat/history?${q}`);
  }

  projects(): Promise<{ projects: unknown[] }> {
    return this.get("/api/projects");
  }

  createTask(req: TaskCreateRequest): Promise<TaskCreateResponse> {
    return this.post<TaskCreateResponse>("/api/tasks", req);
  }

  task(id: string): Promise<unknown> {
    return this.get(`/api/tasks/${encodeURIComponent(id)}`);
  }

  cancelTask(id: string): Promise<unknown> {
    return this.post(`/api/tasks/${encodeURIComponent(id)}/cancel`, {
      request_id: `ts-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    });
  }

  /** v2 cursor API: {v:2, wait, cursor}; wait=0 — однократное чтение. */
  taskEvents(id: string, wait = 0): Promise<unknown> {
    return this.post(`/api/tasks/${encodeURIComponent(id)}/events`, {
      v: 2,
      wait,
      cursor: null,
    });
  }

  answerDecision(req: DecisionRequest): Promise<unknown> {
    return this.post("/api/decisions", req);
  }
}
