import { renderSwarmReceipt } from "./swarm-receipt.js";
import { rootTaskAttempt } from "./task-lineage.js";
import { OwnerKeepDialog } from "./owner-keep.js";
import { DispatchFactsView } from "./dispatch-facts.js";
import { TaskReconciliationView } from "./task-reconciliation.js";
import { TaskStopOriginView } from "./task-stop-origin.js";
import { TaskCancellationView } from "./task-cancellation.js";
import { projectHold, projectHoldPanel } from "./project-hold.js";
import { Adw, Gio, GLib, Gtk } from "./gi.js";
import { type DownloadIdentity, type Gateway, type Query, query } from "./gateway.js";
import type { Room } from "./chat.js";
import { recordedTaskCause, renderTaskOutcome, renderTaskResult, taskLifecycleLabel } from "./task-outcome.js";
import { renderWrapUp } from "./task-wrap-up.js";
import { renderTaskDelivery, taskDelivery, type TaskDeliveryData } from "./task-delivery.js";
import { adoptionPanel, mergeBodyAdoptions } from "./body-adoptions.js";
import { renderTaskCost, type TaskCost, type TaskCostBreakdown } from "./cost-view.js";
import { renderExecutor } from "./delegated-activity.js";
import { modelWait, type ModelWait, type OwnerAttention } from "./owner-attention.js";
import { OwnerAttentionView, waitDescription } from "./owner-attention-view.js";
import { confirmedProjectBinding, projectHandoff, projectNotice, type ProjectTarget } from "./project-handoff.js";
import { projectFromTaskOptions, type ProjectFromTaskRequest } from "./project-from-task.js";
import { PublicationResult } from "./publication-result.js";
import { object } from "./settings-write.js";
import { TaskEvents } from "./task-events.js";
import { TaskInventory, taskTitle } from "./task-inventory.js";
import { renderAttachmentManifest, TaskLaunch } from "./task-launch.js";
import { renderTaskArtifacts, renderTaskContract, renderWorkspacePreflight } from "./task-materials.js";
import { TaskReviews, type TaskReviewData } from "./task-reviews.js";
import { TaskHurryView } from "./task-hurry.js";
import { TaskHistoryRetentionView } from "./task-history-retention.js";
import { continuationOf, exactWorkTarget, type PendingWorkRequest, type WorkControl, WorkActions, workActionNames } from "./work-actions.js";
import { type Work, type WorkState } from "./work-state.js";
import { alert, button, chooseFile, clear, column, confirm, errorText, label, row, sheet } from "./ui.js";

export interface Task extends TaskReviewData, TaskCost, TaskDeliveryData {
  task_id?: string;
  id?: string;
  title?: string;
  suggested_name?: string;
  description?: string;
  objective?: string;
  updated_at?: string;
  ts?: string;
  error?: string;
  reason_code?: string;
  delegate_terminal_reconciliation?: unknown;
  cancel_origin?: unknown;
  cancel_state?: string;
  cancel_reason?: string;
  stop_policy?: string;
  project_admission_hold?: unknown;
  project_id?: string;
  chat_id?: number;
  parent_task_id?: string;
  metadata?: { subagents_mode?: string; parent_task_id?: string };
  swarm_efficiency?: unknown;
  swarm_receipt?: unknown;
  continuation_offer?: unknown;
  continued_by?: unknown;
  owner_keep?: { at?: string; note?: string };
  model_waits?: Record<string, ModelWait>;
  cost_breakdown?: TaskCostBreakdown;
}

interface HandoffRecovery { step: "check" | "retry"; message: string; project?: ProjectTarget; request?: ProjectFromTaskRequest }

const active = new Set(["requested", "scheduled", "queued", "pending", "running", "starting"]);
const paused = new Set(["paused", "budget_paused", "owner_paused", "technical_pause", "interrupted"]);

export class TasksPage {
  readonly widget = column();
  private readonly inventory: TaskInventory;
  private readonly openDetails = new Map<string, TaskDetail>();
  private readonly handoffs = new Map<string, HandoffRecovery>();
  private disposed = false;
  private readonly workActions: WorkActions;
  private readonly launch: TaskLaunch;

