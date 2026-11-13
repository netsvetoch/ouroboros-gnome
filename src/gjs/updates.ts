import { Gio, GLib, Gtk } from "./gi.js";
import { readGatewayHealth } from "./connection-probe.js";
import { type Gateway, HttpError } from "./gateway.js";
import { type RuntimeCommands } from "./commands.js";
import { button, clear, column, confirm, errorText, label, row, sheet } from "./ui.js";
import { type UpdateProgress, type UpdateSamples, type UpdateTransaction, UpdateAttemptView, updateOutcomes, updateRecovery } from "./update-attempt.js";
import { type UpdateEvidence, type UpdateRange as Range, updateEvidence } from "./update-evidence.js";
import { type UpdateEffects, updateEffects } from "./update-effects.js";
import { type GitVersions, type OfficialRelease, commitSha, officialReleases, restoreVersions } from "./update-versions.js";
import { type UpdateStatus, canPrepareUpdate, updateStatusView } from "./update-status.js";
import { type Letter, type LetterMode, letterAction, letterContent, letterFailure, letterInProgress, letterRequestView, letterSources,
  pinned, sameRange } from "./update-letter.js";

type Doc = Record<string, unknown>;
type Strategy = "auto_merge" | "assisted" | "replace" | "manual";
type DescriptionAction = NonNullable<ReturnType<typeof letterAction>>;

interface Plan extends Range {
  kind?: string;
  available?: boolean;
  auto_mergeable?: boolean;
  recommended_strategy?: Strategy;
  merge_commit?: string;
  local_dirty_count?: number;
  code_conflict_paths?: string[];
  doc_conflict_paths?: string[];
  hot_code_paths?: string[];
  error?: string;
}

interface Status extends UpdateStatus {
  official_tags?: OfficialRelease[];
  update_tx?: UpdateTransaction;
  update_progress?: UpdateProgress;
  after_update?: UpdateSamples | null;
  letter?: Letter | null;
}

interface Preflight {
  merge_plan?: Plan;
  effects?: UpdateEffects | null;
  letter?: Letter | null;
  qualification?: UpdateEvidence | null;
}

interface Boot { since?: string; phase?: string }

interface Observation {
  kind: "apply" | "restore" | "reset";
  boot?: string;
  originalOperation?: string;
  range?: Range;
  target?: string;
  runningAtStart?: string;
  acknowledged?: boolean;
  needsRestart?: boolean;
}

const path = "/api/update/";

function object(value: unknown): Doc {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Doc : {};
}

