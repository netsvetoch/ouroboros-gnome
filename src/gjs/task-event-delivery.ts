import { object } from "./settings-write.js";
import { label } from "./ui.js";
import { exactWorkTarget } from "./work-actions.js";

type Data = Record<string, unknown>;

const states: Record<string, string> = {
  exhausted: "Доставка осталась неподтверждённой",
  unknown: "Доставка не подтверждена",
  owed: "Доставка ожидается",
  delivered: "Шлюз зафиксировал доставку",
};

const reasons: Record<string, string> = {
  replay_exhausted: "Повторы исчерпаны без подтверждения доставки",
  outbox_capacity: "Запись вытеснена из очереди доставки",
};

const text = (value: unknown): string => typeof value === "string" ? value : "";
const named = (names: Record<string, string>, key: string): string => Object.hasOwn(names, key) ? names[key] : key;

export function taskEventDelivery(event: Data) {
  const row = object(event.data);
  const task = event.task_id;
  if (!exactWorkTarget(task) || row.task_id !== task) return undefined;
  const exhausted = event.source === "events" && event.type === "terminal_delivery_exhausted" && row.type === event.type;
  const summary = event.source === "chat" && event.type === "message" && row.type === "task_summary"
    && row.summary_kind === "terminal_root_projection";
  if (!exhausted && !summary) return undefined;
  const delivery = exhausted ? row : object(row.terminal_delivery);
  const state = exhausted ? "exhausted" : text(delivery.state);
  if (!Object.hasOwn(states, state)) return undefined;
  const id = text(delivery.delivery_id);
  const summaryId = text(row.summary_id);
  const token = text(row.terminal_projection_token);
  const eventId = text(event.event_id);
  const at = text(event.ts);
  const attempts = delivery.attempts_basis === "recorded_replay_dispatch_entries" && typeof delivery.attempts === "number"
    && Number.isSafeInteger(delivery.attempts) && delivery.attempts >= 0 ? delivery.attempts : undefined;
  const path = text(delivery.preserved_path);
  const reason = named(reasons, text(delivery.reason));
  const facts = [
    `Задача · ${task}`,
    id && `Доставка · ${id}`,
    typeof row.chat_id === "number" && Number.isSafeInteger(row.chat_id) && row.chat_id > 0 && `Комната · ${row.chat_id}`,
    at && `Запись журнала · ${at}`,
    reason && `Причина · ${reason}`,
    attempts !== undefined && `Записей о повторе доставки · ${attempts}`,
    path ? `Копия на шлюзе · ${path}` : state === "exhausted" && delivery.preserved_path === ""
      ? "Шлюз сообщил, что сохранить копию не удалось." : "",
    text(delivery.detail),
  ].filter((value): value is string => typeof value === "string" && Boolean(value));
  const identity = exhausted ? id : summaryId && token ? `${summaryId}:${token}` : "";
  return { key: JSON.stringify([task, event.source, identity || eventId || at]), title: states[state], facts, at };
}

export function renderEventDelivery(target: any, delivery: NonNullable<ReturnType<typeof taskEventDelivery>>): void {
  target.append(label(delivery.title, "heading"));
  for (const value of delivery.facts) {
    const field = label(value);
    field.set_selectable(true);
    target.append(field);
  }
}
