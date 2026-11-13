import { bindChrome, chromeText, watchNativeI18n } from "./native-i18n.js";
import { Adw, Gio, GLib, Gtk } from "./gi.js";
import { type Gateway, HttpError } from "./gateway.js";
import type { Room } from "./chat.js";
import { actionRow, button, clear, column, errorText, label, row, sheet } from "./ui.js";

type Trigger = { type: "cron"; expr: string } | { type: "once"; run_at: string };

interface Template extends Record<string, unknown> {
  text?: string;
  description?: string;
  objective?: string;
  chat_id?: number | null;
  project_id?: string;
  priority?: number | null;
  reasoning_effort?: string;
  metadata?: Record<string, unknown>;
  expected_output?: string;
  constraints?: string;
  deadline_at?: string;
  allowed_resources?: Record<string, unknown>;
  task_contract?: Record<string, unknown>;
  attachments?: Record<string, unknown>[];
}

interface Schedule {
  id: string;
  name?: string;
  display_name?: string;
  description?: string;
  enabled?: boolean;
  timezone?: string;
  trigger?: Trigger;
  cron?: string;
  cadence?: string;
  kind?: string;
  skill?: string;
  task?: Template;
  notification?: { text?: string };
  destination?: Pick<Template, "project_id" | "chat_id">;
  status?: string;
  next_run_at?: string;
  completed_at?: string;
  time_passed_on?: string;
  objective_preview?: string;
  last_error?: string;
  last_task_id?: string;
  previous_run_open?: { task_id?: string; since?: string };
  outcome?: { task_id?: string; state?: string; quiet?: boolean; notice?: boolean; ended_at?: string; line?: string };
  relation?: string;
  followup_origin?: { task_id?: string; root_task_id?: string };
  billing_group?: { billing_group_id?: string; billing_group_limit_usd?: number | null };
  deadline_at?: string;
  waiting_detail?: string | { reason?: string; detail?: string; followup_wait?: string };
  followup_hold?: { hold_id?: string; reason?: string; detail?: string };
  hold_persisted?: boolean;
  restorable?: boolean;
  withdrawal?: { at?: string; by?: string; reason?: string; work_in_flight?: boolean | null; restorable?: boolean };
  delete_requested_at?: string;
  audit?: string;
}

interface Definition {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  timezone: string;
  trigger: Trigger;
  task: Template;
  reason?: string;
}

interface LifecycleReceipt {
  ok?: boolean;
  changed?: boolean;
  status?: string;
  audit?: string;
  detail?: string;
  schedule_id?: string;
  operation_id?: string;
  running_or_queued?: boolean | null;
}

interface Action {
  label: string;
  action: "disable" | "delete" | "restore";
  hold?: string;
}

const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
function readSchedules(value: unknown): Schedule[] {
  const strings = (value: Record<string, any>, keys: string[]) => keys.every(key => value[key] == null || typeof value[key] === "string");
  const nested = (value: unknown, keys: string[]) => value == null || object(value) && strings(value, keys);
  if (!object(value) || !Array.isArray(value.tasks)) throw new Error("Шлюз не вернул список расписаний.");
  const ids = new Set<string>();
  for (const item of value.tasks) {
    if (!object(item) || typeof item.id !== "string" || !item.id || ids.has(item.id)
      || !strings(item, ["name", "display_name", "description", "timezone", "cron", "cadence", "kind", "skill", "status", "next_run_at",
        "completed_at", "time_passed_on", "objective_preview", "last_error", "last_task_id", "relation", "deadline_at", "delete_requested_at", "audit"])
      || ["enabled", "hold_persisted", "restorable"].some(key => item[key] != null && typeof item[key] !== "boolean")
      || (item.trigger != null && (!object(item.trigger) || (item.trigger.type === "cron" ? typeof item.trigger.expr !== "string"
        : item.trigger.type === "once" ? typeof item.trigger.run_at !== "string" : true)))
      || !nested(item.task, ["text", "description", "objective", "project_id", "reasoning_effort", "context", "expected_output", "constraints", "deadline_at"])
      || (item.task && (["metadata", "allowed_resources", "task_contract"].some(key => item.task[key] != null && !object(item.task[key]))
        || ["chat_id", "priority"].some(key => item.task[key] != null && !Number.isSafeInteger(item.task[key]))
        || (item.task.attachments != null && (!Array.isArray(item.task.attachments) || !item.task.attachments.every(object)))))
      || !nested(item.notification, ["text"]) || !nested(item.destination, ["project_id"])
      || (item.destination?.chat_id != null && !Number.isSafeInteger(item.destination.chat_id))
      || !nested(item.followup_origin, ["task_id", "root_task_id"]) || !nested(item.followup_hold, ["hold_id", "reason", "detail"])
      || !nested(item.previous_run_open, ["task_id", "since"]) || !nested(item.outcome, ["task_id", "state", "ended_at", "line"])
      || (item.outcome && ["quiet", "notice"].some(key => item.outcome[key] != null && typeof item.outcome[key] !== "boolean"))
      || !nested(item.withdrawal, ["at", "by", "reason"])
      || (item.withdrawal && ["work_in_flight", "restorable"].some(key => item.withdrawal[key] != null && typeof item.withdrawal[key] !== "boolean"))
      || !(item.waiting_detail == null || typeof item.waiting_detail === "string" || nested(item.waiting_detail, ["reason", "detail", "followup_wait"]))
      || !nested(item.billing_group, ["billing_group_id"])
      || (item.billing_group?.billing_group_limit_usd != null && (typeof item.billing_group.billing_group_limit_usd !== "number" || !Number.isFinite(item.billing_group.billing_group_limit_usd)))) {
      throw new Error("Шлюз вернул неполную или противоречивую запись расписания.");
    }
    ids.add(item.id);
  }
  return value.tasks as Schedule[];
}