  constructor(
    private readonly parent: any,
    private readonly gateway: Gateway,
    private readonly room: () => Room,
    private readonly projectChanged: (task: string, target: ProjectTarget) => void,
    private readonly openHistory?: (taskId: string, projectId?: string, chatId?: number) => void,
    private readonly workState?: WorkState,
    private readonly ownerAttention?: OwnerAttention,
    private readonly openSettings?: () => void,
    private readonly openProject?: (target: ProjectTarget) => void,
    private readonly projectForTask?: (task: string) => ProjectTarget | undefined,
    private readonly continuationUpdated?: (task: string) => void,
  ) {
    this.workActions = workState?.actions ?? new WorkActions(gateway);
    this.launch = new TaskLaunch(parent, gateway, (id) => this.show(id), () => void this.refresh());
    this.inventory = new TaskInventory(gateway, room, (id, task) => this.show(id, task), projectForTask);
    const toolbar = row();
    toolbar.append(button("Новая задача", () => this.launch.show(this.room())));
    this.widget.append(toolbar);
    this.inventory.widget.set_vexpand(true);
    this.widget.append(this.inventory.widget);
  }

  close(): void {
    this.disposed = true;
    this.inventory.close();
    this.launch.close();
    for (const detail of this.openDetails.values()) detail.close();
    if (!this.workState) this.workActions.close();
  }

  refresh(): Promise<void> { return this.inventory.refresh(); }
  setActive(active: boolean): void { this.inventory.setActive(active); }
  roomChanged(): void { this.inventory.roomChanged(); }

  show(id: string, task?: Task): void {
    if (this.disposed) return;
    const existing = this.openDetails.get(id);
    if (existing) {
      existing.present();
      return;
    }
    const detail = new TaskDetail(this.parent, this.gateway, id, this.workActions, {
      close: () => this.openDetails.delete(id),
      refresh: (continued?: boolean) => {
        if (continued) this.continuationUpdated?.(id);
        void this.refresh();
      },
      open: (next) => this.show(next),
      projectChanged: this.projectChanged,
      openProject: this.openProject,
      projectForTask: this.projectForTask,
      handoffRecovery: this.handoffs.get(id),
      rememberHandoff: (recovery) => {
        if (recovery) this.handoffs.set(id, recovery);
        else this.handoffs.delete(id);
      },
      openHistory: this.openHistory,
    }, task, this.workState, this.ownerAttention, this.openSettings);
    this.openDetails.set(id, detail);
    detail.present();
  }

  continuationChanged(predecessor: unknown): void {
    if (exactWorkTarget(predecessor)) void this.openDetails.get(predecessor)?.refresh();
  }


}

interface DetailActions {
  close: () => void;
  refresh: (continued?: boolean) => void;
  open: (taskId: string) => void;
  projectChanged: (task: string, target: ProjectTarget) => void;
  openProject?: (target: ProjectTarget) => void;
  projectForTask?: (task: string) => ProjectTarget | undefined;
  handoffRecovery?: HandoffRecovery;
  rememberHandoff: (recovery?: HandoffRecovery) => void;
  openHistory?: (taskId: string, projectId?: string, chatId?: number) => void;
}

class TaskDetail {
  private readonly dialog = new Adw.Dialog({ content_width: 680, content_height: 640 });
  private readonly summary = column();
  private readonly costBody = column(4);
  private readonly cost = new Gtk.Expander({ label: "Расходы задачи", child: this.costBody });
  private readonly controls = column();
  private readonly status = label("", "dim-label");
  private readonly cancellation = new TaskCancellationView();
  private readonly reconciliation: TaskReconciliationView;
  private readonly dispatchFacts = new DispatchFactsView();
  private readonly stopOrigin = new TaskStopOriginView();
  private readonly hurry = new TaskHurryView();
  private readonly historyRetention = new TaskHistoryRetentionView();
  private readonly readStatus = label("", "dim-label");
  private readonly cancel = new Gio.Cancellable();
  private readonly events: TaskEvents;
  private readonly publication: PublicationResult;
  private task?: Task;
  private readonly swarmExpanded = new Map<string, boolean>();
  private outcomeExpanded = false;
  private deliveryExpanded = false;
  private deliveryPoll = 0;
  private predecessor?: string;
  private actionPending = false;
  private downloading = false;
  private project?: ProjectTarget;
  private handoff: "check" | "retry" | "settled" | undefined;
  private handoffRequest?: ProjectFromTaskRequest;
  private handoffDialog?: any;
  private disposed = false;
  private load = 0;
  private readonly path: string;
  private readonly reviews: TaskReviews;
  private retentionDialog?: any;
  private retentionController?: OwnerKeepDialog;
  private readonly offWork?: () => void;
  private readonly attentionView?: OwnerAttentionView;

