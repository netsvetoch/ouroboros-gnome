import { Gio, GLib, Gtk } from "./gi.js";
import { type Gateway, type GatewayFrame } from "./gateway.js";
import { BootStatusView } from "./boot-status.js";
import { InlineExecutorsView } from "./inline-executors.js";
import { projectHoldPanel } from "./project-hold.js";
import { RuntimeCommands } from "./commands.js";
import { readGatewayHealth } from "./connection-probe.js";
import { Diagnostics } from "./diagnostics.js";
import { type TaskCost, taskCostSummary, usd } from "./cost-view.js";
import { type CampaignState, EvolutionCampaign } from "./evolution-campaign.js";
import { GatewayContractView } from "./gateway-contract-view.js";
import { Storage } from "./storage.js";
import { chooseSystemReviewer } from "./system-review.js";
import { Updates } from "./updates.js";
import { WorkPanel } from "./work-panel.js";
import { type OwnerQuestions, OwnerQuestionsPanel } from "./owner-questions.js";
import { type OwnerAttention } from "./owner-attention.js";
import { OwnerAttentionView } from "./owner-attention-view.js";
import { type WorkState } from "./work-state.js";
import { button, clear, column, errorText, label, row } from "./ui.js";

interface RuntimeState extends CampaignState {
  supervisor_error?: string;
  context_mode?: string;
  safety_mode?: string;
  workers_alive?: number;
  workers_total?: number;
  branch?: string;
  sha?: string;
  state_quality?: { quality?: string; source?: string; unconfirmed?: string[] };
  bg_consciousness_enabled?: boolean | null;
  work_summary?: { counts?: Record<string, number>; confirmed?: boolean };
}

interface QueueItem {
  id?: string;
  task_id?: string;
  task?: { id?: string; task_id?: string; title?: string; description?: string; objective?: string; text?: string; project_id?: string; project_admission_hold?: unknown };
}

interface Queue {
  running_count?: number;
  pending_count?: number;
  worker_total?: number;
  pool_observation_status?: string;
  ts?: string;
  reason?: string;
  running?: QueueItem[];
  pending?: QueueItem[];
}

interface RecentWake extends TaskCost {
  task_id?: string;
  chat_id?: number | null;
  cause?: string;
  place_label?: string;
  started_at?: string | null;
  ended_at?: string | null;
  first_reply_at?: string | null;
  as?: { label?: string; owner?: boolean };
  phase?: string;
  live?: boolean;
  quiet?: boolean;
  said_owner?: boolean;
  summary?: string;
  note?: string | null;
  rounds?: number | null;
  tool_calls?: number | null;
  checks?: { chip?: string; tool?: string }[];
}

interface Consciousness {
  enabled?: boolean | null;
  status?: string;
  detail?: string;
  level?: string;
  appointment_at?: string;
  last_wake_at?: string;
  last_wake_outcome?: string;
  live_wake_held?: boolean;
  live_wake_task_id?: string;
  last_error?: string;
  spent_24h_usd?: number | null;
  daily_usd?: number | null;
  unknown_unmetered?: number;
  integrity_degraded?: boolean;
  spend_by_cause?: { cause?: string; label?: string; usd?: number | null; unmetered_calls?: number }[];
  places_brief?: { place_id?: string; label?: string; state?: string; unanswered?: number }[];
  recent_wakes_coverage?: string;
  recent_wakes?: RecentWake[] | null;
}

const record = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === "object" && !Array.isArray(value));
function runtimeSnapshot(value: RuntimeState): RuntimeState {
  if (!record(value) || typeof value.runtime_mode !== "string" || typeof value.supervisor_ready !== "boolean"
    || value.state_quality?.unconfirmed !== undefined && (!Array.isArray(value.state_quality.unconfirmed)
      || !value.state_quality.unconfirmed.every(item => typeof item === "string"))) throw new Error("Шлюз не подтвердил снимок супервизора.");
  return value;
}
function queueSnapshot(value: { queue?: Queue }): { queue: Queue } {
  const queue = value?.queue;
  if (!record(queue) || !Array.isArray(queue.running) || !Array.isArray(queue.pending)
    || ![...queue.running, ...queue.pending].every(record)
    || [queue.running_count, queue.pending_count, queue.worker_total].some(value => value != null
      && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0))) throw new Error("Шлюз не подтвердил снимок очереди.");
  return { ...value, queue };
}
function backgroundSnapshot(value: Consciousness): Consciousness {
  if (!record(value) || typeof value.status !== "string"
    || [value.recent_wakes, value.spend_by_cause, value.places_brief].some(value => value != null
      && (!Array.isArray(value) || !value.every(record)))) throw new Error("Шлюз не подтвердил снимок фоновой работы.");
  return value;
}

