/**
 * Подмножество gateway-контракта, сверенное с живым GET /api/contract (abi 7.0).
 * Полный контракт — на сервере; здесь только то, что использует v0.1.
 * Если контракт обновится — обнови эти типы и ничего больше.
 */

export interface TaskCreateRequest {
  description: string;
  title?: string;
  chat_id?: number;
  project_id?: string;
  context?: string;
  expected_output?: string;
  constraints?: string;
  timeout_sec?: number;
  reasoning_effort?: string;
}

export interface TaskCreateResponse {
  ok?: boolean;
  task_id?: string;
  status?: string;
  error?: string;
  reason_code?: string;
}

export interface ChatMessage {
  text: string;
  role: "user" | "assistant" | "system";
  ts: string;
  task_id?: string;
  is_progress?: boolean;
  system_type?: string;
  row_address?: string;
}

export interface ChatHistoryResponse {
  messages: ChatMessage[];
}

export interface ChatInbound {
  type: "chat";
  content: string;
  chat_id?: number;
  project_id?: string;
  client_message_id?: string;
}

export interface DecisionRequest {
  decision_id: string; // `quiz:{task}:{quiz}` | `routing:...` | `model_wait:...` | `card:...`
  request_id: string; // idempotency key — повтор возвращает записанное подтверждение
  option_index?: number;
  comment?: string;
  action?: "auto_continue" | "switch" | "retry" | "close" | "dismiss";
}

export interface ProjectRow {
  id: string;
  name: string;
  chat_id: number;
  lifecycle: string;
}

/** Минимальный срез /api/state, нужный клиенту. Остальное игнорируем. */
export interface StateResponse {
  task_bindings?: Record<string, { project_id: string; chat_id: number; project_name: string }>;
  workers_alive?: number;
  supervisor_ready?: boolean;
  boot?: { phase: string };
}