  constructor(
    private readonly parent: any,
    private readonly gateway: Gateway,
    private readonly id: string,
    private readonly workActions: WorkActions,
    private readonly actions: DetailActions,
    task?: Task,
    private readonly workState?: WorkState,
    ownerAttention?: OwnerAttention,
    openSettings?: () => void,
  ) {
    this.path = `/api/tasks/${encodeURIComponent(id)}`;
    this.reviews = new TaskReviews(gateway);
    this.reconciliation = new TaskReconciliationView(this.dialog, gateway);
    this.task = task;
    if (actions.handoffRecovery) {
      const { step, message, project } = actions.handoffRecovery;
      this.handoff = step;
      this.project = project;
      this.handoffRequest = actions.handoffRecovery.request;
      this.status.set_label(message);
    }
    const content = column();
    content.set_margin_top(10);
    content.set_margin_bottom(12);
    content.set_margin_start(12);
    content.set_margin_end(12);
    this.publication = new PublicationResult(id, () => this.events.showHistory());
    this.events = new TaskEvents(this.dialog, gateway, id, () => void this.refresh(), (event) => this.publication.observe(event));
    for (const widget of [this.status, this.readStatus, this.cancellation.widget, this.stopOrigin.widget, this.reconciliation.widget, this.summary, this.dispatchFacts.widget, this.publication.widget, this.cost, this.hurry.widget, this.historyRetention.widget, this.controls, this.events.widget]) content.append(widget);
    if (ownerAttention) {
      this.attentionView = new OwnerAttentionView(this.dialog, gateway, ownerAttention, undefined, openSettings, false, id);
      content.insert_child_after(this.attentionView.widget, this.controls);
    }
    const toolbar = new Adw.ToolbarView();
    const header = new Adw.HeaderBar();
    header.pack_start(button("Обновить", () => void this.refresh()));
    toolbar.add_top_bar(header);
    toolbar.set_content(new Gtk.ScrolledWindow({ child: content, vexpand: true }));
    this.dialog.set_child(toolbar);
    this.dialog.connect("closed", () => {
      this.disposed = true;
      this.handoffDialog?.force_close();
      this.cancelDeliveryPoll();
      this.cancel.cancel();
      this.events.close();
      this.hurry.close();
      this.historyRetention.close();
      this.cancellation.close();
      this.stopOrigin.close();
      this.dispatchFacts.close();
      this.reconciliation.close();
      this.reviews.close();
      this.offWork?.();
      this.attentionView?.close();
      this.actions.close();
    });
    this.offWork = workState?.subscribe(() => this.renderControls());
    this.render();
    void this.refresh();
  }

  close(): void {
    this.stopOrigin.close();
    this.dispatchFacts.close();
    this.reconciliation.close();
    this.reviews.close();
    this.retentionDialog?.force_close();
    this.dialog.force_close();
  }

  present(): void {
    this.dialog.present(this.parent);
    if (!this.workState?.loaded) void this.workState?.refresh();
  }

