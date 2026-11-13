import { Gtk } from "./gi.js";
import { object } from "./settings-write.js";
import { matchesTaskAttempt, type TaskOutcomeData } from "./task-outcome.js";
import { column, label } from "./ui.js";

export interface TaskDeliveryData extends TaskOutcomeData {
  canonical_terminal_projection?: unknown;
  canonical_terminal_projection_ready?: unknown;
}

const text = (value: unknown) => typeof value === "string" && value.trim() ? value : "";
const room = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const instant = (value: unknown) => {
  const raw = text(value);
  return /(?:Z|[+-]\d{2}:\d{2})$/.test(raw) && Number.isFinite(Date.parse(raw)) ? raw : "";
};

export function taskDelivery(taskId: string, task: TaskDeliveryData) {
  const marker = object(task.canonical_terminal_projection);
  const ready = object(task.canonical_terminal_projection_ready);
  if (!Object.keys(marker).length && !Object.keys(ready).length) return undefined;
  const summary = `task-terminal:${taskId}`;
  const mainId = `project-completion:${taskId}`;
  const readyMatches = ready.summary_id === summary && Boolean(text(ready.token)) && matchesTaskAttempt(task, ready.attempt);
  const markerMatches = marker.summary_id === summary && matchesTaskAttempt(task, marker.attempt)
    && (!readyMatches || marker.token === ready.token);
  const sourceWritten = markerMatches && room(marker.chat_id) ? instant(marker.written_at) : "";
  const deliveredAt = markerMatches && marker.main_disposition === "delivered"
    && marker.main_chat_id === 1 && marker.main_delivery_id === mainId ? instant(marker.main_delivered_at) : "";
  const ineligible = markerMatches && marker.main_disposition === "ineligible";
  const pending = readyMatches && !deliveredAt && !ineligible;
  const delivery = object(ready.main_delivery);
  const event = object(delivery.event);
  const offered = pending && event.type === "send_message" && event.system_type === "project_completion_summary"
    && event.task_id === taskId && event.chat_id === 1 && event.delivery_id === mainId
    && event.terminal_projection_token === ready.token;
  return { marker, ready, sourceWritten, deliveredAt, ineligible, pending, offered, delivery };
}

export function renderTaskDelivery(target: any, taskId: string, task: TaskDeliveryData,
  expanded: boolean, expandedChanged: (value: boolean) => void): void {
  const view = taskDelivery(taskId, task);
  if (!view) return;
  const body = column(5);
  const fact = (caption: string, ...values: (number | string)[]) => {
    const field = label([caption, ...values].filter(value => value !== "").join(" · "));
    field.set_selectable(true);
    body.append(field);
  };
  if (view.sourceWritten) {
    fact("Итоговая запись сохранена", `комната ${view.marker.chat_id}`, view.sourceWritten);
    fact("Идентификатор записи", text(view.marker.summary_id));
  } else if (Object.keys(view.marker).length) {
    fact("Сохранённая запись не подтверждает публикацию для этой попытки");
  } else if (view.pending) {
    fact("Итоговая запись ещё не подтверждена");
  }

  if (view.deliveredAt) {
    fact("Сводка опубликована в Main", view.deliveredAt);
    fact("Идентификатор доставки", text(view.marker.main_delivery_id));
  } else if (view.ineligible) {
    fact("Отдельная сводка в Main не предусмотрена");
  } else if (view.offered) {
    fact("Сводка в Main ожидает подтверждения");
    const count = view.delivery.attempts;
    if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) fact("Попыток отправки по записи шлюза", count);
    const at = instant(view.delivery.last_attempt_at);
    if (at) fact("Последняя попытка", at);
  } else if (view.pending) {
    fact("Решение о публикации сводки в Main ещё не записано");
  } else if (view.marker.main_disposition || Object.keys(view.ready).length) {
    fact("Шлюз не подтвердил состояние сводки в Main для этой попытки");
  }

  const panel = new Gtk.Expander({ label: "Публикация итогов", child: body, expanded });
  panel.connect("notify::expanded", () => expandedChanged(panel.get_expanded()));
  target.append(panel);
}