const path = "/api/schedules";
const effort = ["", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const statuses: Record<string, string> = {
  active: "Включено",
  disabled: "Выключено",
  consumed: "Однократный запуск состоялся",
  held: "Удерживается",
  waiting: "Ожидает",
  delete_pending: "Снято с расписания",
};
const actionStatuses: Record<string, string> = {
  not_found: "Расписание уже недоступно",
  stale_hold: "Удержание изменилось",
  hold_not_observed: "Это удержание ещё не подтверждено",
  relationship_required: "Требуется решение о связи с исходной задачей",
  origin_changed: "Исходная задача изменилась",
  followup_authority_unavailable: "Сведения об исходной работе недоступны",
  work_deadline_passed: "Предельный срок исходной работы истёк",
  owner_restart_in_progress: "Идёт перезапуск",
  consumed_not_rearmed: "Однократный запуск уже состоялся. Для нового запуска укажите другое время",
  lock_timeout: "Таблица расписаний занята",
  store_unreadable: "Таблица расписаний недоступна",
  audit_unavailable: "Журнал аудита недоступен",
};
// Only these client-authored captions are translation keys. Gateway values stay parameters.
const scheduleSources: Record<string, string> = {
  "Включено": "Enabled",
  "Выключено": "Disabled",
  "Однократный запуск состоялся": "One-time run completed",
  "Удерживается": "Held",
  "Ожидает": "Waiting",
  "Снято с расписания": "Withdrawn",
  "Расписание уже недоступно": "Schedule is no longer available",
  "Удержание изменилось": "Hold changed",
  "Это удержание ещё не подтверждено": "This hold has not been confirmed yet",
  "Требуется решение о связи с исходной задачей": "Choose the relationship to the original task",
  "Исходная задача изменилась": "Original task changed",
  "Сведения об исходной работе недоступны": "Original work information is unavailable",
  "Предельный срок исходной работы истёк": "Original work deadline passed",
  "Идёт перезапуск": "Restart in progress",
  "Однократный запуск уже состоялся. Для нового запуска укажите другое время": "The one-time run already occurred. Choose another time for a new run",
  "Таблица расписаний занята": "Schedule store is busy",
  "Таблица расписаний недоступна": "Schedule store is unavailable",
  "Журнал аудита недоступен": "Audit log is unavailable",
  "Следующий запуск {time}": "Next run {time}",
  "Снято с расписания · прежний запуск ещё открыт": "Withdrawn · previous run is still open",
  "Состояние неизвестно": "Unknown state",
  "Напоминание": "Reminder",
  "Задача": "Task",
  "Часовой пояс шлюза": "Gateway time zone",
  "Снять удержание": "Release hold",
  "Восстановить": "Restore",
  "Включить": "Enable",
  "Выключить": "Disable",
  "Удалить": "Delete",
  "Операция · {id}": "Operation · {id}",
  "Расписание не изменилось. {detail}": "Schedule unchanged. {detail}",
  "Расписание снято. Запись доступна на время хранения.": "Schedule withdrawn. The record is available during retention.",
  "Удержание снято.": "Hold released.",
  "Удаление ожидает завершения работы.": "Deletion is waiting for work to finish.",
  "Расписание удалено.": "Schedule deleted.",
  "Расписание обновлено.": "Schedule updated.",
  "Ранее запущенная задача продолжает работу или стоит в очереди.": "A previously started task is still running or queued.",
  "Шлюз отклонил действие. {detail}": "Gateway declined the action. {detail}",
  "Изменение записано. Запись аудита неполная. {detail}": "Change saved. The audit record is incomplete. {detail}",
  "Запрошенное состояние не подтверждено. {detail}": "The requested state is not confirmed. {detail}",
  "Все расписания": "All schedules",
  "Действующие": "Current",
  "История и снятые": "History and withdrawn",
  "Новое расписание": "New schedule",
  "Читаю расписания…": "Reading schedules…",
  "Показаны ранее прочитанные записи. {error}": "Showing previously read records. {error}",
  "Расписаний в списке: {count}": "Schedules listed: {count}",
  "Расписания не найдены.": "No schedules found.",
  "В этой группе нет расписаний.": "No schedules in this group.",
  "Открыть расписание": "Open schedule",
  "Проект {id}": "Project {id}",
  "Чат {id}": "Chat {id}",
  "Навык · {name}": "Skill · {name}",
  "Связано с исходной задачей": "Related to the original task",
  "Самостоятельная работа": "Independent work",
  "Связь с исходной задачей не определена": "Relationship to the original task is unknown",
  "Бюджет работы · {id}": "Work budget · {id}",
  "без лимита": "unlimited",
  "Удержание · {detail}": "Hold · {detail}",
  "Шлюз ещё не подтвердил запись удержания.": "The gateway has not confirmed the stored hold yet.",
  "Ожидание · {detail}": "Waiting · {detail}",
  "Предельный срок {time}": "Deadline {time}",
  "Предыдущий запуск ещё открыт": "Previous run is still open",
  "Результат последнего запуска ещё неизвестен.": "The result of the last run is not known yet.",
  "Последний запуск · {state}": "Last run · {state}",
  "завершён без сообщения": "completed without a message",
  "Уведомление шлюза · {text}": "Gateway notification · {text}",
  "Последняя ошибка · {error}": "Last error · {error}",
  "Снято с расписания {time}": "Withdrawn {time}",
  "Ранее запущенная задача ещё выполняется или стоит в очереди.": "A previously started task is still running or queued.",
  "Состояние ранее запущенной задачи неизвестно.": "The state of a previously started task is unknown.",
  "Открыть последнюю задачу": "Open last task",
  "Открыть предыдущий незавершённый запуск": "Open previous unfinished run",
  "Открыть исходную задачу": "Open original task",
  "Изменить расписание…": "Edit schedule…",
  "Проверить запись на шлюзе": "Check record on gateway",
  "Читаю расписание…": "Reading schedule…",
  "Текущее состояние · {summary}": "Current state · {summary}",
  "Шлюз не вернул расписание с ID {id}.": "Gateway returned no schedule with ID {id}.",
  "Открыть прочитанную запись…": "Open retrieved record…",
  "Повторить с тем же ID и данными": "Retry with the same ID and data",
  "Причина (необязательно)": "Reason (optional)",
  "Причина": "Reason",
  "Выберите связь с исходной задачей": "Choose relationship to original task",
  "Самостоятельная задача": "Independent task",
  "Будет проверен ID удержания, показанного при открытии.": "The hold ID shown when opening will be checked.",
  "Действие касается будущих запусков. Ранее принятая задача продолжает свой жизненный цикл.": "This action affects future runs. A previously accepted task continues its lifecycle.",
  "Укажите причину.": "Enter a reason.",
  "Укажите связь с исходной задачей.": "Choose a relationship to the original task.",
  "Операция с этим расписанием ещё выполняется.": "An operation on this schedule is still in progress.",
  "Проверяю текущее состояние…": "Checking current state…",
  "Состояние расписания изменилось. Проверьте свежую запись.": "Schedule state changed. Check the latest record.",
  "Результат действия неизвестен · {id}. {error}": "Action result unknown · {id}. {error}",
  "Состояние расписания изменилось. Откройте свежую запись из списка перед сохранением.": "Schedule state changed. Open the latest record from the list before saving.",
  "Расписание сохранено.": "Schedule saved.",
  "Расписание записано, но запись аудита неполная.": "Schedule saved, but the audit record is incomplete.",
  "Результат неизвестен · {id}. {error}. Проверьте запись в списке.": "Result unknown · {id}. {error}. Check the record in the list.",
  "Результат записи неизвестен · {id}. {error}": "Save result unknown · {id}. {error}"
};
function scheduleText(source: string, params?: Record<string, string | number>): string {
  const english = scheduleSources[source];
  if (!english) return source;
  const fallback = source.replace(/\{(\w+)\}/g, (whole, key: string) => String(params?.[key] ?? whole));
  return chromeText(english, params, fallback);
}

const appliedStatuses = new Set(["updated", "withdrawn", "deleted", "delete_deferred", "hold_released", "changed_audit_incomplete"]);

// The gateway strips host-owned lineage from schedule templates and refuses it on input.
const reservedTemplate = new Set([
  "work_diagnostic", "work_kind", "owner_ingress", "schedule_writer_kind", "wake_cause", "focus",
  "consciousness_cause", "origin_wake_task_id", "workspace_root", "workspace_mode", "memory_mode",
  "drive_root", "child_drive_root", "budget_drive_root", "parent_task_id", "root_task_id", "delegation_role",
  "task_constraint", "task_id", "session_id", "actor_id", "headless_child_drive_root", "client_surface",
  "origin_message_ref", "origin_suppressed", "origin_message_absent", "billing_group", "continuation",
  "followup_relation", "followup_origin", "followup_hold", "followup_released", "followup_wait",
  "continuation_of", "origin_task_id", "origin_root_task_id", "schedule_occurrence", "last_outcome",
  "previous_run_open", "presence_binding_relation",
]);

function withoutHostFields(data?: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data ?? {}).filter(([key]) => !reservedTemplate.has(key)));
}

function note(item?: Schedule): boolean {
  return item?.kind === "note" || item?.kind === "notify";
}

function title(item: Schedule): string {
  return item.display_name || item.name || item.id;
}

function statusOf(item: Schedule): string {
  if (item.status) return item.status;
  if (item.withdrawal || item.delete_requested_at) return "delete_pending";
  if (item.trigger?.type === "once" && item.completed_at) return "consumed";
  return item.enabled === false ? "disabled" : item.enabled === true ? "active" : "";
}