const wakePhases: Record<string, string> = {
  running: "Выполняется", working: "В работе", waiting: "Ожидает", queued: "В очереди",
  paused: "Приостановлено", unknown: "Состояние неизвестно", done: "Завершено",
  warn: "Завершено с замечаниями", error: "Ошибка", cancelled: "Отменено",
};
const wakeChecks: Record<string, string> = {
  checked: "Проверено", warned: "Выдано предупреждение", held: "Удержано",
  sent_despite: "Отправлено вопреки проверке", not_checked: "Не проверено",
};

function facts(target: any, values: [string, string | number | null | undefined][]): void {
  for (const [name, value] of values) {
    if (value == null || value === "") continue;
    const field = label(`${name} · ${value}`);
    field.set_selectable(true);
    target.append(field);
  }
}

function state(value?: boolean | null): string {
  return value === true ? "включено" : value === false ? "выключено" : "неизвестно";
}

export class ActivityPage {
  readonly widget = column();
  readonly commands: RuntimeCommands;
  private readonly stack = new Gtk.Stack({ vexpand: true });
  private readonly summary = column();
  private readonly message = label("", "dim-label");
  private readonly health = column();
  private readonly bootStatus = new BootStatusView();
  private readonly inlineExecutors = new InlineExecutorsView(id => { if (!this.disposed) this.openTask(id); });
  private readonly runtime = column();
  private readonly queue = column();
  private readonly background = column();
  private readonly expandedWakes = new Set<string>();
  private readonly diagnostics: Diagnostics;
  private readonly campaign: EvolutionCampaign;
  private readonly contract: GatewayContractView;
  private readonly storage: Storage;
  private readonly updates: Updates;
  private readonly panic: any;
  private reviewDialog?: any;
  private reviewCancel?: any;
  private readonly workPanel?: WorkPanel;
  private readonly ownerQuestionsPanel?: OwnerQuestionsPanel;
  private readonly ownerAttentionView?: OwnerAttentionView;
  private poll = 0;
  private active = false;
  private disposed = false;
  private reading = false;
  private generation = 0;
  private core?: RuntimeState;
  private overviewCancel?: any;
  private readonly sectionErrors = new Map<any, any>();
  private backgroundFresh = false;
  private backgroundRevision = 0;
  private backgroundToggle?: any;

