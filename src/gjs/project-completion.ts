import { Gtk } from "./gi.js";
import { object } from "./settings-write.js";
import { column, label } from "./ui.js";

export interface CompletionFields {
  role?: string;
  system_type?: string;
  text?: string;
  ts?: string;
  task_name?: string;
  project_name?: string;
  completion_answer?: string;
  completion_reason?: string;
  completion_notice?: unknown;
  terminal_time?: unknown;
  wake_summary?: string;
  outcome_phase?: string;
  outcome_final?: boolean;
  task_phase?: string;
}

const phases: Record<string, string> = {
  done: "Завершена",
  warn: "Завершена с предупреждениями",
  error: "Завершилась с ошибкой",
  failed: "Завершилась с ошибкой",
  timeout: "Истекло время выполнения",
  lifecycle_error: "Ошибка завершения",
  cancelled: "Остановлена",
  working: "Работа продолжается",
};

const text = (value: unknown): string => typeof value === "string" && value.trim() ? value : "";

function phaseName(phase: unknown): string {
  return typeof phase === "string" && Object.hasOwn(phases, phase) ? phases[phase] : "";
}

export function isProjectCompletion(row: CompletionFields): boolean {
  return row.system_type === "project_completion_summary" && row.role === "system";
}

export function projectTerminalTime(value: unknown): string {
  const terminal = object(value);
  const occurred = text(terminal.occurred_at);
  if (terminal.source === "executor_terminal" && /(?:Z|[+-]\d{2}:\d{2})$/.test(occurred)
    && Number.isFinite(Date.parse(occurred))) return `Завершение · ${occurred}`;
  return Object.hasOwn(terminal, "occurred_at") ? "Время завершения не записано" : "";
}

export function projectCompletion(row: CompletionFields) {
  if (!isProjectCompletion(row)) return undefined;
  const notice = object(row.completion_notice);
  const answer = text(row.completion_answer);
  const phase = phaseName(notice.phase);
  const compact = Boolean(phase && typeof notice.cause === "string");
  const neutral = notice.neutral === true;
  const body = answer || (compact ? "" : text(row.text));
  const cause = neutral || (!answer && !compact) ? "" : text(notice.cause) || (answer ? text(row.completion_reason) : "");
  const details = [...new Set(Array.isArray(notice.undescribed) ? notice.undescribed.map(text).filter(Boolean) : [])];
  const canonical = (answer || compact) && body !== text(row.text) ? text(row.text) : "";
  const detail = text(notice.detail);
  return {
    answer, body, phase, cause,
    name: row.task_name !== row.project_name ? text(row.task_name) : "",
    salvage: answer || compact ? text(notice.salvage) : "",
    wake: text(row.wake_summary),
    details,
    canonical,
    detail: detail && ![body, canonical, cause].some(part => part.includes(detail)) ? detail : "",
    time: projectTerminalTime(row.terminal_time),
  };
}

export function projectTaskPhase(row: CompletionFields): string {
  if (row.task_phase === "finalizing") return "Подготовка итогов";
  return row.outcome_final === true ? phaseName(row.outcome_phase) : "";
}

function line(box: any, value: string, style?: string): void {
  if (!value) return;
  const widget = label(value, style);
  widget.set_selectable(true);
  box.append(widget);
}

export function renderProjectCompletion(box: any, result: NonNullable<ReturnType<typeof projectCompletion>>, renderBody?: (body: string) => any): void {
  line(box, [result.name, result.phase].filter(Boolean).join(" · "), "heading");
  if (result.body && renderBody) box.append(renderBody(result.body));
  else line(box, result.body);
  line(box, result.cause);
  if (result.wake && !result.body.includes(result.wake) && !result.cause.includes(result.wake)) {
    line(box, `Итог · ${result.wake}`);
  }
  line(box, result.salvage);
  line(box, result.time, "dim-label");
  if (result.details.length || result.canonical || result.detail) {
    const more = column(5);
    for (const code of result.details) line(more, `Код причины · ${code}`);
    line(more, result.canonical);
    line(more, result.detail);
    box.append(new Gtk.Expander({ label: "Запись шлюза", child: more }));
  }
}