function localZone(): string {
  const zone = String(GLib.TimeZone.new_local().get_identifier());
  return zone.startsWith("/") || zone === "localtime" ? "UTC" : zone;
}

function formattedTime(input: string | undefined, zone: string | undefined): string {
  if (!input) return "";
  const time = GLib.DateTime.new_from_iso8601(input, GLib.TimeZone.new_utc());
  if (!time) return input;
  const displayZone = zone && GLib.TimeZone.new_identifier(zone);
  return displayZone ? time.to_timezone(displayZone).format("%d.%m.%Y %H:%M %Z") : time.format("%d.%m.%Y %H:%M %z");
}

function scheduleSummary(item: Schedule): string {
  const state = statusOf(item);
  const trigger = item.trigger;
  const cadence = trigger?.type === "once" ? formattedTime(trigger.run_at, item.timezone)
    : item.cadence || trigger?.expr || item.cron || "";
  const next = ["active", "waiting"].includes(state) && item.next_run_at
    ? scheduleText("Следующий запуск {time}", { time: formattedTime(item.next_run_at, item.timezone) }) : "";
  const status = state === "delete_pending" && item.withdrawal?.work_in_flight === true
    ? scheduleText("Снято с расписания · прежний запуск ещё открыт") : (statuses[state] ? scheduleText(statuses[state]) : undefined) ?? (state || scheduleText("Состояние неизвестно"));
  return [note(item) ? scheduleText("Напоминание") : scheduleText("Задача"), status, cadence, item.timezone || scheduleText("Часовой пояс шлюза"), next]
    .filter(Boolean).join(" · ");
}

function actions(item: Schedule): Action[] {
  const state = statusOf(item);
  const hold = item.followup_hold?.hold_id;
  const choices: Action[] = [];
  if (hold && item.hold_persisted === true) choices.push({ label: "Снять удержание", action: "restore", hold });
  if (state === "delete_pending") {
    if (!hold && (item.withdrawal ? item.withdrawal.restorable === true : item.restorable ?? !item.completed_at)) {
      choices.push({ label: "Восстановить", action: "restore" });
    }
  } else {
    if (!hold && state === "disabled" && !item.completed_at) choices.push({ label: "Включить", action: "restore" });
    if (!hold && state === "active") choices.push({ label: "Выключить", action: "disable" });
    choices.push({ label: "Удалить", action: "delete" });
  }
  return choices;
}

function actionMessage(result: LifecycleReceipt): string {
  const status = result.status ?? "";
  const detail = [(actionStatuses[status] ? scheduleText(actionStatuses[status]) : status), result.detail].filter(Boolean).join(" · ");
  const operation = result.operation_id ? " " + scheduleText("Операция · {id}", { id: result.operation_id }) : "";
  if (result.changed !== true) return scheduleText("Расписание не изменилось. {detail}", { detail }).trim() + operation;
  const resultText = result.status === "withdrawn" ? scheduleText("Расписание снято. Запись доступна на время хранения.")
    : result.status === "hold_released" ? scheduleText("Удержание снято.")
    : result.status === "delete_deferred" ? scheduleText("Удаление ожидает завершения работы.")
    : result.status === "deleted" ? scheduleText("Расписание удалено.")
    : scheduleText("Расписание обновлено.");
  const running = result.running_or_queued === true ? " " + scheduleText("Ранее запущенная задача продолжает работу или стоит в очереди.")
    : result.running_or_queued === false ? "" : " " + scheduleText("Состояние ранее запущенной задачи неизвестно.");
  if (!appliedStatuses.has(status)) return scheduleText("Шлюз отклонил действие. {detail}", { detail }).trim() + running + operation;
  if (status === "changed_audit_incomplete" || result.audit !== "recorded") {
    return scheduleText("Изменение записано. Запись аудита неполная. {detail}", { detail: result.detail || "" }).trim() + running + operation;
  }
  if (result.ok !== true) return scheduleText("Запрошенное состояние не подтверждено. {detail}", { detail }).trim() + running + operation;
  return resultText + running + operation;
}

function authoredFingerprint(item: Schedule): string {
  return JSON.stringify([
    item.name, item.description, item.enabled, item.timezone, item.trigger, item.cron, item.task, item.notification,
    item.completed_at, item.delete_requested_at ?? item.withdrawal?.at,
  ], (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) : value);
}

function matchesStartingRow(current?: Schedule, original?: Schedule): boolean {
  return original ? Boolean(current && authoredFingerprint(current) === authoredFingerprint(original)) : !current;
}

function selectable(value: string): any {
  const widget = label(value);
  widget.set_selectable(true);
  return widget;
}

function scheduleFacts(item: Schedule): string {
  const destination = item.destination ?? item.task;
  const wait = item.waiting_detail;
  const reason = typeof wait === "string" ? wait : [wait?.reason, wait?.detail, wait?.followup_wait].filter(Boolean).join(" · ");
  const previous = item.previous_run_open;
  const outcome = item.outcome;
  const withdrawal = item.withdrawal;
  const group = item.billing_group;
  const facts = [
    `ID ${item.id}`,
    destination?.project_id ? scheduleText("Проект {id}", { id: destination.project_id }) : "",
    destination?.chat_id != null ? scheduleText("Чат {id}", { id: destination.chat_id }) : "",
    item.skill ? scheduleText("Навык · {name}", { name: item.skill }) : "",
    item.trigger?.type === "cron" ? `Cron · ${item.trigger.expr}` : "",
    item.relation === "related" ? scheduleText("Связано с исходной задачей")
    : item.relation === "independent" ? scheduleText("Самостоятельная работа") : item.relation === "unknown" ? scheduleText("Связь с исходной задачей не определена") : "",
    group?.billing_group_id ? scheduleText("Бюджет работы · {id}", { id: group.billing_group_id })
    + (group.billing_group_limit_usd === null ? " · " + scheduleText("без лимита") : typeof group.billing_group_limit_usd === "number"
      ? ` · ${group.billing_group_limit_usd} USD` : "") : "",
    item.followup_hold?.reason ? scheduleText("Удержание · {detail}", { detail: [item.followup_hold.reason, item.followup_hold.detail].filter(Boolean).join(" · ") }) : "",
    item.followup_hold?.hold_id && item.hold_persisted !== true ? scheduleText("Шлюз ещё не подтвердил запись удержания.") : "",
    reason ? scheduleText("Ожидание · {detail}", { detail: reason }) : "",
    item.deadline_at ? scheduleText("Предельный срок {time}", { time: formattedTime(item.deadline_at, item.timezone) }) : "",
    previous ? [scheduleText("Предыдущий запуск ещё открыт"), formattedTime(previous.since, item.timezone), previous.task_id].filter(Boolean).join(" · ") : "",
    outcome?.state === "pending_observation" ? scheduleText("Результат последнего запуска ещё неизвестен.")
    : outcome?.state ? [scheduleText("Последний запуск · {state}", { state: outcome.quiet && !outcome.notice && outcome.state === "completed" ? scheduleText("завершён без сообщения") : outcome.state }),
      formattedTime(outcome.ended_at, item.timezone), outcome.line && (outcome.notice === true ? scheduleText("Уведомление шлюза · {text}", { text: outcome.line }) : outcome.line)]
      .filter(Boolean).join(" · ") : "",
    item.last_error && item.last_error !== outcome?.line ? scheduleText("Последняя ошибка · {error}", { error: item.last_error }) : "",
    withdrawal ? [scheduleText("Снято с расписания {time}", { time: formattedTime(withdrawal.at, item.timezone) }), withdrawal.by, withdrawal.reason].filter(Boolean).join(" · ") : "",
    withdrawal?.work_in_flight === true ? scheduleText("Ранее запущенная задача ещё выполняется или стоит в очереди.")
    : withdrawal && withdrawal.work_in_flight !== false ? scheduleText("Состояние ранее запущенной задачи неизвестно.") : "",
  ].filter(Boolean);
  return facts.join("\n");
}