  constructor(
    parent: any,
    private readonly gateway: Gateway,
    private readonly openTask: (id: string) => void,
    requestPanic: () => Promise<boolean> | undefined,
    private readonly workState?: WorkState,
    private readonly ownerQuestions?: OwnerQuestions,
    private readonly ownerAttention?: OwnerAttention,
    openSettings?: () => void,
    private readonly openWakeTask?: (id: string, chatId: number) => void,
    private readonly openWakeRoom?: (chatId: number) => void,
  ) {
    this.commands = new RuntimeCommands(parent, gateway, requestPanic);
    this.diagnostics = new Diagnostics(gateway, openTask);
    this.campaign = new EvolutionCampaign(parent, this.commands, () => this.overview(), openTask);
    this.contract = new GatewayContractView(parent, gateway);
    this.storage = new Storage(parent, gateway, openTask);
    this.updates = new Updates(parent, gateway, this.commands, openTask);
    if (ownerAttention) this.ownerAttentionView = new OwnerAttentionView(parent, gateway, ownerAttention, openTask, openSettings);
    if (workState) this.workPanel = new WorkPanel(parent, workState, openTask, false, ownerQuestions,
      ownerAttention ? (taskId, waitId) => this.ownerAttentionView?.showWait(taskId, waitId) === true : undefined);
    if (ownerQuestions) this.ownerQuestionsPanel = new OwnerQuestionsPanel(ownerQuestions);
    this.diagnostics.versions.prepend(button("Обновления шлюза…", () => this.updates.show()));
    const buttons = new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.NONE, column_spacing: 6, row_spacing: 6 });
    for (const [text, command] of [["Статус", "/status"], ["Перезапустить", "/restart"]]) {
      const control = button(text, () => void this.command(command, control));
      buttons.append(control);
    }
    const review = button("Ревью…", () => void this.review(parent, review));
    buttons.append(review);
    this.panic = button("Аварийная остановка", () => void this.command("/panic", this.panic));
    this.panic.add_css_class("destructive-action");
    buttons.append(this.panic);
    buttons.append(button("Хранилище…", () => this.storage.show()));
    this.summary.append(buttons);
    this.summary.append(this.message);
    if (this.ownerQuestionsPanel) this.summary.append(this.ownerQuestionsPanel.widget);
    if (this.ownerAttentionView) this.summary.append(this.ownerAttentionView.widget);
    for (const [heading, section] of [
      ["Шлюз", this.health], ["Супервизор", this.runtime], ["Саморазвитие", this.campaign.widget], ["Активная работа", this.workPanel?.widget],
      ["Очередь задач", this.queue], ["Фоновая работа", this.background],
    ] as const) {
      if (!section) continue;
      this.summary.append(label(heading, "title-3"));
      this.summary.append(section);
    }
    this.stack.add_titled(new Gtk.ScrolledWindow({ child: this.summary, hscrollbar_policy: Gtk.PolicyType.NEVER }), "overview", "Обзор");
    this.stack.add_titled(this.diagnostics.logs, "logs", "Журналы");
    this.stack.add_titled(this.diagnostics.cost, "cost", "Расходы");
    this.stack.add_titled(this.diagnostics.versions, "versions", "Версии");
    this.stack.add_titled(this.contract.widget, "contract", "API");
    this.widget.append(new Gtk.StackSwitcher({ stack: this.stack, halign: Gtk.Align.CENTER }));
    this.widget.append(this.stack);
    this.stack.connect("notify::visible-child-name", () => {
      if (this.stack.get_visible_child_name() !== "logs") this.diagnostics.suspendLogs();
      if (this.stack.get_visible_child_name() !== "overview") { this.leaveQuestions(); this.suspendOverview(); }
      if (!this.active) return;
      if (this.stack.get_visible_child_name() === "contract") void this.contract.ensureLoaded();
      else void this.refresh();
    });
  }

  setActive(active: boolean): void {
    if (this.disposed || this.active === active) return;
    this.active = active;
    if (active) {
      if (this.stack.get_visible_child_name() === "contract") void this.contract.ensureLoaded();
      else void this.refresh();
      this.poll = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => {
        const view = this.stack.get_visible_child_name();
        if (view === "overview" && !this.reading) void this.overview();
        else this.diagnostics.tick(view);
        return GLib.SOURCE_CONTINUE;
      });
    } else {
      this.suspendOverview();
      if (!this.poll) return;
      this.leaveQuestions();
      GLib.Source.remove(this.poll);
      this.poll = 0;
      this.diagnostics.suspendLogs();
    }
  }

  private suspendOverview(): void {
    this.overviewCancel?.cancel();
    this.overviewCancel = undefined;
    this.generation++;
    this.reading = false;
    this.backgroundFresh = false;
    this.backgroundToggle?.set_sensitive(false);
    this.campaign.unavailable();
  }

  private sectionFailure(section: any, error: unknown): void {
    const old = this.sectionErrors.get(section);
    if (old?.get_parent() === section) section.remove(old);
    const warning = label([section.get_first_child() ? "Показано последнее прочитанное состояние." : "", errorText(error)].filter(Boolean).join(" "), "error");
    section.prepend(warning);
    this.sectionErrors.set(section, warning);
  }

  private sectionReady(section: any): void {
    clear(section);
    this.sectionErrors.delete(section);
  }

  private leaveQuestions(): void {
    this.ownerQuestionsPanel?.invalidate();
    this.workPanel?.invalidateQuestions();
    this.ownerAttentionView?.leave();
  }

  close(): void {
    this.setActive(false);
    this.disposed = true;
    this.suspendOverview();
    this.bootStatus.close();
    this.inlineExecutors.close();
    this.commands.close();
    this.diagnostics.close();
    this.campaign.close();
    this.contract.close();
    this.storage.close();
    this.updates.close();
    this.reviewCancel?.cancel();
    if (this.reviewDialog?.get_mapped()) this.reviewDialog.force_close();
    this.reviewDialog = undefined;
    this.workPanel?.close();
    this.ownerQuestionsPanel?.close();
    this.ownerAttentionView?.close();
  }

  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const view = this.stack.get_visible_child_name();
    if (view === "contract") return this.contract.refresh();
    return view === "overview" ? this.overview() : this.diagnostics.refresh(view);
  }

  onFrame(frame: GatewayFrame): void {
    if (frame.type === "update_status_ready" || frame.type === "update_progress_changed" || frame.type === "task_done"
      || frame.type === "owner_continue_admitted" || frame.type === "log"
      && ["task_done", "owner_continue_admitted"].includes(String((frame.data as { type?: string } | undefined)?.type))) {
      this.updates.invalidate();
    }
    if (this.active && this.stack.get_visible_child_name() === "logs" && frame.type === "log") this.diagnostics.onLog();
  }

  reconnected(): void { this.panic.set_sensitive(this.commands.canPanic()); }

  private async command(cmd: string, control: any): Promise<void> {
    if (this.disposed) return;
    control.set_sensitive(false);
    try {
      const result = await this.commands.send(cmd);
      if (this.disposed) return;
      if (result.message) this.message.set_label(result.message);
      if (cmd !== "/panic") void this.overview();
    } finally {
      if (!this.disposed) control.set_sensitive(cmd !== "/panic" || this.commands.canPanic());
    }
  }

  private async review(parent: any, control: any): Promise<void> {
    if (this.disposed || this.reviewCancel) return;
    const cancel = this.reviewCancel = new Gio.Cancellable();
    control.set_sensitive(false);
    try {
      const command = await chooseSystemReviewer(this.gateway, (dialog) => {
        if (this.disposed) return false;
        this.reviewDialog = dialog;
        dialog.connect("closed", () => { if (this.reviewDialog === dialog) this.reviewDialog = undefined; });
        dialog.present(parent);
        return true;
      }, cancel);
      if (command && !this.disposed) await this.command(command, control);
    } catch (error) {
      if (!this.disposed) this.message.set_label(errorText(error));
    } finally {
      if (this.reviewCancel === cancel) this.reviewCancel = undefined;
      if (!this.disposed) control.set_sensitive(true);
    }
  }

  private async overview(): Promise<void> {
    if (this.disposed) return;
    this.overviewCancel?.cancel();
    const cancel = this.overviewCancel = new Gio.Cancellable();
    this.reading = true;
    const readAt = GLib.get_monotonic_time();
    const generation = ++this.generation;
    const results = await Promise.allSettled([
      this.gateway.publicJson("/api/health", cancel).then(readGatewayHealth),
      this.gateway.json<RuntimeState>("GET", "/api/state", undefined, undefined, false, cancel).then(runtimeSnapshot),
      this.gateway.json<{ queue?: Queue }>("GET", "/api/tasks?queue_only=1", undefined, undefined, false, cancel).then(queueSnapshot),
      this.gateway.json<Consciousness>("GET", "/api/consciousness", undefined, undefined, false, cancel).then(backgroundSnapshot),
    ] as const);
    if (this.disposed || this.generation !== generation) return;
    this.reading = false;
    this.overviewCancel = undefined;
    const [health, runtime, queue, background] = results;
    this.core = runtime.status === "fulfilled" ? runtime.value : undefined;
    this.ownerQuestions?.observe(this.core, readAt);
    this.ownerAttention?.observe(this.core, readAt);
    if (health.status === "fulfilled") {
      this.sectionReady(this.health);
      const value = health.value;
      this.commands.observeBoot(value.boot?.since);
      this.panic.set_sensitive(this.commands.canPanic());
      facts(this.health, [["Версия", value.runtime_version ?? value.version], ["Версия приложения", value.app_version],
        ["ABI", value.abi_version]]);
      this.bootStatus.update(value.boot);
      this.health.append(this.bootStatus.widget);
      this.inlineExecutors.update(value.inline_executors);
      this.health.append(this.inlineExecutors.widget);
    } else {
      this.sectionFailure(this.health, health.reason);
      this.bootStatus.unavailable();
      if (!this.bootStatus.widget.get_parent()) this.health.append(this.bootStatus.widget);
      this.inlineExecutors.unavailable();
      if (!this.inlineExecutors.widget.get_parent()) this.health.append(this.inlineExecutors.widget);
    }
    if (runtime.status === "fulfilled") {
      this.sectionReady(this.runtime);
      this.workState?.observe(runtime.value, readAt);
      this.campaign.observe(runtime.value, readAt);
      this.renderRuntime(runtime.value);
    }
    else {
      this.workState?.failed(readAt);
      this.campaign.unavailable();
      this.sectionFailure(this.runtime, runtime.reason);
    }
    if (queue.status === "fulfilled") { this.sectionReady(this.queue); this.renderQueue(queue.value.queue); }
    else this.sectionFailure(this.queue, queue.reason);
    this.backgroundFresh = background.status === "fulfilled";
    if (background.status === "fulfilled") { this.sectionReady(this.background); this.renderBackground(background.value); }
    else { this.backgroundToggle?.set_sensitive(false); this.sectionFailure(this.background, background.reason); }
  }

  private renderRuntime(value: RuntimeState): void {
    facts(this.runtime, [
      ["Готовность", value.supervisor_ready === true ? "готов" : value.supervisor_ready === false ? "ещё не готов" : "неизвестна"],
      ["Ошибка", value.supervisor_error], ["Активные работники", value.workers_alive], ["Всего работников", value.workers_total],
      ["Режим", value.runtime_mode], ["Контекст", value.context_mode], ["Безопасность", value.safety_mode],
      ["Ветка", value.branch], ["Коммит", value.sha], ["Качество состояния", value.state_quality?.quality],
      ["Неподтверждённые поля", value.state_quality?.unconfirmed?.join(", ")],
    ]);
    const counts = value.work_summary?.counts;
    if (counts) facts(this.runtime, [["Работают", counts.working], ["Ожидают", counts.waiting],
      ["В очереди", counts.queued], ["Приостановлены", counts.paused], ["Состояние неизвестно", counts.unknown]]);
    if (value.work_summary?.confirmed === false) this.runtime.append(label("Сводка работы подтверждена частично.", "dim-label"));
  }

  private renderQueue(queue: Queue): void {
    facts(this.queue, [["Выполняются", queue.running_count], ["Ожидают запуска", queue.pending_count],
      ["Работники", queue.worker_total], ["Наблюдение", queue.pool_observation_status], ["Снимок", queue.ts], ["Примечание", queue.reason]]);
    for (const [items, status] of [[queue.running, "В работе"], [queue.pending, "В очереди"]] as const) {
      for (const item of items ?? []) {
        const id = item.id || item.task_id || item.task?.id || item.task?.task_id;
        const title = item.task?.title || item.task?.objective || item.task?.description || item.task?.text || id;
        if (id) {
          this.queue.append(button(`${status} · ${title}`, () => { if (!this.disposed) this.openTask(id); }));
          const hold = projectHoldPanel(item.task ?? {});
          if (hold) this.queue.append(hold);
        }
      }
    }
  }

  private renderBackground(value: Consciousness): void {
    this.backgroundToggle = undefined;
    const revision = ++this.backgroundRevision;
    const enabled = value.enabled === undefined ? this.core?.bg_consciousness_enabled : value.enabled;
    facts(this.background, [["Состояние", state(enabled)], ["Статус", value.status], ["Подробности", value.detail],
      ["Автономность", value.level], ["Назначенное пробуждение", value.detail ? undefined : value.appointment_at],
      ["Предыдущее пробуждение", value.last_wake_at], ["Результат", value.last_wake_outcome],
      ["Расходы за 24 часа", usd(value.spent_24h_usd)], ["Суточный лимит", usd(value.daily_usd)],
      ["Вызовы без цены", value.unknown_unmetered], ["Ошибка", value.last_error]]);
    if (value.integrity_degraded) this.background.append(label("Данные учёта неполные.", "dim-label"));
    if (typeof enabled === "boolean") {
      const toggle = button(enabled ? "Остановить фоновую работу" : "Запустить фоновую работу",
        () => { if (!this.disposed && this.backgroundFresh && this.backgroundRevision === revision) void this.command(enabled ? "/bg stop" : "/bg start", toggle); });
      this.backgroundToggle = toggle;
      this.background.append(toggle);
    }
    const wakes = Array.isArray(value.recent_wakes) ? value.recent_wakes.filter((wake) => wake && typeof wake === "object") : undefined;
    if (value.live_wake_task_id) {
      const id = value.live_wake_task_id;
      const wake = wakes?.find((wake) => wake.task_id === id);
      const open = wake ? this.wakeDestination(wake) : () => this.openTask(id);
      if (open) this.background.append(button(value.live_wake_held ? "Открыть удерживаемое пробуждение" : "Открыть текущее пробуждение", () => { if (!this.disposed) open(); }));
    }
    for (const entry of value.spend_by_cause ?? []) {
      this.background.append(label(`${entry.label || entry.cause || "Причина"} · ${usd(entry.usd)}`
        + (entry.unmetered_calls ? ` · вызовов без цены: ${entry.unmetered_calls}` : "")));
    }
    for (const place of value.places_brief ?? []) {
      facts(this.background, [[place.label || place.place_id || "Место", place.state], ["Без ответа", place.unanswered]]);
    }
    this.background.append(label("Недавние пробуждения", "heading"));
    if (value.recent_wakes_coverage) this.background.append(label(value.recent_wakes_coverage, "dim-label"));
    if (!wakes) {
      this.background.append(label("Данные пробуждений недоступны.", "dim-label"));
      return;
    }
    if (!wakes.length) this.background.append(label("За показанный период пробуждений нет.", "dim-label"));
    const ids = new Set(wakes.map((wake) => wake.task_id));
    for (const id of this.expandedWakes) if (!ids.has(id)) this.expandedWakes.delete(id);
    for (const [focus, title] of [[false, "Собственные пробуждения"], [true, "Пробуждения в местах"]] as const) {
      const group = wakes.filter((wake) => (wake.cause === "focus") === focus);
      if (!group.length) continue;
      this.background.append(label(title, "heading"));
      for (const wake of group) this.renderWake(wake);
    }
  }

  private wakeDestination(wake: RecentWake): (() => void) | undefined {
    const open = this.wakeTarget(wake);
    return open ? () => { if (!this.disposed) open(); } : undefined;
  }

  private wakeTarget(wake: RecentWake): (() => void) | undefined {
    const { chat_id: chatId, task_id: id } = wake;
    if (chatId === 1 && id && this.openWakeTask) return () => this.openWakeTask?.(id, chatId);
    if (wake.cause === "focus" && this.openWakeRoom && typeof chatId === "number" && Number.isSafeInteger(chatId) && chatId > 1) {
      return () => this.openWakeRoom?.(chatId);
    }
    if (id && wake.cause !== "focus") return () => this.openTask(id);
    return undefined;
  }

  private renderWake(wake: RecentWake): void {
    const focus = wake.cause === "focus";
    const phase = wakePhases[wake.phase ?? ""] ?? wakePhases.unknown;
    const content = column(4);
    facts(content, [
      ["Начало", wake.started_at], ["Завершение", wake.ended_at],
      ["Первый ответ или автоматический выпуск", focus ? wake.first_reply_at : undefined],
      ["Аккаунт на момент фокуса", focus && wake.as?.label ? wake.as.label + (wake.as.owner === true ? " · ваш аккаунт" : "") : undefined],
      ["Уведомление владельцу", wake.said_owner === true ? "отправлено" : wake.said_owner === false ? "не отправлено" : undefined],
      ["Завершение без уведомления", wake.quiet === true && wake.live !== true ? "да" : undefined],
      ["Раунды", wake.rounds], ["Вызовы инструментов", wake.tool_calls],
      [wake.cost_presentation?.scope === "root_tree" ? "Расход с подзадачами" : "Расход", taskCostSummary(wake, wake.live)],
      ["Ошибка учёта", wake.cost_accounting_error], ["Итог", wake.summary], ["Заметка", wake.note],
    ]);
    for (const check of Array.isArray(wake.checks) ? wake.checks : []) {
      if (check?.chip) facts(content, [["Проверка", [wakeChecks[check.chip] ?? check.chip, check.tool].filter(Boolean).join(" · ")]]);
    }
    const open = this.wakeDestination(wake);
    if (open) content.append(button(wake.chat_id === 1 && this.openWakeTask ? "Открыть в Main"
      : focus ? "Открыть разговор" : "Открыть задачу", open));
    else if (focus) content.append(label("Сохранённая комната не указана.", "dim-label"));
    const box = new Gtk.Expander({
      label: [focus ? wake.place_label || "Место" : "Собственное пробуждение", wake.started_at, phase].filter(Boolean).join(" · "),
      expanded: wake.task_id ? this.expandedWakes.has(wake.task_id) : false,
      child: content,
    });
    const id = wake.task_id;
    if (id) box.connect("notify::expanded", () => {
      if (box.get_expanded()) this.expandedWakes.add(id);
      else this.expandedWakes.delete(id);
    });
    this.background.append(box);
  }
}
