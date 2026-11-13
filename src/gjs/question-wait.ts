import { chromeText } from "./native-i18n.js";
export interface QuestionWaitFacts {
  wait_for_answer?: boolean;
  owner_wait_state?: string;
  owner_wait_resume_reason?: string;
  wait_ended_at?: string;
  _native_wait_unreadable?: boolean;
  _native_wait_ended_live?: boolean;
}
const keys = ["wait_for_answer", "owner_wait_state", "owner_wait_resume_reason", "wait_ended_at"] as const;
const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));
export function questionWaitFacts(raw: unknown): QuestionWaitFacts {
  if (!object(raw)) return {};
  const present = keys.filter(key => Object.hasOwn(raw, key));
  if (!present.length) return {};
  if (present.some(key => typeof raw[key] !== (key === "wait_for_answer" ? "boolean" : "string"))) return { _native_wait_unreadable: true };
  return { ...Object.fromEntries(present.map(key => [key, raw[key]])), _native_wait_unreadable: false };
}
export function mergeQuestionWait(target: QuestionWaitFacts, raw: unknown): void {
  if (object(raw) && raw._native_wait_unreadable === true) { target._native_wait_unreadable = true;return; }
  const facts = questionWaitFacts(raw);
  if (facts._native_wait_unreadable === undefined) return;
  if (facts._native_wait_unreadable) { target._native_wait_unreadable = true;return; }
  // A durable closed bound belongs to this exact quiz; missing/older flags cannot reopen it.
  const ended = typeof target.wait_ended_at === "string" && target.wait_ended_at ? target.wait_ended_at : undefined;
  if (target._native_wait_unreadable) for (const key of keys) delete target[key];
  Object.assign(target, facts);
  if (ended) target.wait_ended_at = ended;
  if (target._native_wait_ended_live) { target.owner_wait_state = "resumed";target.wait_for_answer = false; }
}
/** Same quiz binding as project_dialogue.owner_wait_projection, without coercing malformed data. */
export function projectQuestionWait(quizId: string, ownerWait: unknown, block: QuestionWaitFacts): QuestionWaitFacts {
  const result = { ...questionWaitFacts(block) };
  if (ownerWait === undefined || ownerWait === null) return result;
  if (!object(ownerWait) || ownerWait.quiz_id !== undefined && typeof ownerWait.quiz_id !== "string") return { _native_wait_unreadable: true };
  if (ownerWait.quiz_id === quizId) {
    if (["state", "resume_reason"].some(key => ownerWait[key] !== undefined && typeof ownerWait[key] !== "string")) return { _native_wait_unreadable: true };
    if (ownerWait.state) result.owner_wait_state = ownerWait.state as string;
    if (ownerWait.resume_reason) result.owner_wait_resume_reason = ownerWait.resume_reason as string;
  } else if (ownerWait.quiz_id && (block.wait_for_answer === true || block.wait_ended_at)) result.owner_wait_state = "resumed";
  return result;
}
export function questionWaitState(raw: unknown): "waiting" | "resumed" | "open" | "unknown" {
  if (!object(raw)) return "open";
  const facts = questionWaitFacts(raw);
  if (raw._native_wait_unreadable === true || facts._native_wait_unreadable) return "unknown";
  if (raw._native_wait_ended_live === true || facts.owner_wait_state === "resumed" || facts.wait_ended_at) return "resumed";
  if (facts.owner_wait_state === "waiting" || !facts.owner_wait_state && facts.wait_for_answer === true) return "waiting";
  return facts.owner_wait_state ? "unknown" : "open";
}
export function questionWaitStatus(raw: unknown): string {
  switch (questionWaitState(raw)) {
    case "waiting": return chromeText("Waiting for your answer", undefined, "Задача ждёт вашего ответа");
    case "resumed": return chromeText("Unanswered · task continued", undefined, "Без ответа · задача продолжилась");
    case "unknown": return chromeText("Unanswered · waiting state unavailable", undefined, "Без ответа · состояние ожидания недоступно");
    default: return chromeText("Unanswered", undefined, "Без ответа");
  }
}
export function questionWaitLines(raw: QuestionWaitFacts): string[] {
  if (raw._native_wait_unreadable === true || questionWaitFacts(raw)._native_wait_unreadable) return [chromeText("Question wait details could not be read.", undefined, "Сведения об ожидании вопроса не удалось прочитать.")];
  const facts = questionWaitFacts(raw), lines: string[] = [];
  if (facts.owner_wait_state) lines.push(chromeText("Published task wait state · {value}", { value: facts.owner_wait_state }, `Опубликованное ожидание задачи · ${facts.owner_wait_state}`));
  if (facts.wait_ended_at) lines.push(chromeText("Question wait ended · {value}", { value: facts.wait_ended_at }, `Ожидание вопроса закончилось · ${facts.wait_ended_at}`));
  if (facts.owner_wait_resume_reason) lines.push(chromeText("Task wait resume reason · {value}", { value: facts.owner_wait_resume_reason }, `Причина продолжения задачи · ${facts.owner_wait_resume_reason}`));
  return lines;
}