function facts(container: any, values: [string, unknown][]): void {
  for (const [key, value] of values) {
    if (value == null || value === "") continue;
    const widget = label(`${key} · ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
    widget.set_selectable(true);
    container.append(widget);
  }
}

function disclosure(container: any, title: string, values: [string, unknown][]): void {
  const widget = new Gtk.Expander({ label: title });
  const body = column(4);
  facts(body, values);
  widget.set_child(body);
  container.append(widget);
}

export class Updates {
  private readonly attempt: UpdateAttemptView;
  private dialog?: any;
  private body?: any;
  private message?: any;
  private controls: any[] = [];
  private status?: Status;
  private releases?: { source?: string; items: OfficialRelease[] };
  private letterSubmission?: { mode: LetterMode; range: Range; previous?: string; taskId?: string };
  private letterConflictTask?: string;
  private savedLetter?: { identity: string; widget: any };
  private savedLetterSources?: { identity: string; widget: any };
  private boot?: Boot;
  private preflight?: Preflight;
  private observation?: Observation;
  private observedAt = 0;
  private child?: any;
  private cancelChild?: () => void;
  private timer = 0;
  private busy = false;
  private reading = false;
  private revision = 0;
  private disposed = false;
  private feedback = "";
  private readCancel?: any;
  private readEpoch = 0;
  private readFeedback?: string;

  constructor(
    private readonly parent: any, private readonly gateway: Gateway, private readonly commands: RuntimeCommands,
    private readonly openTask: (id: string) => void,
  ) {
    this.attempt = new UpdateAttemptView(openTask);
  }

  show(): void {
    if (this.disposed) return;
    if (this.dialog) { this.dialog.present(this.parent); return; }
    const content = column();
    const dialog = sheet("Обновления шлюза", content);
    dialog.set_content_width(740);
    dialog.set_content_height(650);
    this.dialog = dialog;
    this.readCancel = new Gio.Cancellable();
    this.message = label(this.feedback);
    this.body = column();
    const tools = row();
    const refresh = this.action("Перечитать", () => void this.refresh());
    const check = this.action("Проверить обновления", () => void this.check());
    this.controls = [refresh, check];
    tools.append(refresh);
    tools.append(check);
    content.append(tools);
    content.append(this.message);
    content.append(this.body);
    dialog.connect("closed", () => {
      if (this.dialog !== dialog) return;
      this.readCancel?.cancel();
      this.revision++;
      this.readEpoch++;
      this.reading = false;
      this.observedAt = 0;
      this.preflight = undefined;
      this.dismissChild();
      clear(this.body);
      this.dialog = this.body = this.message = undefined;
      this.controls = [];
      this.stopTimer();
    });
    dialog.present(this.parent);
    this.observedAt = 0;
    void this.refresh();
    this.render();
    this.timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 4, () => {
      if (this.observation || this.status?.update_tx?.active || this.status?.update_progress?.active
        || this.letterSubmission || letterInProgress(this.status?.letter?.request)) void this.refresh();
      return GLib.SOURCE_CONTINUE;
    });
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopTimer();
    this.readCancel?.cancel();
    this.dismissChild();
    this.dialog?.force_close();
  }

  invalidate(): void {
    if (this.dialog) void this.refresh();
  }

  private action(title: string, work: () => void): any {
    const dialog = this.dialog;
    return button(title, () => { if (!this.disposed && this.dialog === dialog) work(); });
  }

  private validateStatus(status: Status): void {
    if (status !== object(status) || object(status).error || typeof status.update_tx?.active !== "boolean"
      || [status.warnings, status.dirty_preview].some(items => items !== undefined && (!Array.isArray(items) || items.some(item => typeof item !== "string")))
      || (status.official_tags !== undefined && (!Array.isArray(status.official_tags) || status.official_tags.some(item => !item)))) {
      throw new Error("Шлюз не подтвердил состояние обновления.");
    }
  }

  private stopTimer(): void {
    if (this.timer) GLib.Source.remove(this.timer);
    this.timer = 0;
  }

  private say(message: string): void {
    this.feedback = message;
    this.message?.set_label(message);
  }

  private async refresh(force = false): Promise<boolean> {
    if (this.disposed || !this.dialog || this.reading || this.busy && !force) return false;
    const revision = this.revision, dialog = this.dialog, epoch = ++this.readEpoch;
    this.reading = true;
    const [status, health] = await Promise.allSettled([
      this.gateway.json<Status>("GET", path + "status", undefined, undefined, false, this.readCancel).then(status => { this.validateStatus(status); return status; }),
      this.gateway.publicJson("/api/health", this.readCancel).then(readGatewayHealth),
    ]);
    if (epoch === this.readEpoch) this.reading = false;
    if (this.disposed || this.dialog !== dialog || revision !== this.revision || epoch !== this.readEpoch) return false;
    this.boot = health.status === "fulfilled" ? health.value.boot : undefined;
    if (this.boot?.since) this.commands.observeBoot(this.boot.since);
    if (status.status === "fulfilled") {
      if (this.feedback === this.readFeedback) this.say("");
      this.readFeedback = undefined;
      this.acceptStatus(status.value);
      this.observe();
    } else {
      this.preflight = undefined;
      this.observedAt = 0;
      this.readFeedback = this.observation ? `Результат операции ещё не подтверждён. ${errorText(status.reason)}` : errorText(status.reason);
      this.say(this.readFeedback);
    }
    this.render();
    return status.status === "fulfilled";
  }

  private acceptStatus(status: Status): void {
    this.validateStatus(status);
    const plan = this.preflight?.merge_plan;
    const old = this.status;
    const sourceChanged = old && (old.update_channel !== status.update_channel || old.target_ref !== status.target_ref
      || old.official_repo_url !== status.official_repo_url || old.current_branch !== status.current_branch);
    if (plan && (!canPrepareUpdate(status) || status.update_tx?.active || sourceChanged
      || status.current_sha && plan.base_sha !== status.current_sha)) this.preflight = undefined;
    if (this.releases && status.official_repo_url !== this.releases.source) this.releases = undefined;
    this.status = status;
    this.observedAt = GLib.get_monotonic_time();
    const pending = this.letterSubmission;
    const request = status.letter?.request;
    if (pending && request?.task_id && request.task_id !== pending.previous
      && (!pending.taskId || request.task_id === pending.taskId)
      && request.mode === pending.mode && sameRange(request.key, pending.range)) {
      this.letterSubmission = undefined;
      this.say(`На шлюзе найдена задача описания этого диапазона · ${request.task_id}`);
    }
    if (this.letterConflictTask && [request?.task_id, request?.current_task_id].includes(this.letterConflictTask)) {
      this.letterConflictTask = undefined;
    }
  }

  private observe(): void {
    const watching = this.observation;
    const status = this.status;
    if (!watching || !status || status.update_tx?.active) return;
    const newBoot = Boolean(this.boot?.since && watching.boot && this.boot.since !== watching.boot && this.boot.phase === "ready");
    if (watching.kind === "restore" && status.running_sha === watching.target
      && (newBoot || !watching.boot && this.boot?.phase === "ready" && watching.runningAtStart && watching.runningAtStart !== watching.target)) {
      this.say("Шлюз запустился с выбранным коммитом · " + watching.target);
      this.observation = undefined;
    } else if (watching.kind === "reset" && newBoot && watching.acknowledged) {
      this.say("Шлюз перезапустился после подтверждённого сброса.");
      this.observation = undefined;
    } else if (watching.kind === "apply") {
      const progress = status.update_progress;
      if (!progress?.operation_id || progress.operation_id === watching.originalOperation || !sameRange(progress, watching.range)) return;
      const after = status.after_update?.operation_id === progress.operation_id ? status.after_update.after : undefined;
      const landed = after?.source_sha ?? watching.target;
      if (progress.outcome === "applied" && progress.concluded_by === "boot" && this.boot?.phase === "ready"
        && (!watching.boot || newBoot)
        && typeof landed === "string" && landed === status.running_sha) {
        this.say("Запущенный шлюз подтвердил обновление · " + landed);
        this.observation = undefined;
      } else if (progress.outcome && ["not_applied", "rolled_back", "failed"].includes(progress.outcome)) {
        this.say([updateOutcomes[progress.outcome], progress.reason, progress.error].filter(Boolean).join(" · "));
        this.observation = undefined;
      }
    }
  }

  private render(): void {
    if (!this.body) return;
    this.controls.forEach((control, index) => control.set_sensitive(!this.busy && (index === 0 || !this.observation)));
    clear(this.body);
    const state = this.status;
    if (!state) return;
    const tx = state.update_tx;
    const progress = state.update_progress;
    const plan = this.preflight?.merge_plan;
    const blocked = this.busy || !this.observedAt || tx?.active !== false || Boolean(this.observation);
    if (!this.observedAt) this.body.append(label("Показано последнее прочитанное состояние. Перечитайте перед действием.", "dim-label"));
    this.body.append(updateStatusView(state));
    if (this.attempt.show(progress, tx, state.after_update)) this.body.append(this.attempt.widget);
    const previous = this.previousVersion();
    if (previous) {
      const restore = this.action("Восстановить версию до обновления…", () => void this.restore(previous, "Версия до обновления"));
      restore.set_sensitive(!blocked);
      this.body.append(restore);
    }
    const taskId = tx?.task_id;
    if (taskId) this.body.append(this.action("Открыть связанную задачу", () => this.openTask(taskId)));
    if (this.observation) this.body.append(label("Ожидается подтверждение результата от шлюза.", "dim-label"));
    const recovery = updateRecovery(tx);
    if (recovery?.message) this.body.append(label(recovery.message));
    if (this.canRestart()) {
      const restart = this.action("Перезапустить шлюз…", () => void this.restart());
      restart.set_sensitive(!this.busy);
      this.body.append(restart);
    }

    const analyze = this.action("Подготовить план…", () => void this.prepare());
    analyze.set_sensitive(!blocked && canPrepareUpdate(state));
    this.body.append(analyze);
    if (plan) this.renderPlan(plan, blocked);
    this.renderLetter(blocked);

    const lifecycle = row();
    for (const [title, activate] of [
      ["Восстановить версию…", () => void this.chooseRestore()],
      ["Продвинуть стабильную ветку…", () => void this.promote()],
      ["Сбросить данные шлюза…", () => this.resetDialog()],
    ] as const) {
      const action = this.action(title, activate);
      action.set_sensitive(!blocked);
      lifecycle.append(action);
    }
    this.body.append(lifecycle);
    this.body.append(officialReleases(this.releases?.items));
    if (this.observation && !this.busy && this.observedAt && tx?.active === false && !progress?.active) {
      this.body.append(this.action("Завершить наблюдение…", () => void this.stopWatching()));
    }
  }

  private renderPlan(plan: Plan, blocked: boolean): void {
    this.body.append(label("План обновления", "title-3"));
    facts(this.body, [["Исходный коммит", plan.base_sha], ["Цель", plan.target_sha],
      ["Состояние", plan.kind], ["Изменённые файлы", plan.local_dirty_count], ["Ошибка", plan.error],
      ["Конфликты кода", plan.code_conflict_paths?.join(", ")], ["Конфликты документов", plan.doc_conflict_paths?.join(", ")]]);
    this.body.append(new Gtk.Expander({ label: "Последствия для движка и среды",
      child: updateEffects(plan, this.preflight?.effects) }));
    this.body.append(updateEvidence(plan, this.preflight?.qualification));
    const controls = row();
    const strategy = plan.available === true && plan.kind === "clean" && plan.auto_mergeable === true ? "auto_merge"
      : plan.available === true && plan.kind === "conflicting" ? "assisted" : undefined;
    if (strategy) {
      const apply = this.action(strategy === "assisted" ? "Начать разрешение конфликтов…" : "Применить обновление…", () => void this.apply(strategy, plan));
      apply.set_sensitive(!blocked && pinned(plan) && Number.isInteger(plan.local_dirty_count) && plan.local_dirty_count! >= 0);
      controls.append(apply);
    }
    const manual = this.action("Получить ручной план", () => void this.apply("manual", plan));
    manual.set_sensitive(!blocked);
    controls.append(manual);
    const replace = this.action("Заменить официальной версией…", () => void this.apply("replace", plan));
    replace.set_sensitive(!blocked && pinned(plan));
    controls.append(replace);
    this.body.append(controls);
  }

  private renderLetter(blocked: boolean): void {
    const letter = this.status?.letter;
    const action = this.descriptionAction();
    if (letter?.text) {
      const identity = JSON.stringify([letter.key, letter.text, letter.relation, letter.author_version, letter.target_version,
        letter.written_at, letter.author]);
      if (this.savedLetter?.identity !== identity) this.savedLetter = { identity, widget: letterContent(letter, this.openTask, this.gateway.base) };
      this.body.append(this.savedLetter.widget);
      if (action?.mode === "write") this.body.append(label("Сохранённое описание относится к другому диапазону.", "dim-label"));
    }
    if (letter) {
      const failed = letterFailure(letter, action?.range ?? letter.key);
      if (failed) this.body.append(failed);
      if (letter.material || letter.qualification || letter.revision !== undefined) {
        const identity = JSON.stringify([letter.checked_key, letter.material, letter.qualification, letter.revision]);
        if (this.savedLetterSources?.identity !== identity) this.savedLetterSources = { identity, widget: letterSources(letter) };
        this.body.append(this.savedLetterSources.widget);
      }
    }
    if (letter?.request) this.body.append(letterRequestView(letter.request, this.openTask));
    const task = this.letterSubmission?.taskId || this.letterConflictTask;
    if (task) this.body.append(this.action("Открыть задачу из ответа шлюза", () => this.openTask(task)));
    if (this.letterSubmission) {
      this.body.append(label("Клиент сверяет запрос описания с журналом шлюза.", "dim-label"));
      const retry = this.action("Разрешить новый запрос описания…", () => void this.clearLetterSubmission());
      retry.set_sensitive(!blocked);
      this.body.append(retry);
    }
    if (!action) return;
    for (const [index, choice] of this.descriptionActions().entries()) {
      const caption = index ? "Переписать сохранённое описание…"
        : choice.mode === "write" ? "Запросить описание обновления…" : "Переписать описание…";
      const write = this.action(caption, () => void this.description(choice.mode, choice.range));
      write.set_tooltip_text(`${choice.range.base_sha} → ${choice.range.target_sha}`);
      write.set_sensitive(!blocked && !this.letterSubmission && !letterInProgress(letter?.request));
      this.body.append(write);
    }
  }

  private descriptionAction(): ReturnType<typeof letterAction> {
    const state = this.status;
    const letter = state?.letter;
    if (!letter) return undefined;
    const shown = { base_sha: state.running_sha || state.current_sha, target_sha: state.checked_target_sha || state.latest_sha };
    const offered = state.available === true && sameRange(letter.checked_key, shown);
    return letterAction(offered ? letter : { ...letter, checked_key: undefined });
  }

  private descriptionActions(): DescriptionAction[] {
    const primary = this.descriptionAction();
    const choices = primary ? [primary] : [];
    const letter = this.status?.letter;
    if (letter?.text && pinned(letter.key) && !choices.some(choice => sameRange(choice.range, letter.key))) {
      choices.push({ mode: "rewrite", range: letter.key });
    }
    return choices;
  }

  private async run(operation: () => Promise<void>): Promise<void> {
    if (this.disposed || this.busy || !this.dialog) return;
    const dialog = this.dialog;
    this.revision++;
    this.busy = true;
    this.render();
    try {
      await operation();
    } catch (error) {
      if (!this.disposed) this.say(errorText(error));
    } finally {
      this.busy = false;
      if (!this.disposed) {
        this.render();
        if (this.dialog && this.dialog !== dialog) void this.refresh();
      }
    }
  }

  private async check(): Promise<void> {
    if (this.observation) return;
    const dialog = this.dialog;
    await this.run(async () => {
      this.say("Проверяю официальный канал…");
      this.preflight = undefined;
      this.observedAt = 0;
      const status = await this.gateway.json<Status>("POST", path + "check", {}, undefined, true, this.readCancel);
      if (this.disposed || this.dialog !== dialog) return;
      this.acceptStatus(status);
      if (status.check_ok === true || status.official_tags?.length) {
        this.releases = { source: status.official_repo_url, items: status.official_tags ?? [] };
      }
      this.observe();
      this.say("");
    });
  }

  private async prepare(): Promise<void> {
    if (!this.ready() || !canPrepareUpdate(this.status)) return;
    const dialog = this.dialog;
    await this.run(async () => {
      this.preflight = undefined;
      this.say("Проверяю слияние и последствия для шлюза…");
      const preflight = await this.gateway.json<Preflight>("POST", path + "preflight", {}, undefined, true, this.readCancel);
      if (this.disposed || this.dialog !== dialog) return;
      if (!preflight?.merge_plan || preflight.merge_plan !== object(preflight.merge_plan)
        || [preflight.merge_plan.code_conflict_paths, preflight.merge_plan.doc_conflict_paths].some(items => items !== undefined && (!Array.isArray(items) || items.some(item => typeof item !== "string")))) {
        throw new Error("Шлюз не вернул план.");
      }
      this.preflight = preflight;
      this.say(pinned(preflight.merge_plan) ? "Получен план для точного диапазона." : "Шлюз не подтвердил исходный и целевой коммиты.");
    });
  }

  private ready(): boolean {
    return !this.disposed && Boolean(this.dialog) && !this.busy && !this.observation && this.observedAt > 0 && this.status?.update_tx?.active === false;
  }

  private async clearLetterSubmission(): Promise<void> {
    const dialog = this.dialog;
    const pending = this.letterSubmission;
    if (!pending || !this.ready()) return;
    await this.run(async () => {
      if (!await confirm(this.dialog, "Разрешить новый запрос описания?",
        "Предыдущий запрос мог создать задачу. Новый запрос может запустить ещё одну задачу с расходами модели.", "Разрешить")) return;
      if (this.disposed || this.dialog !== dialog) return;
      if (!await this.refresh(true) || this.letterSubmission !== pending) return;
      if (letterInProgress(this.status?.letter?.request)) {
        this.say("Шлюз уже выполняет задачу описания.");
        return;
      }
      this.letterSubmission = undefined;
      this.letterConflictTask = pending.taskId;
      this.say("Можно явно отправить новый запрос описания.");
    });
  }

  private async description(mode: LetterMode, range: Required<Range>): Promise<void> {
    const dialog = this.dialog;
    if (!this.ready() || this.letterSubmission || letterInProgress(this.status?.letter?.request)) return;
    await this.run(async () => {
      if (!await confirm(this.dialog, "Запустить задачу описания?",
        `${range.base_sha} → ${range.target_sha}\n\nOuroboros прочитает изменения обычной задачей Main. Возможны расходы модели.`, "Запустить")) return;
      if (this.disposed || this.dialog !== dialog) return;
      if (!await this.refresh(true)) return;
      const current = this.descriptionActions().find(choice => choice.mode === mode && sameRange(choice.range, range));
      const prior = this.status?.letter?.request;
      if (this.status?.update_tx?.active !== false || !current || letterInProgress(prior)) {
        this.say("Предлагаемый диапазон или состояние задачи изменились. Проверьте текущий запрос.");
        return;
      }
      const pending: NonNullable<Updates["letterSubmission"]> = { mode, range, previous: prior?.task_id };
      this.letterSubmission = pending;
      this.letterConflictTask = undefined;
      try {
        const reply = await this.gateway.json<{ status?: string; task_id?: string; key?: Range }>("POST", path + "description", {
          mode, base_sha: range.base_sha, target_sha: range.target_sha,
        });
        if (reply.status === "queued" && reply.task_id && sameRange(reply.key, range)) {
          pending.taskId = reply.task_id;
          this.say("Задача описания поставлена в очередь · " + reply.task_id);
        }
        else this.say("Шлюз не подтвердил постановку задачи описания.");
      } catch (error) {
        const details = error instanceof HttpError ? object(error.body) : {};
        if (error instanceof HttpError && error.status < 500 && error.status !== 408) {
          this.letterSubmission = undefined;
          if (error.status === 409 && typeof details.task_id === "string") this.letterConflictTask = details.task_id;
          this.say(errorText(error));
        } else this.say(`Итог запроса описания неизвестен. ${errorText(error)}`);
      }
      await this.refresh(true);
    });
  }

  private async apply(strategy: Strategy, plan: Plan): Promise<void> {
    const dialog = this.dialog;
    if (!this.ready() || plan !== this.preflight?.merge_plan || strategy !== "manual" && !pinned(plan)) return;
    await this.run(async () => {
      if (strategy === "manual") {
        const reply = await this.gateway.json<{ status?: string; merge_plan?: Plan }>("POST", path + "apply", { strategy });
        if (this.disposed || this.dialog !== dialog) return;
        if (reply.status !== "manual" || !reply.merge_plan) throw new Error("Шлюз не вернул ручной план.");
        const before = this.preflight;
        this.preflight = sameRange(plan, reply.merge_plan)
          ? { ...before, merge_plan: reply.merge_plan } : { merge_plan: reply.merge_plan };
        this.say("Получен ручной план. Обновление не применялось.");
        return;
      }
      const title = strategy === "replace" ? "Заменить рабочую копию?" : strategy === "assisted" ? "Запустить разрешение конфликтов?" : "Применить обновление?";
      const description = strategy === "replace"
        ? "Шлюз переключит рабочую копию на официальный коммит и сохранит текущую работу для восстановления."
        : strategy === "assisted" ? "Шлюз запустит задачу с ревью для разрешения конфликтов. Возможны расходы модели."
          : "Шлюз применит план слияния, сохранив рабочие изменения, и запросит перезапуск.";
      if (!await this.confirmUpdate(title, description, plan, strategy)) return;
      if (this.disposed || plan !== this.preflight?.merge_plan || this.status?.update_tx?.active !== false) return;
      const watch: Observation = {
        kind: "apply", boot: this.boot?.since, originalOperation: this.status.update_progress?.operation_id,
        range: plan, target: strategy === "replace" ? plan.target_sha : plan.merge_commit,
      };
      this.observation = watch;
      this.preflight = undefined;
      this.say("Шлюз выполняет запрос…");
      try {
        const reply = await this.gateway.json<{ status?: string; restarting?: boolean; task_id?: string; error?: string; merge_plan?: Plan }>(
          "POST", path + "apply", {
            strategy, expected_base_sha: plan.base_sha, expected_target_sha: plan.target_sha,
            confirm_recovery: strategy === "replace" ? true : undefined,
          },
        );
        if (reply.merge_plan?.merge_commit && sameRange(reply.merge_plan, plan)) watch.target = reply.merge_plan.merge_commit;
        if (reply.status === "assisted_started") this.say("Запущена задача разрешения конфликтов" + (reply.task_id ? " · " + reply.task_id : "."));
        else if (reply.status === "restart_required") {
          watch.needsRestart = true;
          this.say(["Для завершения нужен перезапуск.", reply.error].filter(Boolean).join(" "));
        } else if (reply.status === "ok" && reply.restarting) this.say("Перезапуск запрошен. Жду подтверждения запущенной версии.");
        else this.say("Результат применения ещё не подтверждён.");
      } catch (error) {
        this.mutationError(error, watch);
      }
      await this.refresh(true);
    });
  }

  private confirmUpdate(title: string, description: string, plan: Plan, strategy: Exclude<Strategy, "manual">): Promise<boolean> {
    const content = column();
    const dialog = sheet(title, content);
    dialog.set_content_width(700);
    content.append(label(description));
    facts(content, [["Исходный коммит", plan.base_sha], ["Цель", plan.target_sha]]);
    content.append(label("Последствия для движка и среды", "title-3"));
    content.append(updateEffects(plan, this.preflight?.effects, strategy === "replace" ? "replace" : "merge"));
    const letter = this.preflight?.letter;
    if (letter?.text && sameRange(letter.key, plan)) {
      content.append(letterContent(letter, this.openTask, this.gateway.base));
    }
    content.append(updateEvidence(plan, this.preflight?.qualification));
    const actions = row();
    actions.set_halign(Gtk.Align.END);
    actions.set_margin_top(6);
    actions.set_margin_bottom(6);
    actions.set_margin_end(12);
    dialog.get_child().add_bottom_bar(actions);
    return new Promise((resolve) => {
      let approved = false, closing = false;
      const cancel = this.action("Отмена", () => { if (!closing) { closing = true; dialog.close(); } });
      const proceed = this.action("Подтвердить", () => { if (!closing) { closing = true; approved = true; dialog.close(); } });
      proceed.add_css_class("destructive-action");
      actions.append(cancel);
      actions.append(proceed);
      dialog.set_focus(cancel);
      dialog.connect("closed", () => resolve(approved));
      this.presentChild(dialog, () => resolve(false));
    });
  }

  private mutationError(error: unknown, watch: Observation): void {
    const details = error instanceof HttpError ? object(error.body) : {};
    const reason = details.reason || details.reason_code;
    const known = details.outcome === "not_applied" || details.outcome === "rolled_back"
      || ["release_moved", "index_lock_present", "replace_not_applied", "restore_not_applied"].includes(String(reason))
      || details.abandoned === true;
    watch.needsRestart = details.restart_required === true;
    if (known && !watch.needsRestart) this.observation = undefined;
    this.say([
      known ? errorText(error) : `Результат операции неизвестен. ${errorText(error)}`,
      reason, details.index_lock && `Блокировка Git · ${JSON.stringify(details.index_lock)}`,
      details.keep_branch && `Сохранённая ветка · ${details.keep_branch}`, details.stash_note,
      details.rescue && `Снимок восстановления · ${JSON.stringify(details.rescue)}`,
    ].filter(Boolean).join("\n"));
  }

  private async chooseRestore(): Promise<void> {
    if (!this.ready() || this.child) return;
    const dialog = this.dialog;
    await this.run(async () => {
      let data: GitVersions = {};
      let readError: string | undefined;
      try { data = await this.gateway.json<GitVersions>("GET", "/api/git/log", undefined, undefined, false, this.readCancel); }
      catch (error) { readError = errorText(error); }
      if (this.disposed || this.dialog !== dialog) return;
      const selection = restoreVersions(data, this.previousVersion(), (sha, title) => { if (!this.disposed && this.dialog === dialog) void this.restore(sha, title); }, readError);
      this.presentChild(selection);
    });
  }

  private previousVersion(): string | undefined {
    const progress = this.status?.update_progress;
    return progress?.outcome === "applied" && !progress.active ? commitSha(progress.base_sha) : undefined;
  }

  private dismissChild(): void {
    const child = this.child, cancel = this.cancelChild;
    this.child = undefined;
    this.cancelChild = undefined;
    cancel?.();
    if (child?.get_mapped()) child.force_close();
  }

  private presentChild(dialog: any, cancel?: () => void): void {
    const parent = this.dialog;
    if (!parent || this.disposed) return;
    this.child = dialog;
    this.cancelChild = cancel;
    dialog.connect("closed", () => { if (this.child === dialog) { this.child = undefined; this.cancelChild = undefined; } });
    dialog.present(parent);
  }

  private async restore(target: string, title?: string): Promise<void> {
    const dialog = this.dialog;
    if (!this.ready()) return;
    await this.run(async () => {
      const selection = [title, `Коммит ${target}`].filter(Boolean).join("\n");
      if (!await confirm(this.dialog, "Восстановить версию?",
        `${selection}\n\nШлюз прервёт текущую работу, сохранит изменения для восстановления и запросит перезапуск. Данные Claudexor сохранят текущий формат.`, "Восстановить")) return;
      if (this.disposed || this.dialog !== dialog) return;
      if (!await this.refresh(true) || this.dialog !== dialog || this.status?.update_tx?.active !== false) {
        if (!this.disposed) this.say("Шлюз не подтвердил готовность к восстановлению. Перечитайте состояние и повторите выбор.");
        return;
      }
      const watch: Observation = { kind: "restore", boot: this.boot?.since, target, runningAtStart: this.status.running_sha };
      this.observation = watch;
      try {
        const reply = await this.gateway.json<{ status?: string; message?: string; restarting?: boolean; switch_deferred?: boolean }>(
          "POST", "/api/git/rollback", { target },
        );
        watch.needsRestart = reply.status === "restart_required";
        const recorded = reply.status === "ok" || watch.needsRestart;
        const stage = recorded && reply.switch_deferred === true ? "Переключение на выбранный коммит записано для перезапуска."
          : recorded && reply.switch_deferred === false ? "Шлюз переключил рабочую копию." : "";
        this.say([stage, watch.needsRestart ? "Для завершения нужен перезапуск." : reply.restarting
          ? "Перезапуск запрошен. Жду выбранный запущенный коммит." : "Результат восстановления ещё не подтверждён.", reply.message].filter(Boolean).join(" "));
      } catch (error) { this.mutationError(error, watch); }
      await this.refresh(true);
    });
  }

  private async promote(): Promise<void> {
    const dialog = this.dialog;
    if (!this.ready()) return;
    await this.run(async () => {
      if (!await confirm(this.dialog, "Продвинуть стабильную ветку?",
        "Шлюз передвинет локальную стабильную ветку на текущий коммит.", "Продвинуть")) return;
      if (this.disposed || this.dialog !== dialog || this.status?.update_tx?.active !== false) return;
      try {
        const reply = await this.gateway.json<{ status?: string; sha?: string; message?: string }>("POST", "/api/git/promote", {});
        this.say(reply.status === "ok" && reply.sha ? `Стабильная ветка обновлена · ${reply.sha}` : "Шлюз не подтвердил продвижение.");
      } catch (error) {
        this.say("Продвижение не подтверждено. " + errorText(error));
      }
      await this.refresh(true);
    });
  }

  private resetDialog(): void {
    if (!this.ready() || this.child) return;
    const content = column();
    const dialog = sheet("Сбросить данные шлюза", content);
    const input = new Gtk.Entry({ placeholder_text: "Введите СБРОС" });
    content.append(label("Шлюз удалит настройки, состояние, память, журналы, архивы, результаты задач и загрузки. Операция необратима."));
    content.append(input);
    let closing = false;
    const reset = this.action("Удалить данные и перезапустить", () => {
      if (closing || this.child !== dialog || input.get_text() !== "СБРОС") return;
      closing = true;
      dialog.close();
      void this.reset();
    });
    reset.add_css_class("destructive-action");
    reset.set_sensitive(false);
    input.connect("changed", () => reset.set_sensitive(input.get_text() === "СБРОС"));
    content.append(reset);
    this.presentChild(dialog);
  }

  private async reset(): Promise<void> {
    if (!this.ready()) return;
    await this.run(async () => {
      const watch: Observation = { kind: "reset", boot: this.boot?.since };
      this.observation = watch;
      try {
        const reply = await this.gateway.json<{ status?: string; deleted?: string[]; restarting?: boolean }>("POST", "/api/reset", {});
        watch.acknowledged = reply.status === "ok";
        this.say(watch.acknowledged ? ["Шлюз подтвердил сброс.", reply.deleted?.join(", "), reply.restarting ? "Перезапуск запрошен." : ""].filter(Boolean).join(" ")
          : "Шлюз не подтвердил сброс.");
      } catch (error) {
        this.say("Результат сброса неизвестен. " + errorText(error));
      }
      await this.refresh(true);
    });
  }

  private async restart(): Promise<void> {
    const dialog = this.dialog;
    if (!this.canRestart()) return;
    await this.run(async () => {
      const result = await this.commands.send("/restart", async () => {
        if (this.dialog !== dialog || this.disposed) return false;
        if (await this.refresh(true) && this.canRestart()) return true;
        this.say("Шлюз больше не подтверждает возможность перезапуска из этого окна.");
        return false;
      });
      if (result.message) this.say(result.message);
      await this.refresh(true);
    });
  }

  private canRestart(): boolean {
    if (this.disposed || !this.dialog || !this.observedAt || !this.status?.update_tx) return false;
    const recovery = updateRecovery(this.status.update_tx);
    if (recovery) return recovery.restart;
    const watch = this.observation;
    const sameBoot = !watch?.boot || !this.boot?.since || watch.boot === this.boot.since;
    const progress = this.status.update_progress;
    return Boolean(watch?.needsRestart && sameBoot || progress?.restart_required && progress.current_generation !== false);
  }

  private async stopWatching(): Promise<void> {
    const dialog = this.dialog;
    if (this.busy || !this.observation || !this.observedAt || this.status?.update_tx?.active !== false
      || this.status?.update_progress?.active) return;
    if (await confirm(this.dialog, "Завершить наблюдение?",
      "Шлюз не показывает активную операцию. Это действие только закрывает ожидание в клиенте.", "Завершить")) {
      if (this.disposed || this.dialog !== dialog) return;
      this.observation = undefined;
      this.say("Наблюдение завершено пользователем.");
      this.render();
    }
  }
}
