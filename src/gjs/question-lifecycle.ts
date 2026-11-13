import { chromeText } from "./native-i18n.js";

export interface QuestionLifecycleFacts {
  answered_after_terminal?: boolean;
  delivery_after_terminal?: boolean;
  forwarded?: boolean;
  reason_code?: string;
  closed_reason?: string;
  closed_at?: string;
  closed_actor?: string;
  closed_request_id?: string;
  closed_by_task_id?: string;
  lifecycle_details_unavailable?: boolean;
}
const flags = ["answered_after_terminal", "delivery_after_terminal", "forwarded"] as const;
const strings = ["reason_code", "closed_reason", "closed_at", "closed_actor", "closed_request_id", "closed_by_task_id"] as const;
export function questionLifecycleFacts(raw: unknown): QuestionLifecycleFacts {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const input = raw as Record<string, unknown>, result: QuestionLifecycleFacts = {};
  let seen = false, bad = input.lifecycle_details_unavailable === true;
  for (const key of flags) if (input[key] !== undefined) {
    seen = true;
    if (typeof input[key] === "boolean") result[key] = input[key]; else bad = true;
  }
  for (const key of strings) if (input[key] != null) {
    seen = true;
    if (typeof input[key] === "string") result[key] = input[key]; else bad = true;
  }
  if (seen || bad) result.lifecycle_details_unavailable = bad;
  return result;
}

/** Closure provenance and declared late-answer routing are observations, never answer authority. */
export function questionLifecycleLines(raw: QuestionLifecycleFacts & { state?: string }, includeLate = true): string[] {
  const facts = questionLifecycleFacts(raw), lines: string[] = [];
  if (facts.lifecycle_details_unavailable) lines.push(chromeText("Some question lifecycle details could not be read.", undefined,
    "Часть сведений о закрытии или позднем ответе прочитать не удалось."));
  if (raw.state === "closed") {
    if (facts.closed_reason) lines.push(facts.closed_reason);
    if (facts.closed_actor) {
      const actor = facts.closed_actor === "owner" ? chromeText("Owner", undefined, "Владелец")
        : facts.closed_actor === "model" ? chromeText("Model", undefined, "Модель") : facts.closed_actor;
      lines.push(chromeText("Closed by · {actor}", { actor }, `Кто закрыл · ${actor}`));
    }
    for (const [key, english, russian] of [["closed_at", "Closed at · {value}", "Время закрытия"],
      ["closed_request_id", "Closure request · {value}", "Запрос закрытия"],
      ["closed_by_task_id", "Closing task · {value}", "Закрывшая задача"]] as const) {
      const value = facts[key];
      if (value) lines.push(chromeText(english, { value }, `${russian} · ${value}`));
    }
  }
  if (raw.state === "answered" && includeLate) {
    if (facts.answered_after_terminal) lines.push(chromeText("The task had already ended when the answer was recorded.", undefined,
      "Задача уже закончилась, когда ответ был записан."));
    else if (facts.delivery_after_terminal) lines.push(chromeText("The task ended before the answer could be delivered.", undefined,
      "Задача закончилась до доставки ответа."));
    if (facts.forwarded === true) lines.push(chromeText("The gateway confirmed forwarding the answer as an owner message in chat.", undefined,
      "Шлюз подтвердил передачу ответа в чат как сообщения владельца."));
    else if (facts.forwarded === false) lines.push(chromeText("Forwarding the answer as an owner message in chat is not confirmed.", undefined,
      "Передача ответа в чат как сообщения владельца не подтверждена."));
    if (facts.reason_code && (facts.answered_after_terminal || facts.delivery_after_terminal || facts.forwarded !== undefined))
      lines.push(chromeText("Answer routing detail · {reason}", { reason: facts.reason_code }, `Сведения о маршруте ответа · ${facts.reason_code}`));
  }
  return lines;
}
