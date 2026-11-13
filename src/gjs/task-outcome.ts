import { currentCustodyDebt } from "./task-reconciliation.js";
import { Gtk } from "./gi.js";
import { projectTerminalTime } from "./project-completion.js";
import { object } from "./settings-write.js";
import { notStarted } from "./submission-notices.js";
import { artifactStateName } from "./task-materials.js";
import { column, label } from "./ui.js";

export interface TaskOutcomeData {
  status?: string;
  reason_code?: string;
  delegated_runs_unreconciled?: unknown;
  admission_outcome?: string;
  outcome_axes?: unknown;
  root_phase_checkpoint?: unknown;
  terminal_time?: unknown;
  terminal_origin?: string;
  terminal_host_notice?: string;
  result?: string;
  final_answer?: string;
  metadata?: unknown;
  task_attempt?: unknown;
  _attempt?: unknown;
  started_at?: unknown;
}

const terminalStatuses = new Set(["completed", "failed", "cancelled", "rejected_duplicate"]);
const synthesisOpen = new Set(["pending_once", "running", "paused"]);
const lifecycleNames: Record<string, string> = {
  requested: "Запрошена", scheduled: "Запланирована", running: "В работе", completed: "Завершена",
  failed: "Завершилась с ошибкой", cancelled: "Остановлена", rejected_duplicate: "Отклонена как дубликат",
  interrupted: "Прервана", paused: "На паузе",
};
const axisNames = {
  execution: {
    ok: "Завершилось без ошибки выполнения", degraded: "Завершилось с ограничениями", failed: "Ошибка выполнения",
    infra_failed: "Ошибка инфраструктуры", cancelled: "Остановлено", interrupted: "Прервано", best_effort: "Частичный результат",
  },
  objective: {
    pass: "Достигнута по оценке шлюза", fail: "Не достигнута по оценке шлюза", not_evaluated: "Не оценивалась",
    degraded: "Есть ограничения", best_effort: "Частичный результат",
  },
  review: {
    pass: "Пройдена", fail: "Не пройдена", degraded: "Есть замечания", skipped: "Пропущена", pending: "Ожидается",
  },
} satisfies Record<string, Record<string, string>>;

const text = (value: unknown) => typeof value === "string" && value.trim() ? value : "";

function nameOf(names: Record<string, string>, status: string): string {
  return Object.hasOwn(names, status) ? names[status] : status;
}

export function taskLifecycleTerminal(status: unknown): boolean {
  return terminalStatuses.has(text(status));
}

export function taskSynthesisOpen(task: TaskOutcomeData): boolean {
  const phase = text(object(task.root_phase_checkpoint).post_task_synthesis);
  return task.admission_outcome !== "never_admitted" && task.status !== "cancelled"
    && task.status !== "rejected_duplicate" && synthesisOpen.has(phase);
}

export function taskLifecycleLabel(task: TaskOutcomeData): string {
  if (task.admission_outcome === "never_admitted") return notStarted;
  return taskSynthesisOpen(task) ? "Подготовка итогов" : nameOf(lifecycleNames, text(task.status));
}

/** A legacy custody stamp is separate from the task's recorded execution cause. */
export function recordedTaskCause(task: TaskOutcomeData): string {
  const cause = text(task.reason_code);
  if (cause !== "delegated_custody_unreconciled") return cause;
  const underlying = text(object(object(task.outcome_axes).execution).reason_code);
  return underlying === "delegated_custody_unreconciled" ? "" : underlying;
}

export function matchesTaskAttempt(task: TaskOutcomeData, value: unknown): boolean {
  const attempt = object(value);
  const metadata = object(task.metadata);
  const expected = { task_attempt: task.task_attempt, _attempt: task._attempt, started_at: task.started_at,
    metadata_attempt: metadata.attempt, metadata_task_attempt: metadata.task_attempt };
  return Object.entries(expected).every(([key, field]) =>
    Object.hasOwn(attempt, key) && attempt[key] === (field ?? null));
}