  async refresh(): Promise<void> {
    this.cancelDeliveryPoll();
    const load = ++this.load;
    try {
      const detail = await this.gateway.json<Task>("GET", this.path, undefined, undefined, false, this.cancel);
      if (this.disposed || load !== this.load) return;
      const identity = detail.task_id || detail.id;
      if (identity && identity !== this.id) throw new Error("Шлюз вернул сведения о другой задаче.");
      this.readStatus.set_label("");
      this.task = { ...detail, body_adoptions: mergeBodyAdoptions(this.task?.body_adoptions, detail.body_adoptions) };
      this.stopOrigin.update(detail.cancel_origin);
      this.reconciliation.update(detail);
      this.hurry.update(detail);
      this.historyRetention.update(detail);
      const record = object(detail);
      const predecessor = object(object(record.continuation_admission).binding).predecessor_task_id
        ?? object(object(record.metadata).continuation).predecessor_task_id;
      if (predecessor !== this.predecessor) this.predecessor = undefined;
      this.render();
      if (exactWorkTarget(predecessor) && predecessor !== this.id && !this.predecessor
        && !detail.parent_task_id && !detail.metadata?.parent_task_id) void this.readPredecessor(predecessor, load);
    } catch (error) {
      if (!this.disposed && load === this.load) this.readStatus.set_label(`Не удалось прочитать сведения о задаче. ${errorText(error)}`);
    } finally {
      if (!this.disposed && load === this.load && this.task && (taskDelivery(this.id, this.task)?.pending || this.hurry.waiting() || this.historyRetention.waiting() || this.cancellation.waiting() || this.reconciliation.waiting() || Boolean(projectHold(this.task)))) {
        this.deliveryPoll = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
          this.deliveryPoll = 0;
          void this.refresh();
          return GLib.SOURCE_REMOVE;
        });
      }
    }
  }

  private cancelDeliveryPoll(): void {
    if (this.deliveryPoll) GLib.Source.remove(this.deliveryPoll);
    this.deliveryPoll = 0;
  }

  private async readPredecessor(predecessor: string, load: number): Promise<void> {
    try {
      const record = await this.gateway.json<Task>("GET", `/api/tasks/${encodeURIComponent(predecessor)}`,
        undefined, undefined, false, this.cancel);
      if (!this.disposed && load === this.load && (record.task_id || record.id) === predecessor
        && continuationOf(record, predecessor).successor === this.id) {
        this.predecessor = predecessor;
        this.renderControls();
      }
    } catch { /* Retry with the next detail read. */ }
  }

  private render(): void {
    const task = this.task;
    this.dialog.set_title(task ? taskTitle(task) : this.id);
    clear(this.summary);
    clear(this.controls);
    this.publication.update(task);
    this.cost.set_visible(renderTaskCost(this.costBody, task));
    this.cancellation.update(task);
    this.dispatchFacts.update(task);
    if (!task) return;
    const refused = task.admission_outcome === "never_admitted";
    this.summary.append(label([taskLifecycleLabel(task),
      this.id].filter(Boolean).join(" · "), "dim-label"));
    const hold = projectHoldPanel(task);
    if (hold) this.summary.append(hold);
    renderTaskOutcome(this.summary, task, this.outcomeExpanded, value => { this.outcomeExpanded = value; });
    renderTaskDelivery(this.summary, this.id, task, this.deliveryExpanded, value => { this.deliveryExpanded = value; });
    const swarm = renderSwarmReceipt(task, this.id, this.swarmExpanded);
    if (swarm) this.summary.append(swarm);
    const waits = Object.entries(task.model_waits ?? {}).filter(([id, wait]) => modelWait(wait, id));
    if (waits.length) {
      const items = column(4);
      for (const [, wait] of waits) items.append(label([`Попытка ${wait.task_attempt}`, waitDescription(wait),
        wait.saved_request_id && "Настройки шлюза сохранены"].filter(Boolean).join(" · "), "dim-label"));
      this.summary.append(new Gtk.Expander({ label: "Записи об ожидании моделей", child: items }));
    }
    for (const value of [task.objective || task.description, task.error || recordedTaskCause(task),
      refused && task.error && task.reason_code && task.error !== task.reason_code ? `Причина · ${task.reason_code}` : ""]) {
      if (value) {
        const text = label(value);
        text.set_selectable(true);
        this.summary.append(text);
      }
    }
    renderTaskResult(this.summary, task);
    const adoptions = adoptionPanel(mergeBodyAdoptions(undefined, task.body_adoptions));
    if (adoptions) this.summary.append(adoptions);
    renderExecutor(this.summary, task);
    renderTaskContract(this.summary, task);
    renderWorkspacePreflight(this.summary, task);
    this.reviews.taskEvidence(this.dialog, this.summary, this.id, task);
    renderAttachmentManifest(this.dialog, this.summary, this.id, task, this.reviews);
    renderTaskArtifacts(this.dialog, this.summary, this.id, task, this.reviews,
      (name, selector, identity) => void this.download(name, selector, identity));
    renderWrapUp(this.summary, this.dialog, this.gateway, this.id, task, id => this.actions.open(id),
      (name, selector) => void this.download(name, selector), () => !this.disposed);
    this.renderControls();
  }

  private renderControls(): void {
    if (this.disposed) return;
    clear(this.controls);
    const task = this.task;
    if (!task) return;
    const refused = task.admission_outcome === "never_admitted";
    const project = this.project ?? this.actions.projectForTask?.(this.id);
    const buttons = new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.NONE, column_spacing: 6, row_spacing: 6 });
    const add = (text: string, activate: () => void) => buttons.append(button(text, activate));
    add("Ревью…", () => this.reviews.history(this.dialog, this.id, this.task));
    if (this.actions.openHistory && !refused) add("Показать в истории чата", () => {
      if (this.dialog.close()) this.actions.openHistory?.(this.id, project?.id ?? task.project_id, project?.chatId ?? task.chat_id);
    });
    const seen = new Set<string>();
    const controls: { work?: Work; control: WorkControl }[] = refused ? [] : this.workState && !this.workState.legacy
      ? this.workState.forTask(this.id) : this.legacyControls(task).map((control) => ({ control }));
    for (const { work, control } of controls) {
      const action = control.action === "stop_earlier" ? "stop" : control.action;
      if (seen.has(action)) continue;
      seen.add(action);
      const item = button(workActionNames[action], () => void this.change(control, work));
      item.set_sensitive(!this.workActions.busy(control.target));
      buttons.append(item);
      if (action === "pause") {
        const reason = button("Пауза с причиной…", () => void this.change(control, work, true));
        reason.set_sensitive(!this.workActions.busy(control.target));
        buttons.append(reason);
      }
    }
    const offer = continuationOf(refused ? undefined : task, this.id);
    const successor = offer.successor;
    const predecessor = this.predecessor;
    if (predecessor) add("Открыть предыдущую попытку", () => this.actions.open(predecessor));
    if (successor) add("Открыть продолжение", () => this.actions.open(successor));
    else if (offer.kind === "offer" || offer.kind === "retry") {
      const action = button(offer.kind === "retry" ? "Повторить продолжение" : "Продолжить задачу",
        () => void this.change({ action: "continue", target: this.id }));
      action.set_sensitive(!this.workActions.busy(this.id));
      buttons.append(action);
    }
    if (project && this.actions.openProject) {
      add(`Открыть проект · ${project.name || project.id}`, () => {
        if (this.dialog.close()) this.actions.openProject?.(project);
      });
    }
    if (this.handoff === "check") add("Проверить привязку на шлюзе", () => void this.convert(true));
    else if (this.handoff === "retry") {
      add(this.project ? "Повторить запрос квитанции" : "Повторить перенос задачи", () => void this.convert());
      if (!this.project) add("Изменить параметры переноса…", () => this.convertOptions());
    }
    else if (!refused && !this.handoff && !project && !task.project_id && !task.parent_task_id && !task.metadata?.parent_task_id) {
      add("Создать проект из задачи", () => void this.convert());
      add("Параметры переноса…", () => this.convertOptions());
    }
    add("Хранение материалов…", () => this.retention());
    this.controls.append(buttons);
    try {
      const pending = this.workActions.pending(this.id);
      if (pending.length) {
        this.controls.append(label("Неподтверждённые запросы", "heading"));
        for (const request of pending) {
          const content = column(4);
          const identity = label(request.request_id, "dim-label");
          identity.set_selectable(true);
          content.append(identity);
          const retry = button(`Повторить запрос · ${workActionNames[request.control.action]}`, () => void this.retryRequest(request));
          retry.set_sensitive(!this.workActions.busy(this.id) && this.canRetry(request));
          content.append(retry);
          if (!this.canRetry(request)) content.append(label("Повтор ждёт подтверждения той же попытки работы шлюзом.", "dim-label"));
          this.controls.append(content);
        }
      }
    } catch (error) { this.controls.append(label(errorText(error), "error")); }
    if (offer.message) this.controls.append(label(offer.message, "dim-label"));
    this.controls.set_sensitive(!this.actionPending);
  }

  private retention(): void {
    if (this.disposed || this.retentionDialog) return;
    const controller = new OwnerKeepDialog(this.dialog, this.gateway, this.id, () => {
      if (this.retentionController !== controller) return;
      this.retentionController = undefined;this.retentionDialog = undefined;
      if (!this.disposed) void this.refresh();
    });
    this.retentionController = controller;this.retentionDialog = controller.dialog;
  }

  private legacyControls(task: Task): WorkControl[] {
    const state = task.status ?? "";
    const controls: WorkControl[] = [];
    if ((active.has(state) || paused.has(state)) && !this.cancellation.observed()) {
      controls.push({ action: "stop", target: this.id, scope: "cascade" });
      if (state === "running") {
        controls.push({ action: "wrap_up", target: this.id });
        if (rootTaskAttempt(task, this.id)) {
          for (const action of ["pause", "hurry"] as const) controls.push({ action, target: this.id });
        }
      }
    }
    if (paused.has(state) && !this.cancellation.observed()) controls.push({ action: "resume", target: this.id });
    return controls;
  }

  private canRetry(request: PendingWorkRequest): boolean {
    if ((!this.workState || this.workState.legacy) && ["pause", "hurry"].includes(request.control.action)
      && !rootTaskAttempt(this.task, this.id)) return false;
    // A settled task has no live attempt. Its original Stop can still be reconciled
    // by the same idempotent request and the gateway's task detail.
    const settledStop = ["stop", "stop_earlier", "wrap_up"].includes(request.control.action)
      && ["completed", "failed", "cancelled", "rejected_duplicate"].includes(this.task?.status ?? "");
    return !this.disposed && Boolean(this.task) && !this.readStatus.get_label()
      && (!this.workState || this.workState.legacy || this.workState.complete)
      && (settledStop || (this.workState?.attempt(request.control) ?? "") === request.attempt);
  }

  private async retryRequest(request: PendingWorkRequest): Promise<void> {
    if (this.actionPending || !this.canRetry(request)) return;
    this.actionPending = true;
    this.controls.set_sensitive(false);
    try {
      await this.refresh();
      if (this.workState && !this.workState.legacy && !await this.workState.refresh()) return;
      const result = await this.workActions.retry(this.dialog, request, () => this.canRetry(request));
      if (!this.disposed) this.status.set_label(result.text);
    } catch (error) {
      if (!this.disposed) this.status.set_label(errorText(error));
    } finally {
      this.actionPending = false;
      if (!this.disposed) {
        this.controls.set_sensitive(true);
        void this.refresh();
        this.actions.refresh(false);
        void this.workState?.refresh();
      }
    }
  }

  private async change(control: WorkControl, work?: Work, editPauseReason = false): Promise<void> {
    if (this.actionPending || this.disposed) return;
    const attempt = this.workState?.attempt(control) ?? "";
    const { action } = control;
    this.actionPending = true;
    this.controls.set_sensitive(false);
    try {
      if (action === "stop" || action === "stop_earlier" || action === "wrap_up") {
        const approved = await confirm(this.dialog, "Остановить задачу?", action === "wrap_up"
          ? "Шлюз сначала попробует сохранить частичный результат."
          : "Запрос остановит задачу и связанные с ней работы.", "Остановить");
        if (!approved || this.disposed) return;
      }
      if (work && !await this.workState?.refresh()) {
        if (!this.disposed) this.status.set_label("Шлюз не подтвердил актуальные действия.");
        return;
      }
      const result = await this.workActions.run(this.dialog, control, attempt, () => {
        if (this.disposed || !this.task) return false;
        if (work) return this.workState?.allows(work.work_id, control, attempt) === true;
        if (action === "continue") {
          return ["offer", "retry", "successor"].includes(continuationOf(this.task, this.id).kind);
        }
        return (!this.workState || this.workState.legacy) && this.legacyControls(this.task).some((item) => item.action === action);
      }, { editPauseReason });
      if (this.disposed) return;
      this.status.set_label(result.text);
      if (result.successor) this.actions.open(result.successor);
    } catch (error) {
      if (!this.disposed) this.status.set_label(errorText(error));
    } finally {
      this.actionPending = false;
      if (!this.disposed) {
        this.controls.set_sensitive(true);
        void this.refresh();
        this.actions.refresh(action === "continue");
        void this.workState?.refresh();
      }
    }
  }

  private convertOptions(): void {
    if (this.handoffDialog || this.disposed || this.actionPending) return;
    const dialog = projectFromTaskOptions(this.dialog, (options) => {
      const task = this.task;
      if (this.disposed || this.actionPending || this.handoff && this.handoff !== "retry" || this.project || task?.admission_outcome === "never_admitted"
        || task?.project_id || task?.parent_task_id
        || task?.metadata?.parent_task_id || this.actions.projectForTask?.(this.id)) return false;
      void this.convert(false, { ...options, task_id: this.id });
      return true;
    }, this.handoff === "retry" ? this.handoffRequest : undefined);
    this.handoffDialog = dialog;
    dialog.connect("closed", () => { if (this.handoffDialog === dialog) this.handoffDialog = undefined; });
  }

  private async convert(check = false, request?: ProjectFromTaskRequest): Promise<void> {
    if (this.actionPending || this.disposed) return;
    this.actionPending = true;
    this.controls.set_sensitive(false);
    this.status.set_label(check ? "Проверяю привязку…" : "Запрашиваю перенос задачи…");
    const body: ProjectFromTaskRequest = this.project ? { task_id: this.id, project_id: this.project.id }
      : { ...(request ?? this.handoffRequest), task_id: this.id };
    if (!check && !this.project) this.handoffRequest = body;
    if (!check) this.actions.rememberHandoff({ step: "check", project: this.project, request: this.handoffRequest,
      message: "Ответ на запрос переноса неизвестен. Проверьте привязку на шлюзе." });
    try {
      if (check) {
        const state = await this.gateway.json<unknown>(
          "GET", "/api/state", undefined, undefined, false, this.cancel,
        );
        if (this.disposed) return;
        const target = confirmedProjectBinding(state, this.id);
        if (target?.chatId && (!this.project || this.project.id === target.id && this.project.chatId === target.chatId)) {
          this.project = target;
          this.actions.projectChanged(this.id, target);
          const expected = this.handoffRequest?.project_id;
          this.reportHandoff("retry", expected && expected !== target.id
            ? `Шлюз связал задачу с проектом «${target.name || target.id}» вместо «${expected}». Квитанция о доставке в Main пока неизвестна.`
            : "Привязка сохранена. Квитанция о доставке в Main пока неизвестна.");
        } else if (!this.project && !target) {
          this.reportHandoff("retry", "Привязка отсутствует в актуальном снимке шлюза. Можно повторить перенос или изменить его параметры.");
        } else {
          this.reportHandoff("check", "Шлюз пока не подтвердил состояние привязки.");
        }
        return;
      }
      const raw = await this.gateway.json<unknown>(
        "POST", "/api/projects/from-task", body, undefined, false, this.cancel,
      );
      if (this.disposed) return;
      const result = projectHandoff(raw, this.id);
      if (!result || body.project_id && body.project_id !== result.target.id
        || (this.project && (this.project.id !== result.target.id || this.project.chatId !== result.target.chatId))) {
        throw new Error("Ответ шлюза не подтвердил точную привязку задачи.");
      }
      this.project = result.target;
      this.actions.projectChanged(this.id, result.target);
      const step = ["durable", "already_delivered", "origin_unproven"].includes(String(result.receipt)) ? "settled" : "retry";
      this.reportHandoff(step, `Задача связана с проектом «${result.target.name || result.target.id}». ${projectNotice(result.receipt) ?? "Квитанция о доставке в Main пока неизвестна."}`);
      this.actions.refresh();
    } catch (error) {
      if (!this.disposed) {
        this.reportHandoff("check", `Перенос не подтверждён. ${errorText(error)}`);
      }
    } finally {
      this.actionPending = false;
      if (!this.disposed) this.renderControls();
    }
  }

  private reportHandoff(step: HandoffRecovery["step"] | "settled", message: string): void {
    this.handoff = step;
    this.status.set_label(message);
    this.actions.rememberHandoff(step === "settled" ? undefined : { step, message, project: this.project, request: this.handoffRequest });
  }

  private async download(name: string, selector: Query, identity?: DownloadIdentity): Promise<void> {
    if (this.disposed || this.downloading) return;
    this.downloading = true;
    try {
      const file = await chooseFile(this.dialog, name.split("/").pop() || "artifact", this.cancel);
      if (!file || this.disposed) return;
      await this.gateway.download(`${this.path}/artifacts/${encodeURIComponent(name)}` + query(selector), file, true, this.cancel, identity);
      if (!this.disposed) this.status.set_label("Материал сохранён · " + name);
    } catch (error) {
      if (!this.disposed) alert(this.dialog, "Ошибка скачивания", errorText(error));
    } finally {
      this.downloading = false;
    }
  }

}