export class SchedulesPage {
  readonly widget = column();
  private readonly list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE });
  private readonly status = label("", "dim-label");
  private readonly message = label("");
  private readonly filter = Gtk.DropDown.new_from_strings([scheduleText("Все расписания"), scheduleText("Действующие"), scheduleText("История и снятые")]);
  private readonly dialogs = new Set<any>();
  private readonly dialogCancels = new Map<any, any>();
  private readCancel?: any;
  private readonly rows = new Map<string, Schedule>();
  private readonly writes = new Set<string>();
  private generation = 0;
  private poll = 0;
  private reading = false;
  private loaded = false;
  private readProblem?: string;
  private renderedKey = "";
  private disposed = false;
  private paintingFilter = false;
  private readonly captions = new Map<any, Map<string, { owner?: any; paint: () => void; release: () => void }>>();
  private readonly renderedRows = new Map<any, { item: Schedule; open: any }>();
  private readonly stopI18n: () => void;

  // Repaint in place; an unrelated writer (including editor validation) takes ownership.
  private caption(widget: any, property: string, value: () => string, owner?: any): any {
    const properties = this.captions.get(widget) ?? new Map();
    properties.get(property)?.release();
    this.captions.set(widget, properties);
    let painting = false;
    const paint = () => { painting = true; try { widget.set_property(property, value()); } finally { painting = false; } };
    paint();
    const signal = widget.connect(`notify::${property}`, () => { if (!painting) release(); });
    const release = () => {
      if (!properties.has(property)) return;
      widget.disconnect(signal);
      properties.delete(property);
      if (!properties.size) this.captions.delete(widget);
    };
    properties.set(property, { owner, paint, release });
    return widget;
  }

  private captionButton(source: string, clicked: () => void, owner?: any): any {
    return this.caption(button("", clicked), "label", () => scheduleText(source), owner);
  }

  private clearReadback(target: any): void {
    for (const child of [...this.captions.keys()]) {
      if (child.get_parent?.() === target) for (const entry of [...this.captions.get(child)!.values()]) entry.release();
    }
    clear(target);
  }

  private paintFilter(): void {
    const selected = this.filter.get_selected();
    this.paintingFilter = true;
    try {
      const model = this.filter.get_model();
      model.splice(0, model.get_n_items(), ["Все расписания", "Действующие", "История и снятые"].map(source => scheduleText(source)));
      this.filter.set_selected(selected);
    } finally { this.paintingFilter = false; }
  }

  constructor(
    private readonly parent: any,
    private readonly gateway: Gateway,
    private readonly room: () => Room,
    private readonly projectRooms: () => Room[],
    private readonly openTask: (id: string) => void,
  ) {
    const tools = row();
    const create = this.captionButton("Новое расписание", () => this.edit());
    create.add_css_class("suggested-action");
    this.filter.set_hexpand(true);
    this.filter.connect("notify::selected", () => { if (!this.paintingFilter) this.render(); });
    tools.append(this.filter);
    tools.append(create);
    this.widget.append(tools);
    this.widget.append(this.status);
    this.widget.append(this.message);
    this.list.add_css_class("boxed-list");
    this.widget.append(new Gtk.ScrolledWindow({ child: this.list, vexpand: true }));
    this.stopI18n = watchNativeI18n(() => {
      if (this.disposed) return;
      this.paintFilter();
      for (const properties of [...this.captions.values()]) for (const entry of [...properties.values()]) entry.paint();
      this.render();
    });
  }

  setActive(active: boolean): void {
    if (this.disposed) return;
    if (active && !this.poll) {
      void this.refresh();
      this.poll = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
        if (!this.reading) void this.refresh();
        return GLib.SOURCE_CONTINUE;
      });
    } else if (!active && this.poll) {
      GLib.Source.remove(this.poll);
      this.poll = 0;
      this.generation++;
      this.readCancel?.cancel();
      this.reading = false;
    }
  }

  close(): void {
    if (this.disposed) return;
    this.setActive(false);
    this.disposed = true;
    this.readCancel?.cancel();
    for (const dialog of this.dialogs) dialog.force_close();
    this.stopI18n();
    for (const properties of [...this.captions.values()]) for (const entry of [...properties.values()]) entry.release();
    this.renderedRows.clear();
    this.filter.get_parent()?.remove(this.filter);
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { this.filter.run_dispose(); return GLib.SOURCE_REMOVE; });
  }

  private async read(cancel?: any): Promise<Schedule[]> {
    return readSchedules(await this.gateway.json<unknown>("GET", path, undefined, undefined, false, cancel));
  }

  async refresh(): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.generation;
    this.readCancel?.cancel();
    const cancel = new Gio.Cancellable();
    this.readCancel = cancel;
    this.reading = true;
    if (!this.loaded) this.render();
    try {
      const items = await this.read(cancel);
      if (this.disposed || generation !== this.generation) return;
      this.rows.clear();
      for (const item of items) if (item?.id) this.rows.set(item.id, item);
      this.loaded = true;
      this.readProblem = undefined;
      this.render();
    } catch (error) {
      if (!this.disposed && generation === this.generation) {
        this.readProblem = errorText(error);
        this.render();
      }
    } finally {
      if (this.readCancel === cancel) this.readCancel = undefined;
      if (generation === this.generation) this.reading = false;
    }
  }

  private render(): void {
    if (this.disposed) return;
    const filter = this.filter.get_selected();
    const retained = (item: Schedule) => {
      const status = statusOf(item);
      return status === "consumed" || (status === "disabled" && Boolean(item.time_passed_on))
        || (status === "delete_pending" && item.withdrawal?.work_in_flight !== true);
    };
    const items = [...this.rows.values()].filter((item) => filter === 0 || retained(item) === (filter === 2));
    if (this.readProblem) {
      this.status.set_label(this.rows.size ? scheduleText("Показаны ранее прочитанные записи. {error}", { error: this.readProblem }) : this.readProblem);
    } else if (!this.loaded && this.reading) {
      this.status.set_label(scheduleText("Читаю расписания…"));
    } else if (this.loaded) {
      this.status.set_label(items.length ? scheduleText("Расписаний в списке: {count}", { count: items.length })
        : filter === 0 ? scheduleText("Расписания не найдены.") : scheduleText("В этой группе нет расписаний."));
    }
    const key = JSON.stringify(items);
    if (this.renderedKey === key) {
      for (const [widget, { item, open }] of this.renderedRows) {
        widget.set_subtitle(scheduleSummary(item));
        open.set_tooltip_text(scheduleText("Открыть расписание"));
      }
      return;
    }
    this.renderedKey = key;
    clear(this.list);
    this.renderedRows.clear();
    for (const item of items) {
      const widget = actionRow({
        title: title(item), subtitle: scheduleSummary(item), use_markup: false, subtitle_lines: 3,
      });
      const open = new Gtk.Button({ icon_name: "go-next-symbolic", valign: Gtk.Align.CENTER, tooltip_text: scheduleText("Открыть расписание") });
      open.connect("clicked", () => { if (!this.disposed && this.renderedKey === key) this.details(item); });
      widget.add_suffix(open);
      widget.set_activatable_widget(open);
      this.list.append(widget);
      this.renderedRows.set(widget, { item, open });
    }
  }

  private present(dialog: any): void {
    if (this.disposed) return;
    this.dialogs.add(dialog);
    const cancel = new Gio.Cancellable();
    this.dialogCancels.set(dialog, cancel);
    dialog.connect("closed", () => {
      this.dialogs.delete(dialog); this.dialogCancels.delete(dialog); cancel.cancel();
      for (const properties of [...this.captions.values()]) {
        for (const entry of [...properties.values()]) if (entry.owner === dialog) entry.release();
      }
    });
    dialog.present(this.parent);
  }

  private details(item: Schedule): void {
    if (this.disposed) return;
    const content = column();
    const dialog = sheet(title(item), content);
    const live = () => !this.disposed && this.dialogs.has(dialog);
    const status = this.caption(label("", "dim-label"), "label", () => scheduleSummary(item), dialog);
    content.append(status);
    const instruction = (note(item) ? item.notification?.text : item.task?.text || item.task?.description || item.task?.objective)
      || item.description || item.objective_preview;
    if (instruction) content.append(selectable(instruction));
    if (item.description && item.description !== instruction) content.append(selectable(item.description));
    content.append(this.caption(selectable(""), "label", () => scheduleFacts(item), dialog));
    const previous = item.previous_run_open;
    const outcome = item.outcome;
    const origin = item.followup_origin;
    const last = outcome?.task_id ?? item.last_task_id;
    if (last && !note(item)) content.append(this.captionButton("Открыть последнюю задачу", () => { if (live()) this.openTask(last); }, dialog));
    if (previous?.task_id && previous.task_id !== last) {
      const id = previous.task_id;
      content.append(this.captionButton("Открыть предыдущий незавершённый запуск", () => { if (live()) this.openTask(id); }, dialog));
    }
    if (origin?.task_id && origin.task_id !== last && origin.task_id !== previous?.task_id) {
      const id = origin.task_id;
      content.append(this.captionButton("Открыть исходную задачу", () => { if (live()) this.openTask(id); }, dialog));
    }
    content.append(this.captionButton("Изменить расписание…", () => { if (live()) { dialog.close(); this.edit(item); } }, dialog));
    for (const action of actions(item)) {
      const widget = this.caption(button("", () => { if (live()) { dialog.close(); this.action(item, action); } }), "label", () => scheduleText(action.label) + "…", dialog);
      if (action.action === "delete") widget.add_css_class("destructive-action");
      content.append(widget);
    }
    this.present(dialog);
  }

  private offerReadback(id: string, target: any, dialog: any,
    retry?: { available: (current?: Schedule) => boolean; send: () => void }): void {
    const live = () => !this.disposed && this.dialogs.has(dialog) && check.get_parent() === target;
    this.clearReadback(target);
    const feedback = label("", "dim-label");
    const check = button("", () => {
      if (!live() || !check.get_sensitive()) return;
      check.set_sensitive(false);
      this.caption(feedback, "label", () => scheduleText("Читаю расписание…"), dialog);
      open.set_visible(false);
      resend.set_visible(false);
      void this.read(this.dialogCancels.get(dialog)).then((items) => {
        if (!this.dialogs.has(dialog) || check.get_parent() !== target) return;
        current = items.find((row) => row.id === id);
        const observed = current;
        this.caption(feedback, "label", () => observed ? scheduleText("Текущее состояние · {summary}", { summary: scheduleSummary(observed) })
          : scheduleText("Шлюз не вернул расписание с ID {id}.", { id }), dialog);
        open.set_visible(Boolean(current));
        resend.set_visible(retry?.available(current) === true);
        void this.refresh();
      }).catch((error: unknown) => {
        if (this.dialogs.has(dialog) && check.get_parent() === target) this.caption(feedback, "label", () => errorText(error), dialog);
      }).finally(() => {
        if (this.dialogs.has(dialog) && check.get_parent() === target) check.set_sensitive(true);
      });
    });
    this.caption(check, "label", () => scheduleText("Проверить запись на шлюзе"), dialog);
    let current: Schedule | undefined;
    const open = this.captionButton("Открыть прочитанную запись…", () => { if (live() && current) this.details(current); }, dialog);
    open.set_visible(false);
    const resend = this.captionButton("Повторить с тем же ID и данными", () => { if (live() && resend.get_visible() && retry?.available(current)) { resend.set_sensitive(false); retry.send(); } }, dialog);
    resend.set_visible(false);
    for (const widget of [check, feedback, open, resend]) target.append(widget);
  }

  private action(item: Schedule, action: Action): void {
    if (this.disposed) return;
    const content = column();
    const dialog = sheet(scheduleText(action.label), content);
    this.caption(dialog, "title", () => scheduleText(action.label), dialog);
    const group = new Adw.PreferencesGroup();
    const reason = new Adw.EntryRow({ title: action.action === "delete" ? scheduleText("Причина (необязательно)") : scheduleText("Причина") });
    const feedback = label("");
    this.caption(reason, "title", () => scheduleText(action.action === "delete" ? "Причина (необязательно)" : "Причина"), dialog);
    const readback = column(4);
    const relation = action.hold && item.relation === "unknown"
      ? Gtk.DropDown.new_from_strings([scheduleText("Выберите связь с исходной задачей"), scheduleText("Связано с исходной задачей"), scheduleText("Самостоятельная задача")]) : null;
    content.append(label(title(item), "title-3"));
    content.append(this.caption(label(""), "label", () => scheduleText(action.hold ? "Будет проверен ID удержания, показанного при открытии."
      : "Действие касается будущих запусков. Ранее принятая задача продолжает свой жизненный цикл."), dialog));
    let stopRelation: (() => void) | undefined;
    if (relation) {
      const paint = () => {
        const selected = relation.get_selected();
        const model = relation.get_model();
        model.splice(0, model.get_n_items(), ["Выберите связь с исходной задачей", "Связано с исходной задачей", "Самостоятельная задача"].map(source => scheduleText(source)));
        relation.set_selected(selected);
      };
      stopRelation = watchNativeI18n(paint);
      content.append(relation);
    }
    group.add(reason);
    content.append(group);
    const live = () => !this.disposed && this.dialogs.has(dialog);
    const send = async () => {
      if (!live() || !submit.get_sensitive()) return;
      const why = reason.get_text().trim();
      const choice = relation?.get_selected();
      if (!why && action.action !== "delete") { this.caption(feedback, "label", () => scheduleText("Укажите причину."), dialog); return; }
      if (relation && !choice) { this.caption(feedback, "label", () => scheduleText("Укажите связь с исходной задачей."), dialog); return; }
      if (this.writes.has(item.id)) { this.caption(feedback, "label", () => scheduleText("Операция с этим расписанием ещё выполняется."), dialog); return; }
      submit.set_sensitive(false);
      this.clearReadback(readback);
      this.writes.add(item.id);
      this.caption(feedback, "label", () => scheduleText("Проверяю текущее состояние…"), dialog);
      const itemPath = path + "/" + encodeURIComponent(item.id);
      let sent = false;
      try {
        const current = (await this.read(this.dialogCancels.get(dialog))).find((row) => row.id === item.id);
        if (!live()) return;
        const available = current && actions(current).some((candidate) => candidate.action === action.action && candidate.hold === action.hold);
        if (!current || !available || statusOf(current) !== statusOf(item) || current.relation !== item.relation
          || authoredFingerprint(current) !== authoredFingerprint(item)) {
          this.caption(feedback, "label", () => scheduleText("Состояние расписания изменилось. Проверьте свежую запись."), dialog);
          this.offerReadback(item.id, readback, dialog);
          void this.refresh();
          return;
        }
        sent = true;
        const result = action.action === "delete" && !why
          ? await this.gateway.json<LifecycleReceipt>("DELETE", itemPath, undefined, undefined, false, this.dialogCancels.get(dialog))
          : await this.gateway.json<LifecycleReceipt>("POST", itemPath + "/action", {
            action: action.action, reason: why, expected_hold_id: action.hold,
            relation: choice === 1 ? "related" : choice === 2 ? "independent" : undefined,
          }, undefined, false, this.dialogCancels.get(dialog));
        if (this.disposed) return;
        if (typeof result?.changed !== "boolean" || typeof result.ok !== "boolean" || !result.status
          || (result.schedule_id !== undefined && result.schedule_id !== item.id)) {
          throw new Error("Шлюз не вернул квитанцию для этого расписания.");
        }
        const message = () => actionMessage(result);
        this.caption(this.message, "label", message);
        void this.refresh();
        if (!live()) return;
        this.caption(feedback, "label", message, dialog);
        if (result.ok && result.changed && result.audit === "recorded" && appliedStatuses.has(result.status)
          && result.status !== "changed_audit_incomplete") dialog.close();
        else this.offerReadback(item.id, readback, dialog);
      } catch (error) {
        if (this.disposed) return;
        const refused = error instanceof HttpError && error.status === 400;
        const message = () => sent && !refused ? scheduleText("Результат действия неизвестен · {id}. {error}", { id: item.id, error: errorText(error) }) : errorText(error);
        if (sent) {
          this.caption(this.message, "label", message);
          void this.refresh();
        }
        if (!live()) return;
        this.caption(feedback, "label", message, dialog);
        if (sent) this.offerReadback(item.id, readback, dialog);
        if (!sent || refused) submit.set_sensitive(true);
      } finally {
        this.writes.delete(item.id);
      }
    };
    const submit = this.caption(button("", () => void send()), "label", () => scheduleText(action.label), dialog);
    if (action.action === "delete") submit.add_css_class("destructive-action");
    else submit.add_css_class("suggested-action");
    content.append(feedback);
    content.append(readback);
    content.append(submit);
    dialog.connect("closed", () => {
      submit.set_sensitive(false);
      stopRelation?.();
      if (relation) {
        content.remove(relation);
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { relation.run_dispose(); return GLib.SOURCE_REMOVE; });
      }
    });
    this.present(dialog);
  }

  private edit(item?: Schedule): void {
    if (this.disposed) return;
    const initial = this.room();
    const editor = new ScheduleEditor(item, initial, this.projectRooms(), (body, dialog, feedback, save, readback) => {
      void this.save(body, item, dialog, feedback, save, readback);
    });
    this.present(editor.dialog);
  }

  private async save(body: Definition, original: Schedule | undefined, dialog: any, feedback: any, save: any, readback: any,
    retrying = false): Promise<void> {
    const live = () => !this.disposed && this.dialogs.has(dialog);
    if (!live()) return;
    if (this.writes.has(body.id)) {
      this.caption(feedback, "label", () => scheduleText("Операция с этим расписанием ещё выполняется."), dialog);
      save.set_sensitive(!retrying);
      return;
    }
    this.writes.add(body.id);
    this.clearReadback(readback);
    let sent = false;
    try {
      const current = (await this.read(this.dialogCancels.get(dialog))).find((row) => row.id === body.id);
      if (!live()) return;
      if (!matchesStartingRow(current, original)) {
        this.caption(feedback, "label", () => scheduleText("Состояние расписания изменилось. Откройте свежую запись из списка перед сохранением."), dialog);
        this.offerReadback(body.id, readback, dialog);
        void this.refresh();
        return;
      }
      sent = true;
      const result = await this.gateway.json<{ ok?: boolean; schedule?: Schedule }>("POST", path, body, undefined, false, this.dialogCancels.get(dialog));
      if (this.disposed) return;
      const audit = result?.schedule?.audit;
      if (result?.schedule?.id !== body.id || (audit !== "recorded" && audit !== "incomplete") || result.ok !== (audit === "recorded")) {
        throw new Error("Шлюз не вернул квитанцию для этого расписания.");
      }
      const message = () => audit === "recorded"
        ? scheduleText("Расписание сохранено.") : scheduleText("Расписание записано, но запись аудита неполная.");
      this.caption(this.message, "label", message);
      if (live()) dialog.close();
      void this.refresh();
    } catch (error) {
      if (this.disposed) return;
      const definite = !sent || error instanceof HttpError && error.status < 500 && error.status !== 408 && error.status !== 429;
      if (live()) {
        this.caption(feedback, "label", () => definite ? errorText(error) : scheduleText("Результат неизвестен · {id}. {error}. Проверьте запись в списке.", { id: body.id, error: errorText(error) }), dialog);
        const repeat = retrying || !definite ? {
          available: (current?: Schedule) => matchesStartingRow(current, original),
          send: () => void this.save(body, original, dialog, feedback, save, readback, true),
        } : undefined;
        if (sent || retrying) this.offerReadback(body.id, readback, dialog, repeat);
        save.set_sensitive(definite && !retrying);
      }
      if (sent) {
        if (!definite) this.caption(this.message, "label", () => scheduleText("Результат записи неизвестен · {id}. {error}", { id: body.id, error: errorText(error) }));
        void this.refresh();
      }
    } finally {
      this.writes.delete(body.id);
    }
  }
}