function terminalTime(task: TaskOutcomeData): string {
  if (!taskLifecycleTerminal(task.status) || taskSynthesisOpen(task) || task.admission_outcome === "never_admitted") return "";
  const time = object(task.terminal_time);
  const same = time.v === 1 && matchesTaskAttempt(task, time.attempt);
  return same ? projectTerminalTime(time) : "Время завершения не записано";
}

function fact(target: any, words: string, style?: string): void {
  if (!words) return;
  const field = label(words, style);
  field.set_selectable(true);
  target.append(field);
}

export function renderTaskOutcome(target: any, task: TaskOutcomeData, expanded: boolean, expandedChanged: (value: boolean) => void): void {
  const axes = object(task.outcome_axes);
  const ended = terminalTime(task);
  if (!Object.keys(axes).length && !ended) return;
  const body = column(5);
  const lifecycle = nameOf(lifecycleNames, text(object(axes.lifecycle).status));
  if (lifecycle) fact(body, `Состояние записи · ${lifecycle}`);
  const settled = taskLifecycleTerminal(task.status) && !taskSynthesisOpen(task);
  const refused = task.admission_outcome === "never_admitted" || task.status === "rejected_duplicate";
  for (const [key, title] of [["execution", "Выполнение"], ["artifacts", "Материалы"],
    ["objective", "Достижение цели"], ["review", "Ревью"]] as const) {
    const axis = object(axes[key]);
    const status = text(axis.status);
    if (!status) continue;
    const meaning = key === "execution" && refused ? "Запуск не состоялся"
      : key === "execution" && status === "ok" && !settled ? "Окончательный исход ещё не подтверждён"
        : key === "artifacts" ? artifactStateName(status) : nameOf(axisNames[key], status);
    fact(body, `${title} · ${meaning}`);
    const reasons = new Set([text(axis.reason_code), text(axis.reason)].filter(Boolean));
    for (const reason of reasons) if (!(reason === "delegated_custody_unreconciled"
      && currentCustodyDebt(task)?.length === 0)) fact(body, `Причина · ${reason}`, "dim-label");
    const warnings = new Set([text(axis.warning), ...(Array.isArray(axis.warnings) ? axis.warnings.map(text) : [])].filter(Boolean));
    for (const warning of warnings) if (!(key === "objective" && warning === "delegated_custody_unreconciled"
      && currentCustodyDebt(task)?.length === 0)) fact(body, `Предупреждение · ${warning}`, "dim-label");
    if (text(axis.source) && axis.source !== "none") fact(body, `Источник · ${axis.source}`, "dim-label");
    if (text(axis.ignored_status)) fact(body, ["Состояние, исключённое из оценки", axis.ignored_status, text(axis.ignored_source)]
      .filter(Boolean).join(" · "), "dim-label");
  }
  fact(body, ended);
  const panel = new Gtk.Expander({ label: "Исход задачи по данным шлюза", child: body, expanded });
  panel.connect("notify::expanded", () => expandedChanged(panel.get_expanded()));
  target.append(panel);
}

export function renderTaskResult(target: any, task: TaskOutcomeData): void {
  const answer = text(task.final_answer);
  const result = text(task.result);
  if (answer && answer !== result) {
    fact(target, "Выделенный ответ", "heading");
    fact(target, answer);
  }
  if (result) {
    const title = task.terminal_origin === "host_salvage" ? "Сохранённый промежуточный результат"
      : task.terminal_origin === "host_notice" ? "Сообщение шлюза"
        : task.terminal_origin === "model_final" ? "Итоговый ответ" : "Сохранённый результат";
    fact(target, title, "heading");
    fact(target, result);
  }
  const notice = text(task.terminal_host_notice);
  if (notice && notice !== result && notice !== answer) {
    fact(target, "Примечание шлюза", "heading");
    fact(target, notice);
  }
}
