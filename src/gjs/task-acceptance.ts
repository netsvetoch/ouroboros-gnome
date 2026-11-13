import { Gtk } from "./gi.js";
import { query } from "./gateway.js";
import { object } from "./settings-write.js";
import { column, label } from "./ui.js";
import { exactWorkTarget } from "./work-actions.js";

export interface AcceptanceData {
  outcome_axes?: unknown;
  review_status?: unknown;
  completion_observations?: unknown;
  acceptance_debt?: unknown;
}

export interface TaskSource {
  path: string;
  name: string;
  sha256: string;
  size: number;
}

export function taskSource(task: string, raw: unknown): TaskSource | undefined {
  const { kind, root, path, sha256, size } = object(raw);
  if (!exactWorkTarget(task) || kind !== "task_source" || root !== "artifact_store"
    || typeof path !== "string" || !/^source_handles\/(tool_results|context_checkpoints|delegated_activity)\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(path)
    || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)
    || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return undefined;
  const name = path.slice(path.lastIndexOf("/") + 1);
  return { name, sha256, size, path: `/api/tasks/${encodeURIComponent(task)}/artifacts/${encodeURIComponent(name)}${query({ source: path })}` };
}

type OpenSource = (target: any, title: string, ref: unknown) => boolean;

function facts(target: any, ...values: unknown[]): void {
  const words = values.filter((value) => typeof value === "number" || (typeof value === "string" && value));
  if (!words.length) return;
  const field = label(words.join(" · "));
  field.set_selectable(true);
  target.append(field);
}

function section(target: any, title: string): any {
  const body = column(5);
  target.append(new Gtk.Expander({ label: title, child: body }));
  return body;
}

function objects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(object).filter((row) => Object.keys(row).length > 0) : [];
}

export function renderAcceptance(target: any, data: AcceptanceData, projectionIncident: unknown, open: OpenSource): void {
  const decision = object(object(object(data.outcome_axes).review).acceptance_decision ?? object(data.review_status).acceptance_decision);
  if (Object.keys(decision).length) {
    const body = section(target, "Решение о приёмке задачи");
    facts(body, decision.status, decision.reason, decision.source, decision.enforcement);
    facts(body, decision.rationale);
    const author = object(decision.author_disposition);
    if (author.disposition || author.action) {
      facts(body, "Решение автора", author.action, author.disposition, author.reviewer_signal, author.subject_hash);
      facts(body, author.rationale, author.recorded_at);
    } else if (decision.agent_disposition || typeof decision.author_disposition === "string") {
      facts(body, "Позиция автора без привязки к материалу", decision.agent_disposition || decision.author_disposition,
        decision.agent_rationale || decision.author_rationale);
    }
    if (decision.dissent_noted === true) facts(body, "Зафиксировано особое мнение.");
    for (const item of Array.isArray(decision.open_obligations) ? decision.open_obligations : []) facts(body, "Открытое обязательство", item);
  }
  const incident = object(projectionIncident ?? decision.acceptance_incident);
  if (typeof incident.incident_id === "string" && incident.incident_id
    && typeof incident.attempts === "number" && Number.isSafeInteger(incident.attempts) && incident.attempts > 0) {
    const body = section(target, "Подготовка материалов приёмки");
    facts(body, incident.status === "resolved" ? "Подготовка восстановлена" : "Шлюз сообщил о сбое подготовки",
      incident.incident_id, "Попыток", incident.attempts, incident.stage);
    facts(body, incident.failure_kind, incident.failure_detail);
    if (incident.source_known === false) facts(body, "Идентичность материала неизвестна.");
    if (incident.feedback_delivered === true) facts(body, "Автор получил сведения об ошибке.");
    if (object(incident.retry).basis) facts(body, "Основание повторной попытки", object(incident.retry).basis);
  }
  const debt = object(data.acceptance_debt);
  if (Object.keys(debt).length) {
    const body = section(target, "Отложенная проверка приёмки");
    facts(body, debt.debt_id, debt.status, debt.reason);
    if (debt.source_ref && !open(body, "Открыть материал отложенной проверки", debt.source_ref)) {
      facts(body, "Материал отложенной проверки недоступен.");
    }
  }
}

export function renderCompletion(target: any, raw: unknown, open: OpenSource): void {
  const view = object(raw);
  const counts = Object.entries(object(view.delivery_counts));
  const deliveries = objects(view.delivery_results);
  const skills = objects(view.skill_state);
  if (!(counts.length || deliveries.length || skills.length || view.source_ref || view.source_status
    || view.status === "unavailable" || view.trace_available === false)) return;
  const body = section(target, "Наблюдения при завершении");
  if (view.observed_at) facts(body, "Снимок", view.observed_at);
  if (view.status === "unavailable" || view.trace_available === false) facts(body, "Запись наблюдений недоступна или неполна.");
  if (view.delivery_receipt_coverage === "not_observed_by_tool_trace") facts(body, "Журнал содержит ответы инструментов. Квитанции о доставке в нём отсутствуют.");
  for (const [tool, value] of counts) {
    const count = object(value);
    facts(body, tool, "Вызовы", count.calls, "Сообщили об успехе", count.reported_ok, "Состояние неизвестно", count.status_unknown);
  }
  for (const row of deliveries) {
    facts(body, row.tool, row.tool_call_id, row.status, row.code, row.is_error === true ? "Ошибка инструмента" : "",
      row.result_partial === true ? "Частичный ответ" : "");
    facts(body, row.result);
  }
  if (typeof view.delivery_results_omitted === "number" && view.delivery_results_omitted > 0) {
    facts(body, "Более ранних ответов инструментов за пределами сводки", view.delivery_results_omitted);
  }
  if (skills.length) {
    facts(body, "Состояние связанных навыков на момент снимка");
    for (const row of skills) {
      facts(body, row.name, row.present === false ? "Навык отсутствовал" : "",
        row.enabled === true ? "Включён" : row.enabled === false ? "Выключен" : "",
        row.ready === true ? "Готов" : row.ready === false ? "Не готов" : "", row.review_status);
      for (const blocker of Array.isArray(row.blockers) ? row.blockers : []) {
        facts(body, "Ограничение", typeof blocker === "string" ? blocker : JSON.stringify(blocker));
      }
    }
  }
  const coverage = object(view.skill_history_coverage);
  if (coverage.complete === false) facts(body, "История навыков прочитана частично", coverage.status);
  if (typeof view.skill_state_omitted === "number" && view.skill_state_omitted > 0) facts(body, "Навыков за пределами сводки", view.skill_state_omitted);
  if (view.source_status !== "unavailable" && open(body, "Открыть полную запись наблюдений", view.source_ref)) return;
  if (view.source_ref || view.source_status === "unavailable") facts(body, "Полная запись наблюдений недоступна.");
}