class ScheduleEditor {
  readonly dialog: any;
  private readonly id: string;
  private readonly name: any;
  private readonly description: any;
  private readonly enabled: any;
  private readonly zone: any;
  private readonly kind = Gtk.DropDown.new_from_strings(["Повторяется (cron)", "Однократно"]);
  private readonly cron: any;
  private readonly runAt: any;
  private readonly instruction: any;
  private readonly priority: any;
  private readonly effort: any;
  private readonly effortValues = [...effort];
  private closed = false;
  private painting = false;
  private readonly stops: (() => void)[] = [];
  private helpRelease?: () => void;
  private readonly metadata: any;
  private readonly destination: any;
  private readonly destinations: Room[];
  private readonly originalDestination: number;
  private readonly feedback = label("");
  private readonly deadline: any;
  private readonly textFields = new Map<string, any>();
  private readonly jsonFields = new Map<string, { widget: any; list: boolean }>();
  private readonly reason = new Adw.EntryRow({ title: "Причина изменения (необязательно)" });

  constructor(
    private readonly original: Schedule | undefined,
    room: Room,
    projects: Room[],
    submit: (definition: Definition, dialog: any, feedback: any, save: any, readback: any) => void,
  ) {
    // Only this explicit chrome table can enter translation memory. Values and templates remain owner data.
    const sources: Record<string, string> = {
      "Изменить расписание": "Edit schedule", "Новое расписание": "New schedule",
      "Название": "Name", "Описание (необязательно)": "Description (optional)",
      "Запускать по расписанию": "Run on schedule", "Часовой пояс IANA": "IANA time zone",
      "Минуты · часы · день месяца · месяц · день недели": "Minute · hour · day of month · month · day of week",
      "Дата и время со смещением UTC": "Date and time with UTC offset", "Приоритет": "Priority",
      "Предельный срок задания ISO 8601": "Task deadline (ISO 8601)",
      "Причина изменения (необязательно)": "Reason for change (optional)",
      "Задание": "Task", "Назначение": "Destination", "Дополнительные параметры задания": "Advanced task options",
      "Метаданные задания (JSON-объект)": "Task metadata (JSON object)",
      "Контекст задания": "Task context", "Ожидаемый результат задания": "Expected task output",
      "Ограничения задания": "Task constraints", "Разрешённые ресурсы · объект JSON": "Allowed resources · JSON object",
      "Вложения задания · массив объектов JSON": "Task attachments · array of JSON objects",
      "Контракт задания · объект JSON": "Task contract · JSON object", "Когда запускать": "When to run",
      "Параметры передаются каждому запуску. Срок задания отличается от времени срабатывания расписания. Вложения описывают файлы на шлюзе; локальные файлы здесь не загружаются.": "These options apply to each run. The task deadline differs from the schedule trigger time. Attachments describe files on the gateway; local files are not uploaded here.",
      "Сохранить расписание": "Save schedule", "Проверяю текущее состояние…": "Checking current state…",
      "Введите название.": "Enter a name.", "Часовой пояс не распознан.": "Time zone is not recognized.",
      "Введите дату и время в ISO 8601 с явным смещением UTC.": "Enter an ISO 8601 date and time with an explicit UTC offset.",
      "Уже выполненный запуск требует нового времени.": "A completed run requires a new time.",
      "Cron должен содержать пять полей.": "Cron must contain five fields.", "Опишите задание.": "Describe the task.",
      "Предельный срок задания должен быть ISO 8601 с явным смещением UTC.": "The task deadline must use ISO 8601 with an explicit UTC offset.",
      "Приоритет должен быть целым числом.": "Priority must be an integer.",
      "Метаданные содержат ошибку JSON.": "Metadata contains invalid JSON.", "Метаданные должны быть JSON-объектом.": "Metadata must be a JSON object.",
    };
    const caption = <T>(widget: T, property: string): T => {
      const source = sources[(widget as any)[property]];
      if (source) this.stops.push(bindChrome(widget, property, source));
      return widget;
    };
    const fieldLabel = (source: string, style?: string) => caption(label(source, style), "label");
    const choices = (control: any, values: () => string[]) => {
      const model = control.get_model();
      const repaint = () => {
        if (this.closed) return;
        const selected = control.get_selected(); this.painting = true;
        try { model.splice(0, model.get_n_items(), values()); control.set_selected(selected); }
        finally { this.painting = false; }
      };
      this.stops.push(watchNativeI18n(repaint)); repaint();
    };
    const content = column();
    this.dialog = sheet(original ? "Изменить расписание" : "Новое расписание", content);
    caption(this.dialog, "title");
    this.dialog.set_content_width(640);
    this.dialog.set_content_height(650);
    this.id = original?.id || `gtk-${GLib.uuid_string_random()}`;
    const task = original?.task;
    const once = original?.trigger?.type === "once" ? original.trigger : undefined;
    this.name = new Adw.EntryRow({ title: "Название", text: original?.name ?? "" });
    this.description = new Adw.EntryRow({ title: "Описание (необязательно)", text: original?.description ?? "" });
    this.enabled = new Gtk.CheckButton({ label: "Запускать по расписанию", active: original?.enabled ?? true });
    this.enabled.set_sensitive(!original || statusOf(original) !== "delete_pending");
    this.zone = new Adw.EntryRow({ title: "Часовой пояс IANA", text: original ? original.timezone ?? "" : localZone() });
    this.cron = new Adw.EntryRow({
      title: "Минуты · часы · день месяца · месяц · день недели",
      text: original?.trigger?.type === "cron" ? original.trigger.expr : original?.cron || "0 9 * * *",
    });
    this.runAt = new Adw.EntryRow({
      title: "Дата и время со смещением UTC",
      text: once?.run_at ?? GLib.DateTime.new_now_local().add_hours(1).format("%Y-%m-%dT%H:%M:%S%:z"),
    });
    this.instruction = new Gtk.TextView({ wrap_mode: Gtk.WrapMode.WORD_CHAR, top_margin: 6, bottom_margin: 6 });
    this.instruction.get_buffer().set_text(task?.text ?? task?.description ?? task?.objective ?? "", -1);
    this.priority = new Adw.EntryRow({ title: "Приоритет", text: task?.priority == null ? "" : String(task.priority) });
    this.deadline = new Adw.EntryRow({ title: "Предельный срок задания ISO 8601", text: task?.deadline_at ?? "" });
    if (task?.reasoning_effort && !this.effortValues.includes(task.reasoning_effort)) this.effortValues.push(task.reasoning_effort);
    this.effort = Gtk.DropDown.new_from_strings(this.effortValues.map((value) => value || "Усилие по умолчанию"));
    this.effort.set_selected(Math.max(0, this.effortValues.indexOf(task?.reasoning_effort ?? "")));
    this.metadata = new Gtk.TextView({ monospace: true, wrap_mode: Gtk.WrapMode.WORD_CHAR });
    this.metadata.set_name("schedule-metadata");
    const metadata = withoutHostFields(task?.metadata);
    if (Object.keys(metadata).length) this.metadata.get_buffer().set_text(JSON.stringify(metadata, null, 2), -1);

    const main = { name: "Main", chatId: 1 };
    this.destinations = [main, ...projects.filter((candidate) => candidate.projectId)];
    const stored = original?.destination ?? task;
    const initial = original
      ? { name: "", projectId: stored?.project_id, chatId: stored?.chat_id }
      : room;
    let index = this.destinations.findIndex((candidate) => initial.projectId
      ? candidate.projectId === initial.projectId
      : !candidate.projectId && candidate.chatId === initial.chatId);
    const fallbackDestination = index < 0;
    if (index < 0) {
      index = this.destinations.length;
      this.destinations.push({
        name: initial.projectId ? `Проект ${initial.projectId}` : initial.chatId == null ? "Чат владельца по умолчанию" : `Чат ${initial.chatId}`,
        projectId: initial.projectId, chatId: initial.chatId ?? 1,
      });
    }
    this.originalDestination = index;
    this.destination = Gtk.DropDown.new_from_strings(this.destinations.map((item) => item.name));
    this.destination.set_selected(index);
    choices(this.kind, () => [chromeText("Repeats (cron)", undefined, "Повторяется (cron)"), chromeText("Once", undefined, "Однократно")]);
    choices(this.effort, () => this.effortValues.map(value => value || chromeText("Default effort", undefined, "Усилие по умолчанию")));
    choices(this.destination, () => this.destinations.map((item, at) => at === index && fallbackDestination
      ? initial.projectId ? chromeText("Project {id}", { id: initial.projectId }, item.name)
        : initial.chatId == null ? chromeText("Default owner chat", undefined, item.name) : chromeText("Chat {id}", { id: initial.chatId }, item.name)
      : item.name));
    for (const field of [this.name, this.description, this.zone, this.cron, this.runAt, this.priority, this.deadline, this.reason]) caption(field, "title");
    caption(this.enabled, "label");

    const fields = new Adw.PreferencesGroup();
    fields.add(this.name);
    fields.add(this.description);
    content.append(fields);
    if (note(original)) {
      if (original?.notification?.text) content.append(selectable(original.notification.text));
    } else {
      content.append(fieldLabel("Задание"));
      content.append(new Gtk.ScrolledWindow({ child: this.instruction, min_content_height: 100 }));
      content.append(fieldLabel("Назначение"));
      content.append(this.destination);
      const options = caption(new Gtk.Expander({ label: "Дополнительные параметры задания" }), "label");
      const extras = column();
      const advanced = new Adw.PreferencesGroup();
      advanced.add(this.priority);
      advanced.add(this.deadline);
      extras.append(advanced);
      extras.append(this.effort);
      extras.append(fieldLabel("Метаданные задания (JSON-объект)", "dim-label"));
      extras.append(new Gtk.ScrolledWindow({ child: this.metadata, min_content_height: 80 }));
      for (const [key, title] of [["context", "Контекст задания"], ["expected_output", "Ожидаемый результат задания"], ["constraints", "Ограничения задания"]]) {
        const input = new Gtk.TextView({ wrap_mode: Gtk.WrapMode.WORD_CHAR });
        input.set_name(`schedule-${key}`);
        input.get_buffer().set_text(typeof task?.[key] === "string" ? task[key] : "", -1);
        this.textFields.set(key, input);
        extras.append(fieldLabel(title));
        extras.append(new Gtk.ScrolledWindow({ child: input, min_content_height: 80 }));
      }
      for (const [key, title, list] of [
        ["allowed_resources", "Разрешённые ресурсы · объект JSON", false],
        ["attachments", "Вложения задания · массив объектов JSON", true],
        ["task_contract", "Контракт задания · объект JSON", false],
      ] as const) {
        const input = new Gtk.TextView({ monospace: true, wrap_mode: Gtk.WrapMode.WORD_CHAR });
        input.set_name(`schedule-${key}`);
        if (task?.[key] !== undefined) input.get_buffer().set_text(JSON.stringify(task[key], null, 2), -1);
        this.jsonFields.set(key, { widget: input, list });
        extras.append(fieldLabel(title, "dim-label"));
        extras.append(new Gtk.ScrolledWindow({ child: input, min_content_height: 80 }));
      }
      extras.append(fieldLabel("Параметры передаются каждому запуску. Срок задания отличается от времени срабатывания расписания. Вложения описывают файлы на шлюзе; локальные файлы здесь не загружаются.", "dim-label"));
      options.set_child(extras);
      content.append(options);
    }
    content.append(fieldLabel("Когда запускать", "title-4"));
    this.kind.set_selected(once ? 1 : 0);
    content.append(this.kind);
    const timing = new Adw.PreferencesGroup();
    timing.add(this.cron);
    timing.add(this.runAt);
    timing.add(this.zone);
    const help = label("", "dim-label");
    const update = () => {
      if (this.closed || this.painting) return;
      const once = this.kind.get_selected() === 1;
      this.runAt.set_visible(once);
      this.cron.set_visible(!once);
      this.helpRelease?.();
      help.set_label(once
        ? "Формат 2026-12-01T09:00:00+03:00. Часовой пояс ниже используется при отображении."
        : "Например, 0 9 * * * — каждый день в 09:00. Пустой часовой пояс означает часовой пояс шлюза.");
      this.helpRelease = bindChrome(help, "label", once
        ? "Use a date such as 2026-12-01T09:00:00+03:00. The time zone below is used for display."
        : "For example, 0 9 * * * runs daily at 09:00. An empty time zone uses the gateway time zone.");
    };
    this.kind.connect("notify::selected", update);
    update();
    content.append(timing);
    content.append(help);
    content.append(this.enabled);
    const audit = new Adw.PreferencesGroup();
    audit.add(this.reason);
    content.append(audit);
    const readback = column(4);
    const save = button("Сохранить расписание", () => {
      if (this.closed || !save.get_sensitive()) return;
      try {
        const definition = this.definition();
        this.feedback.set_label("Проверяю текущее состояние…");
        caption(this.feedback, "label");
        save.set_sensitive(false);
        submit(definition, this.dialog, this.feedback, save, readback);
      } catch (error) {
        this.feedback.set_label(errorText(error));
        caption(this.feedback, "label");
      }
    });
    caption(save, "label");
    this.dialog.connect("closed", () => {
      this.closed = true; save.set_sensitive(false); this.helpRelease?.(); this.helpRelease = undefined;
      for (const stop of this.stops.splice(0)) stop();
      // Retire dropdowns outside their selection notification and before GJS finalization.
      for (const control of [this.kind, this.effort, this.destination]) control.get_parent()?.remove(control);
      GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        for (const control of [this.kind, this.effort, this.destination]) control.run_dispose();
        return GLib.SOURCE_REMOVE;
      });
    });
    save.add_css_class("suggested-action");
    content.append(this.feedback);
    content.append(readback);
    content.append(save);
  }

  private definition(): Definition {
    const name = this.name.get_text().trim();
    if (!name) throw new Error("Введите название.");
    const timezone = this.zone.get_text().trim();
    if (timezone && !GLib.TimeZone.new_identifier(timezone)) throw new Error("Часовой пояс не распознан.");
    const enabled = this.enabled.get_active();
    let trigger: Trigger;
    if (this.kind.get_selected() === 1) {
      const run_at = this.runAt.get_text().trim();
      const instant = GLib.DateTime.new_from_iso8601(run_at, null);
      if (!instant || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(run_at)) {
        throw new Error("Введите дату и время в ISO 8601 с явным смещением UTC.");
      }
      const old = this.original?.trigger;
      if (enabled && this.original?.completed_at && old?.type === "once") {
        const prior = GLib.DateTime.new_from_iso8601(old.run_at, GLib.TimeZone.new_utc());
        if (prior && instant.compare(prior) === 0) throw new Error("Уже выполненный запуск требует нового времени.");
      }
      trigger = { type: "once", run_at };
    } else {
      const expr = this.cron.get_text().trim();
      if (expr.split(/\s+/).length !== 5) throw new Error("Cron должен содержать пять полей.");
      trigger = { type: "cron", expr };
    }

    const stored = this.original?.task;
    const task: Template = { ...withoutHostFields(stored), type: "task" };
    if (note(this.original)) {
      if (stored?.metadata) task.metadata = withoutHostFields(stored.metadata);
    } else {
      const text = this.readText(this.instruction);
      if (!text.trim()) throw new Error("Опишите задание.");
      const before = stored?.text ?? stored?.description ?? stored?.objective;
      if (text !== before) {
        task.text = text;
        if (stored?.description !== undefined) task.description = text;
        if (stored?.objective !== undefined) task.objective = text;
      }
      for (const [key, input] of this.textFields) {
        const value = this.readText(input);
        if (value) task[key] = value;
        else delete task[key];
      }
      const deadline = this.deadline.get_text().trim();
      if (deadline) {
        if (!GLib.DateTime.new_from_iso8601(deadline, null) || !/(?:Z|[+-]\d{2}:\d{2})$/iu.test(deadline)) {
          throw new Error("Предельный срок задания должен быть ISO 8601 с явным смещением UTC.");
        }
        task.deadline_at = deadline;
      } else delete task.deadline_at;
      for (const [key, { widget, list }] of this.jsonFields) {
        const raw = this.readText(widget).trim();
        if (!raw) { delete task[key]; continue; }
        let value: unknown;
        try { value = JSON.parse(raw); } catch { throw new Error(`Поле «${key}» содержит ошибку JSON.`); }
        const document = (item: unknown) => Boolean(item && typeof item === "object" && !Array.isArray(item));
        if (list ? !Array.isArray(value) || value.some(item => !document(item)) : !document(value)) {
          throw new Error(`Поле «${key}» должно содержать ${list ? "массив объектов" : "объект"} JSON.`);
        }
        task[key] = value;
      }
      const priority = this.priority.get_text().trim();
      if (priority) {
        const value = Number(priority);
        if (!/^-?\d+$/.test(priority) || !Number.isSafeInteger(value)) throw new Error("Приоритет должен быть целым числом.");
        task.priority = value;
      } else delete task.priority;
      const level = this.effortValues[this.effort.get_selected()];
      if (level) task.reasoning_effort = level;
      else delete task.reasoning_effort;
      if (!this.original || this.destination.get_selected() !== this.originalDestination) {
        const destination = this.destinations[this.destination.get_selected()];
        task.chat_id = destination.chatId;
        if (destination.projectId) task.project_id = destination.projectId;
        else delete task.project_id;
      }
      const raw = this.readText(this.metadata).trim();
      if (raw) {
        let metadata: unknown;
        try { metadata = JSON.parse(raw); } catch { throw new Error("Метаданные содержат ошибку JSON."); }
        if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Метаданные должны быть JSON-объектом.");
        const reserved = Object.keys(metadata).find((key) => reservedTemplate.has(key) || key === "reasoning_effort");
        if (reserved) throw new Error(`Поле метаданных «${reserved}» задаётся отдельно или принадлежит шлюзу.`);
        task.metadata = metadata as Record<string, unknown>;
      } else delete task.metadata;
    }
    return {
      id: this.id, name, description: this.description.get_text().trim(), enabled, timezone, trigger, task,
      reason: this.reason.get_text().trim() || undefined,
    };
  }

  private readText(widget: any): string {
    const buffer = widget.get_buffer();
    return buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false);
  }
}
