import { readSkillMutationReceipt, SkillMutationReceiptView, type SkillMutationReceipt } from "./skill-mutation-receipt.js";
import { SkillActionRefusalView } from "./skill-action-refusal.js";
import { SkillLifecycleQueueView, lifecycleJobs, readSkillLifecycleQueue, skillJobSettled, type SkillLifecycleJob as LifecycleJob } from "./skill-lifecycle-view.js";
import { commandAccepted, commandRefused } from "./command-receipt.js";
import { showExtensionSettings } from "./extension-settings.js";
import { bindChrome } from "./native-i18n.js";
import { Adw, Gio, GLib, Gtk, Pango } from "./gi.js";
import { type Gateway, HttpError } from "./gateway.js";
import { skillPublicationReceipt } from "./publication-result.js";
import { SkillCatalog } from "./skill-catalog.js";
import { SkillRegistry } from "./skill-registry.js";
import { showSkillProcesses } from "./skill-processes.js";
import { SkillPublication } from "./skill-publication.js";
import { SkillSources } from "./skill-sources.js";
import { object, ownerHeaders } from "./settings-write.js";
import { button, clear, column, confirm, errorText, label, row, sheet } from "./ui.js";

interface Release {
  version: string;
  digest: string;
  reason?: string;
  repo?: string;
}

interface Review {
  record_id?: string;
  job_id?: string;
  content_hash?: string;
  status?: string;
  job_status?: string;
  finished_at?: string;
  continuable_seats?: { seat_id: string; operation_id: string; cause?: string; run_id?: string }[];
}

interface SkillHealth {
  version?: string;
  sha?: string;
  ts?: string;
  status?: string;
  reason?: string;
  load_error?: string;
  server_reconcile?: string;
}

interface Skill {
  name: string;
  type: string;
  version: string;
  description: string;
  enabled: boolean;
  permissions: string[];
  conflicts: string[];
  source: string;
  payload_root: string;
  content_hash: string;
  identity_collision?: boolean;
  load_error?: string | null;
  removal?: string;
  review_status?: string;
  review_stale?: boolean;
  review_gate?: Record<string, unknown>;
  owner_attestable?: boolean;
  live_loaded?: boolean;
  live_reason?: string;
  process?: string;
  server_reconcile?: string;
  health_regressed?: boolean;
  last_known_good?: SkillHealth | null;
  health_observations?: { server?: SkillHealth; worker?: SkillHealth };
  skill_review?: { current?: Review; history?: Review[]; history_omitted?: number };
  review_findings?: Record<string, unknown>[];
  grants?: { requested_keys?: string[]; missing_keys?: string[]; missing_permissions?: string[]; granted_keys?: string[]; granted_permissions?: string[] };
  published?: Record<string, unknown> | null;
  published_malformed?: boolean;
  install?: {
    source?: { id?: string; name?: string; kind?: string };
    release?: Release;
    official?: boolean;
    base_known?: boolean;
    modified?: boolean | null;
    left_source?: boolean;
    withdrawn?: { version?: string; reason?: string };
    update_available?: Release | null;
    pending_update?: Release;
    update_rejected?: Release;
  };
}

interface ActionReply {
  ok?: boolean;
  name?: string;
  pending?: boolean;
  job_id?: string;
  status?: string;
  error?: string;
  message?: string;
  setup_error?: string;
  load_error?: string;
  extension_load_error?: string;
  extension_action?: string;
  extension_reason?: string;
  base_available?: boolean;
  publication_cleared?: boolean;
}

type UpdateMode = "replace" | "keep" | "merge";

interface UpdateReply {
  ok: boolean;
  name?: string;
  mode?: UpdateMode;
  job_id?: string;
  skipped?: Release;
  candidate?: Release;
  base_available?: boolean;
  task?: string;
  error?: string;
  code?: string;
}

const jobLabels: Record<string, string> = {
  queued: "В очереди", running: "Выполняется", succeeded: "Завершено", failed: "Ошибка", cancelled: "Отменено",
};
const reviews: Record<string, string> = {
  clean: "Замечаний нет", warnings: "Есть замечания", blockers: "Найдены блокирующие проблемы", pending: "Проверка ожидается",
};
const skillsPath = "/api/skills";
const extensionsPath = "/api/extensions";

function itemPath(base: string, name: string, action: string): string {
  return `${base}/${encodeURIComponent(name)}/${action}`;
}

function text(target: any, value: string): void {
  const widget = label(value);
  widget.set_selectable(true);
  target.append(widget);
}

function labelInto(target: any, value: string): any {
  const widget = label(value);target.append(widget);return widget;
}

function evidence(target: any, title: string, value: unknown): void {
  if (value == null || (typeof value === "object" && !Object.keys(value).length)) return;
  const content = column();
  text(content, typeof value === "string" ? value : JSON.stringify(value, null, 2));
  target.append(new Gtk.Expander({ label: title, child: content }));
}

function skillHealth(target: any, skill: Skill): void {
  const content = column(4);
  const states: Record<string, string> = { live: "Работает", broken: "Ошибка", inactive: "Неактивен", unknown: "Неизвестно" };
  if (skill.health_regressed) text(content, "Сервер зафиксировал сбой после изменения содержимого навыка.");
  const good = skill.last_known_good;
  if (good) text(content, ["Последняя рабочая версия", good.version, good.sha, good.ts].filter(Boolean).join(" · "));
  for (const [caption, observed] of [["Сервер", skill.health_observations?.server],
    ["Рабочий процесс", skill.health_observations?.worker]] as const) {
    if (!observed) continue;
    text(content, [caption, observed.status && (states[observed.status] ?? observed.status), observed.version,
      observed.sha, observed.ts, observed.server_reconcile].filter(Boolean).join(" · "));
    const exhausted = "companion_restart_exhausted:";
    if (observed.reason?.startsWith(exhausted)) text(content, `Исчерпан лимит перезапусков · ${observed.reason.slice(exhausted.length)}`);
    else if (observed.reason) text(content, observed.reason);
    if (observed.load_error) text(content, observed.load_error);
  }
  if (content.get_first_child()) target.append(new Gtk.Expander({ label: "Состояние навыка по данным шлюза", child: content }));
}

function jobText(job: LifecycleJob): string {
  return [(Object.hasOwn(jobLabels, job.status) ? jobLabels[job.status] : job.status), job.message, job.error, job.stale_reason, job.recovery_hint, job.id]
    .filter(Boolean).join(" · ");
}

export class Skills {
  private dialog?: any;
  private detail?: { dialog: any; body: any; skill: Skill; feedback: any; refusal: SkillActionRefusalView; mutation: SkillMutationReceiptView };
  private updateDialog?: { dialog: any; name: string; feedback: any };
  private readonly children = new Set<any>();
  private readonly pending = new Map<string, { id: string; misses: number; kind?: string }>();
  private readonly writing = new Set<string>();
  private readonly feedback = new Map<string, string>();
  private readonly mutationReceipts = new Map<string, SkillMutationReceipt>();
  private readonly refusals = new Map<string, { body: unknown; status: number; path: string }>();
  private readonly status = label("", "dim-label");
  private readonly queue = column(4);
  private readonly list = column(4);
  private readonly search = new Gtk.SearchEntry({ placeholder_text: "Поиск по установленным навыкам" });
  private installed: Skill[] = [];
  private requestedDetail?: { name: string; dialog: any };
  private jobs: LifecycleJob[] = [];
  private queueView?: SkillLifecycleQueueView;
  private queueCancel?: any;
  private polling = false;
  private generation = 0;
  private poll = 0;
  private readonly catalog: SkillCatalog;
  private readonly sources: SkillSources;
  private readonly registry: SkillRegistry;

  constructor(private readonly parent: any, private readonly gateway: Gateway, private readonly openTask?: (id: string) => void,
    private readonly openCallSettings?: (parent: any) => void) {
    this.search.connect("search-changed", () => this.renderList());
    const present = (dialog: any, parent?: any) => this.present(dialog, parent);
    const changed = () => {
      this.catalog.invalidate();
      void this.refresh();
    };
    this.catalog = new SkillCatalog(gateway, present, (name) => this.openInstalled(name),
      (name) => this.blocked(name), (name, id) => this.track(name, id));
    this.sources = new SkillSources(gateway, present, changed);
    this.registry = new SkillRegistry(gateway, present, changed);
  }

  browse(search: string): void {
    this.show();
    this.catalog.show(search);
  }

  show(): void {
    if (this.dialog) {
      this.dialog.present(this.parent);
      return;
    }
    const content = column();
    const dialog = sheet("Навыки Ouroboros", content);
    dialog.set_content_width(710);
    dialog.set_content_height(640);
    const tools = new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.NONE, column_spacing: 6, row_spacing: 6 });
    tools.append(button("Обновить", () => void this.refresh()));
    tools.append(button("Каталог…", () => this.catalog.show()));
    tools.append(button("Источники…", () => this.sources.show()));
    tools.append(button("ClawHub…", () => this.registry.show()));
    tools.append(button("Процессы навыков…", () =>
      showSkillProcesses(this.gateway, (processes) => this.present(processes, dialog), undefined, dialog)));
    this.status.set_label("Читаю навыки…");
    for (const widget of [tools, this.status, this.queue, this.search, this.list]) content.append(widget);
    this.dialog = dialog;
    this.queueCancel = new Gio.Cancellable();
    clear(this.queue);this.queueView = new SkillLifecycleQueueView(this.openTask);this.queue.append(this.queueView.widget);
    dialog.connect("closed", () => {
      if (this.poll) GLib.Source.remove(this.poll);
      this.poll = 0;
      this.queueCancel?.cancel();this.queueCancel = undefined;
      this.queueView?.close();this.queueView = undefined;
      this.generation++;
      this.dialog = undefined;
      this.detail = undefined;
      this.requestedDetail = undefined;
      for (const widget of [this.status, this.queue, this.search, this.list]) content.remove(widget);
    });
    dialog.present(this.parent);
    this.poll = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
      void this.refreshQueue();
      return GLib.SOURCE_CONTINUE;
    });
    void this.refresh();
  }

  close(): void {
    this.queueCancel?.cancel();
    this.queueView?.close();
    for (const child of [...this.children].reverse()) child.force_close();
    this.dialog?.force_close();
  }

  private async refresh(): Promise<void> {
    if (!this.dialog) return;
    const generation = ++this.generation;
    const current = () => this.dialog && generation === this.generation;
    void this.refreshQueue();
    try {
      const result = await this.gateway.json<{ skills: Skill[] }>("GET", extensionsPath);
      if (!current()) return;
      if (!Array.isArray(result?.skills)) throw new Error("Шлюз не вернул список установленных навыков.");
      this.installed = result.skills;
      this.status.set_label(this.installed.length ? `Установлено · ${this.installed.length}` : "Установленных навыков нет.");
      this.renderList();
      if (this.detail) {
        const old = this.detail.skill;
        const latest = result.skills.find((skill) => skill.name === old.name && skill.payload_root === old.payload_root);
        if (latest) this.renderDetail(latest);
        else {
          this.detail.skill = { ...old, content_hash: "" };
          clear(this.detail.body);
          text(this.detail.body, "Этой копии навыка больше нет в списке установленных.");
        }
      }
      const requested = this.requestedDetail;
      if (requested && requested.dialog === this.dialog) {
        this.requestedDetail = undefined;
        const match = this.installed.find((item) => item.name === requested.name);
        if (match) this.open(match);
        else this.status.set_label(`Навык «${requested.name}» отсутствует в текущем списке установленных.`);
      }
    } catch (error) {
      if (current()) {
        this.requestedDetail = undefined;
        this.status.set_label(errorText(error));
      }
    }
  }

  private async refreshQueue(): Promise<void> {
    if (this.polling || !this.dialog) return;
    const dialog = this.dialog;
    this.polling = true;
    try {
      const result = readSkillLifecycleQueue(await this.gateway.json<unknown>("GET", `${skillsPath}/lifecycle-queue`, undefined, undefined, false, this.queueCancel));
      if (this.dialog !== dialog) return;
      const previous = new Map(this.jobs.map((job) => [job.id, job.status]));
      this.jobs = lifecycleJobs(result);
      const jobs = new Map(this.jobs.map(job => [job.id, job]));
      this.queueView?.update(result);
      let settled = this.jobs.some(job => skillJobSettled(job.status)
        && (!previous.has(job.id) || !skillJobSettled(previous.get(job.id)!)));
      for (const [name, pending] of this.pending) {
        const job = jobs.get(pending.id);
        if (job && (job.target !== name || pending.kind !== undefined && job.kind !== pending.kind)) {
          this.pending.delete(name);this.mutationReceipts.delete(name);
          if (this.detail?.skill.name === name) this.detail.mutation.update();
          this.message(name, job.target !== name ? `Итог операции неизвестен · ${pending.id} относится к другому навыку`
            : `Итог операции неизвестен · ${pending.id} относится к другому действию`);
          settled = true;
          continue;
        }
        if (job && !skillJobSettled(job.status)) {
          pending.misses = 0;
          this.message(name, jobText(job));
          continue;
        }
        if (!job && ++pending.misses < 3) continue;
        this.pending.delete(name);
        this.message(name, job ? jobText(job)
          : `Итог операции неизвестен · ${pending.id} отсутствует в последних записях очереди`);
        settled = true;
      }
      if (settled) {
        this.catalog.invalidate();
        void this.refresh();
      }
    } catch (error) {
      if (this.dialog === dialog) {
        this.queueView?.unavailable(errorText(error));
      }
    } finally {
      this.polling = false;
    }
  }

  private renderList(): void {
    if (!this.dialog) return;
    const query = this.search.get_text().trim().toLocaleLowerCase();
    clear(this.list);
    for (const skill of this.installed) {
      if (query && ![skill.name, skill.description, skill.source].join(" ").toLocaleLowerCase().includes(query)) continue;
      const open = button(skill.name, () => this.open(skill));
      open.set_halign(Gtk.Align.START);
      this.list.append(open);
      this.list.append(label([
        skill.version, skill.install?.source?.name || skill.source, skill.enabled ? "Включён" : "Выключен",
        skill.identity_collision ? "Конфликт имён" : skill.live_reason, skill.install?.update_available && "Есть обновление",
      ].filter(Boolean).join(" · "), "dim-label"));
      const feedback = this.feedback.get(skill.name);
      if (feedback) this.list.append(label(feedback, "dim-label"));
    }
  }

  private present(dialog: any, parent = this.dialog): void {
    this.children.add(dialog);
    let open = true;
    const signal = parent instanceof Adw.Dialog ? parent.connect("closed", () => dialog.force_close()) : 0;
    dialog.connect("closed", () => {
      if (!open) return;
      open = false;
      this.children.delete(dialog);
      if (signal) parent.disconnect(signal);
    });
    dialog.present(parent);
  }

  private open(skill: Skill): void {
    this.requestedDetail = undefined;
    if (this.detail) return;
    const content = column();
    const dialog = sheet(skill.name, content);
    const feedback = label(this.feedback.get(skill.name) ?? "", "dim-label");
    const body = column();
    const refusal = new SkillActionRefusalView(skill.name);
    const mutation = new SkillMutationReceiptView();
    mutation.update(this.mutationReceipts.get(skill.name));
    content.append(mutation.widget);
    const cached = this.refusals.get(skill.name);
    refusal.update(cached?.body, cached?.status, cached?.path);
    content.append(refusal.widget);
    content.append(feedback);
    content.append(body);
    this.detail = { dialog, body, feedback, skill, refusal, mutation };
    dialog.connect("closed", () => { refusal.close();mutation.close();if (this.detail?.dialog === dialog) this.detail = undefined; });
    this.renderDetail(skill);
    this.present(dialog);
  }

  private openInstalled(name: string): void {
    if (!this.dialog) return;
    this.detail?.dialog.force_close();
    this.requestedDetail = { name, dialog: this.dialog };
    this.status.set_label(`Читаю установленный навык «${name}»…`);
    void this.refresh();
  }

  private renderDetail(skill: Skill): void {
    if (!this.detail) return;
    this.detail.skill = skill;
    const { body, dialog } = this.detail;
    clear(body);
    text(body, [skill.version, skill.type, skill.source, skill.payload_root, skill.content_hash].filter(Boolean).join(" · "));
    if (skill.description) text(body, skill.description);
    text(body, [skill.enabled ? "Включён" : "Выключен", skill.live_loaded ? "Загружен" : "", skill.live_reason, skill.process, skill.server_reconcile, skill.load_error].filter(Boolean).join(" · "));
    if (skill.permissions.length) text(body, `Разрешения · ${skill.permissions.join(", ")}`);
    if (skill.conflicts.length) text(body, `Конфликты · ${skill.conflicts.join(", ")}`);
    if (skill.review_status) text(body, [reviews[skill.review_status] ?? skill.review_status, skill.review_stale ? "Проверка устарела" : ""].filter(Boolean).join(" · "));
    evidence(body, "Условия запуска", skill.review_gate);
    evidence(body, "Результаты проверки", skill.review_findings);
    evidence(body, "Запрошенный и выданный доступ", skill.grants);
    evidence(body, "Установка и обновления", skill.install);
    skillHealth(body, skill);
    skillPublicationReceipt(body, skill.name, skill.published, skill.published_malformed === true);
    const inspect = row();
    inspect.append(button("Манифест…", () => this.inspect(skill, "manifest", "Манифест навыка")));
    inspect.append(button("Разделы настроек…", () => {
      if (skill.name === "live_conversation" && this.openCallSettings) this.openCallSettings(dialog);
      else showExtensionSettings(this.gateway, skill.name, (settings) => this.present(settings, dialog), dialog);
    }));
    inspect.append(button("Процессы…", () =>
      showSkillProcesses(this.gateway, (processes) => this.present(processes, dialog), skill.name, dialog)));
    body.append(inspect);

    const actions = new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.NONE, column_spacing: 6, row_spacing: 6 });
    const add = (caption: string, callback: () => void) => actions.append(button(caption, callback));
    const change = (caption: string, action: string, data?: object, question?: string, root = skillsPath, long = false) => {
      add(caption, () => {
        void this.approve(skill, dialog, itemPath(root, skill.name, action), data, caption, question, long);
      });
    };
    const revision = { expected_content_hash: skill.content_hash };
    if (skill.identity_collision) text(body, "Несколько копий используют одно имя. Сначала разрешите конфликт в источниках навыков.");
    else if (skill.content_hash) {
      const missing = [...(skill.grants?.missing_keys ?? []), ...(skill.grants?.missing_permissions ?? [])];
      if (!skill.enabled && missing.length) add("Разрешить и включить…", () => this.grant(skill, missing, true));
      else change(skill.enabled ? "Выключить" : "Включить", "toggle", { ...revision, enabled: !skill.enabled });
      if (missing.length) add("Выдать доступ…", () => this.grant(skill, missing, false));
      change("Запустить проверку…", "review", {}, "Файлы навыка будут переданы настроенным моделям проверки. Проверка может занять несколько минут.", skillsPath, true);
      if (skill.owner_attestable === true) change("Принять без проверки…", "attest-review", revision,
        `Вы подтверждаете запуск этой версии навыка без проверки моделями. Разрешения · ${skill.permissions.join(", ") || "нет"}`, "/api/owner/skills");
      if (skill.type === "extension") change("Синхронизировать", "reconcile");
      if (skill.removal === "delete") change("Удалить…", "delete", { ...revision, payload_root: skill.payload_root },
        `Шлюз удалит файлы и сохранённое состояние навыка. Папка · ${skill.payload_root}`);
      if (skill.removal === "uninstall") change("Деинсталлировать…", "uninstall", undefined,
        "Шлюз уберёт навык, сохранив его настройки, выданные разрешения и квитанцию о публикации.", skillsPath, true);
      if (skill.published || skill.published_malformed) change("Забыть квитанцию…", "publication/clear", { expected_published: skill.published ?? {} },
        "Шлюз забудет локальную квитанцию. Pull request останется на GitHub.");
      if (skill.install?.update_available || skill.install?.update_rejected) add("Обновление…", () => this.update(skill));
      add("Публикация…", () => this.publication(skill));
      if (skill.payload_root) add("Попросить исправить…", () => { void this.repair(skill, dialog); });
    }
    body.append(actions);
    const history = [...(skill.skill_review?.history ?? [])].reverse();
    if (history.length) {
      const entries = column();
      body.append(new Gtk.Expander({ label: "История проверок", child: entries }));
      for (const review of history) {
        const line = [review.status && (reviews[review.status] ?? review.status), review.job_status, review.finished_at, review.content_hash].filter(Boolean).join(" · ");
        if (review.job_id) entries.append(button(line || review.job_id, () => this.history(skill, review.job_id!)));
        else if (line) text(entries, line);
        if (review.record_id && review.content_hash === skill.content_hash && review.continuable_seats?.length && !skill.identity_collision) {
          entries.append(button("Продолжить остановленную проверку…", () => this.continueReview(skill, review, dialog)));
        }
      }
      if (skill.skill_review?.history_omitted) text(entries, `Ранних записей вне списка · ${skill.skill_review.history_omitted}`);
    }
  }

  private continueReview(skill: Skill, review: Review, parent: any): void {
    if (!this.children.has(parent) || !this.currentRevision(skill) || this.blocked(skill.name)) return;
    const offers = review.continuable_seats;
    const seen = new Set<string>();
    if (!Array.isArray(offers) || !offers.length || offers.some(value => {
      const item = object(value);
      if (typeof item.seat_id !== "string" || !item.seat_id.trim() || typeof item.operation_id !== "string" || !item.operation_id.trim()
        || seen.has(item.seat_id.trim()) || ["cause", "run_id"].some(key => item[key] != null && typeof item[key] !== "string")) return true;
      seen.add(item.seat_id.trim());return false;
    }) || typeof review.record_id !== "string" || !review.record_id.trim() || review.content_hash !== skill.content_hash) {
      this.message(skill.name, "Шлюз не вернул полный список остановленных проверяющих. Обновите сведения о навыке.");
      return;
    }
    const reference = { record_id: review.record_id, content_hash: review.content_hash };
    const content = column(8);
    const releases: (() => void)[] = [];
    const bind = <T>(widget: T, property: string, source: string): T => {
      releases.push(bindChrome(widget, property, source));return widget;
    };
    const dialog = bind(sheet("Продолжить проверку", content), "title", "Continue review");
    text(content, skill.name);
    bind(labelInto(content, "Выберите остановленных проверяющих. Продолжение использует сохранённые файлы и оставшееся время исходной проверки; возможны расходы на модели."), "label",
      "Choose stopped reviewers. Continuation uses the saved files and the original review's remaining time; model usage may incur costs.");
    text(content, `${review.record_id} · ${review.content_hash}`);
    const choices = offers.map(offer => {
      const check = new Gtk.CheckButton();
      const description = label([offer.seat_id, offer.cause, offer.run_id].filter(Boolean).join(" · "));
      description.set_wrap_mode(Pango.WrapMode.WORD_CHAR);description.set_max_width_chars(64);
      check.set_child(description);content.append(check);
      return { check, selection: { seat_id: offer.seat_id, operation_id: offer.operation_id } };
    });
    let open = true;
    const submit = bind(button("Продолжить выбранных", () => {
      if (!open || !this.children.has(dialog) || !submit.get_sensitive()) return;
      if (!this.children.has(parent) || !this.currentRevision(skill) || this.blocked(skill.name)) {
        this.message(skill.name, "Версия или состояние навыка изменились. Проверьте текущие сведения перед продолжением.");
        open = false;dialog.close();return;
      }
      const selected = choices.filter(item => item.check.get_active()).map(item => ({ ...item.selection }));
      if (!selected.length) return;
      open = false;submit.set_sensitive(false);dialog.close();
      void this.run(skill.name, itemPath(skillsPath, skill.name, "review"), {
        review_reference: reference, continue_seats: selected,
      }, true);
    }), "label", "Continue selected reviewers");
    submit.set_sensitive(false);
    for (const { check } of choices) check.connect("toggled", () => {
      if (open) submit.set_sensitive(choices.some(item => item.check.get_active()));
    });
    content.append(submit);
    content.append(bind(button("Отмена", () => { if (open) { open = false;dialog.close(); } }), "label", "Cancel"));
    dialog.connect("closed", () => { open = false;for (const release of releases.splice(0)) release(); });
    this.present(dialog, parent);
  }

  private async repair(skill: Skill, dialog: any): Promise<void> {
    if (!await confirm(dialog, `Попросить исправить · ${skill.name}`,
      "Ouroboros запустит отдельную задачу для исправления и проверки этого навыка.", "Попросить исправить")) return;
    if (!this.children.has(dialog)) return;
    if (!this.currentRevision(skill)) {
      this.message(skill.name, "Версия навыка изменилась. Проверьте текущие сведения перед повтором.");
      return;
    }
    if (this.blocked(skill.name)) {
      this.message(skill.name, "Операция с этим навыком уже выполняется. Её состояние видно в очереди.");
      return;
    }
    this.writing.add(skill.name);
    this.message(skill.name, "Отправляется запрос исправления…");
    const visibleId = `skill_repair_${GLib.uuid_string_random()}`;
    try {
      const reply = await this.gateway.json<unknown>("POST", "/api/command", {
        cmd: `Repair this installed Ouroboros skill and verify the result. Work only on the selected payload. Review the resulting bytes and report any remaining blockers.\n${JSON.stringify({
          name: skill.name, payload_root: skill.payload_root, content_hash: skill.content_hash, load_error: skill.load_error,
          review_status: skill.review_status, review_findings: skill.review_findings?.slice(0, 12),
        }).slice(0, 18000)}`,
        task_constraint: { mode: "normal", skill_name: skill.name, payload_root: skill.payload_root, allow_enable: false, allow_review: true },
        // This key correlates one submission. The router assigns the actual task ID later.
        visible_task_id: visibleId,
        visible_text: `Проверить и исправить навык «${skill.name}».`,
        client_surface: { channel: "gnome" },
      });
      if (commandAccepted(reply, visibleId)) {
        this.message(skill.name, "Шлюз принял запрос исправления. Ход выполнения появится в задачах и чате.");
      } else {
        this.message(skill.name, "Приём запроса исправления не подтверждён. Проверьте задачи и чат перед повтором.");
      }
    } catch (error) {
      this.message(skill.name, error instanceof HttpError && commandRefused(error.status, error.body)
        ? `Запрос исправления отклонён. ${errorText(error)}`
        : `Результат отправки неизвестен. Проверьте задачи и чат перед повтором. ${errorText(error)}`);
    } finally {
      this.writing.delete(skill.name);
      await this.refresh();
    }
  }

  private async approve(skill: Skill, dialog: any, path: string, data: object | undefined, caption: string, question?: string, long = false): Promise<boolean> {
    if (!this.children.has(dialog)) return false;
    if (!this.currentRevision(skill)) {
      this.message(skill.name, "Версия навыка изменилась. Проверьте текущие сведения перед повтором.");
      return false;
    }
    if (question && !await confirm(dialog, `${caption.replace(/…$/, "")} · ${skill.name}`, question, caption.replace(/…$/, ""))) return false;
    if (!this.children.has(dialog)) return false;
    if (!this.currentRevision(skill)) {
      this.message(skill.name, "Версия навыка изменилась. Проверьте текущие сведения перед повтором.");
      return false;
    }
    await this.run(skill.name, path, data, long);
    return true;
  }

  private currentRevision(skill: Skill): boolean {
    const current = this.detail?.skill;
    return current?.name === skill.name && current.payload_root === skill.payload_root
      && !current.identity_collision && current.content_hash === skill.content_hash;
  }

  private async run(name: string, path: string, data?: object, long = false): Promise<void> {
    if (this.blocked(name)) {
      this.message(name, "Операция с этим навыком уже выполняется. Её состояние видно в очереди.");
      return;
    }
    this.writing.add(name);
    this.refusals.delete(name);this.mutationReceipts.delete(name);
    if (this.detail?.skill.name === name) { this.detail.refusal.update();this.detail.mutation.update(); }
    this.message(name, "Запрос отправлен. Операция может занять время.");
    try {
      const reply = await this.gateway.json<ActionReply>("POST", path, data, { ...ownerHeaders, Prefer: "respond-async" }, long);
      const mutationAction = path === itemPath(skillsPath, name, "toggle") ? "toggle" : path === itemPath(skillsPath, name, "delete") ? "delete" : undefined;
      if (mutationAction && reply?.ok !== false) {
        const receipt = readSkillMutationReceipt(mutationAction, name, reply, data);
        if (!receipt) throw new Error("Шлюз не подтвердил квитанцию выбранной операции навыка.");
        this.mutationReceipts.set(name, receipt);
        if (this.detail?.skill.name === name) this.detail.mutation.update(receipt);
      }
      if (path === itemPath(skillsPath, name, "uninstall") && reply?.ok !== false
        && (reply?.ok !== true || reply.name !== name)) {
        throw new Error("Шлюз не подтвердил деинсталляцию выбранного навыка.");
      }
      if (reply.ok === false) {
        this.refusals.set(name, { body: reply, status: 200, path });
        if (this.detail?.skill.name === name) this.detail.refusal.update(reply, 200, path);
      }
      if (reply.ok !== false && reply.job_id && (reply.pending || reply.status === "pending" || !reply.status)) {
        this.track(name, reply.job_id, reply.message, mutationAction === "toggle" ? (object(data).enabled ? "enable" : "disable") : mutationAction === "delete" ? "delete" : undefined);
      } else {
        const status = reply.status ? (Object.hasOwn(reviews, reply.status) ? reviews[reply.status] : reply.status) : "Шлюз завершил запрос";
        this.message(name, [reply.ok === false ? "Запрос отклонён" : status, reply.error, reply.setup_error, reply.load_error,
          reply.extension_load_error, reply.extension_action, reply.extension_reason,
          reply.publication_cleared === false ? "Квитанция уже отсутствует" : "",
          reply.base_available === false ? "Объединение начато без исходной версии" : ""].filter(Boolean).join(" · "));
      }
    } catch (error) {
      if (error instanceof HttpError) {
        this.refusals.set(name, { body: error.body, status: error.status, path });
        if (this.detail?.skill.name === name) this.detail.refusal.update(error.body, error.status, path);
      }
      this.message(name, error instanceof HttpError && error.status < 500 ? errorText(error)
        : `Итог запроса неизвестен. Проверьте установленный навык и очередь перед повтором. ${errorText(error)}`);
    } finally {
      this.writing.delete(name);
      await this.refresh();
    }
  }

  private blocked(name: string): boolean {
    return this.writing.has(name) || this.pending.has(name) || this.jobs.some((job) => job.target === name && !skillJobSettled(job.status));
  }

  private track(name: string, id: string, message = "Принято в работу", kind?: string): void {
    this.pending.set(name, { id, misses: 0, kind });
    this.message(name, [message, id].join(" · "));
    void this.refreshQueue();
  }

  private message(name: string, value: string): void {
    this.feedback.set(name, value);
    if (this.detail?.skill.name === name) this.detail.feedback.set_label(value);
    if (this.updateDialog?.name === name) this.updateDialog.feedback.set_label(value);
  }

  private grant(skill: Skill, missing: string[], enable: boolean): void {
    const content = column();
    const dialog = sheet(`Доступ для ${skill.name}`, content);
    const checkboxes = [...new Set(missing)].map((item) => new Gtk.CheckButton({ label: item }));
    const submit = button(enable ? "Разрешить и включить" : "Разрешить", () => {
      const items = checkboxes.filter((item) => item.get_active()).map((item) => item.get_label());
      if (!items.length || !this.currentRevision(skill)) return;
      dialog.close();
      void this.run(skill.name, itemPath(skillsPath, skill.name, "grants"),
        { expected_content_hash: skill.content_hash, items, ...(enable ? { enable_after_grant: true } : {}) });
    });
    submit.set_sensitive(false);
    text(content, "Навык получит доступ к выбранным ключам или возможностям шлюза.");
    for (const check of checkboxes) {
      content.append(check);
      check.connect("toggled", () => submit.set_sensitive(checkboxes.some((item) => item.get_active())));
    }
    content.append(submit);
    this.present(dialog, this.detail?.dialog);
  }

  private update(skill: Skill): void {
    if (this.updateDialog) return;
    const install = skill.install;
    const candidate = install?.update_available;
    const rejected = install?.update_rejected;
    const content = column();
    const dialog = sheet(`Обновление ${skill.name}`, content);
    const feedback = label("", "dim-label");
    feedback.set_selectable(true);
    this.updateDialog = { dialog, name: skill.name, feedback };
    dialog.connect("closed", () => { if (this.updateDialog?.dialog === dialog) this.updateDialog = undefined; });
    text(content, [`Текущая версия · ${skill.version}`, skill.content_hash, install?.modified ? "Есть локальные изменения" : "",
      install?.base_known === false ? "Исходный выпуск неизвестен" : ""].filter(Boolean).join(" · "));
    content.append(feedback);
    const controls = column();
    content.append(controls);
    const choose = (caption: string, mode: UpdateMode, release: Release, question: string, skip = false) => controls.append(button(caption, () => {
      void this.submitUpdate(skill, dialog, controls, mode, release, caption, question, skip);
    }));
    if (candidate?.digest) {
      text(controls, `Доступна версия ${candidate.version} · ${candidate.digest}`);
      choose("Заменить", "replace", candidate, "Шлюз установит выбранный выпуск и сохранит предыдущую копию.");
      if (install?.source?.kind !== "registry") {
        choose("Оставить текущую", "keep", candidate, "Шлюз запомнит, что этот выпуск пропущен.");
        choose("Объединить изменения", "merge", candidate, "Ouroboros поставит в очередь Main задачу объединения с вашими изменениями.");
      }
    }
    if (rejected?.digest) {
      text(controls, `Обновление отклонено · ${rejected.version} · ${rejected.reason} · ${rejected.digest}`);
      if (["review_blockers", "review_unfinished"].includes(rejected.reason ?? "")) {
        choose("Обновить без проверки", "replace", rejected, "Вы подтверждаете замену текущей версии этим выпуском и разрешаете запуск без проверки моделями.", true);
      }
    }
    this.present(dialog, this.detail?.dialog);
  }

  private async submitUpdate(skill: Skill, dialog: any, controls: any, mode: UpdateMode, release: Release,
    caption: string, question: string, skip: boolean): Promise<void> {
    if (!this.children.has(dialog) || !controls.is_sensitive()) return;
    const { name } = skill;
    controls.set_sensitive(false);
    let retry = true;
    let sent = false;
    try {
      if (!await confirm(dialog, `${caption} · ${name}`, question, caption) || !this.children.has(dialog)) return;
      const install = this.detail?.skill.install;
      const shown = skip ? install?.update_rejected : install?.update_available;
      if (!this.currentRevision(skill) || shown?.digest !== release.digest) {
        retry = false;
        this.message(name, "Выпуск или локальная копия изменились. Откройте обновление заново.");
        return;
      }
      if (this.blocked(name)) {
        this.message(name, "Операция с этим навыком уже выполняется. Её состояние видно в очереди.");
        return;
      }
      sent = true;
      this.writing.add(name);
      this.message(name, "Шлюз обрабатывает запрос обновления…");
      const reply = await this.gateway.json<UpdateReply>("POST", itemPath(skillsPath, name, "update"), {
        mode, digest: release.digest, local_digest: skill.content_hash, ...(skip ? { skip_review: true } : {}),
      }, ownerHeaders, true);
      if (reply?.ok === false) {
        this.message(name, reply.error || reply.code || "Шлюз отклонил запрос.");
        return;
      }
      retry = false;
      if (reply?.ok !== true || reply.mode !== mode || (reply.name && reply.name !== name)) {
        throw new Error("Шлюз не подтвердил выбранное действие.");
      }
      if (mode === "replace" && reply.job_id) {
        this.track(name, reply.job_id, `Замена на ${release.version || release.digest} принята в работу`);
      } else if (mode === "keep" && reply.skipped?.digest === release.digest) {
        this.message(name, `Выпуск пропущен · ${reply.skipped.version || release.version} · ${reply.skipped.digest}`);
      } else if (mode === "merge" && reply.task === "queued" && reply.candidate?.digest === release.digest) {
        const base = reply.base_available === true ? "Объединение с общей исходной версией"
          : reply.base_available === false ? "Двустороннее объединение без исходной версии" : "";
        this.message(name, ["Задача объединения поставлена в очередь Main",
          reply.candidate.version || release.version, reply.candidate.digest, base].filter(Boolean).join(" · "));
      } else {
        throw new Error("Шлюз вернул неполную квитанцию обновления.");
      }
    } catch (error) {
      const problem = error instanceof HttpError ? object(error.body) : {};
      const candidate = object(problem.candidate);
      const stale = error instanceof HttpError && ["local_changed", "candidate_changed", "source_gone", "withdrawn", "left_source"]
        .includes(error.reason ?? "");
      const definite = error instanceof HttpError && (error.status < 500 || problem.ok === false);
      retry = definite && !stale;
      this.message(name, [definite ? errorText(error) : `Итог запроса неизвестен. ${errorText(error)}`,
        candidate.digest && `Выпуск на шлюзе · ${candidate.version || ""} · ${candidate.digest}`,
        problem.local_digest && `Локальная копия · ${problem.local_digest}`,
        !retry && "Проверьте установленный выпуск и очередь операций перед повтором."].filter(Boolean).join("\n"));
    } finally {
      if (sent) {
        this.writing.delete(name);
        this.catalog.invalidate();
        await this.refresh();
      }
      if (retry && this.children.has(dialog)) controls.set_sensitive(true);
    }
  }

  private inspect(skill: Skill, endpoint: string, title: string): void {
    this.readSheet(title, itemPath(extensionsPath, skill.name, endpoint), this.detail?.dialog);
  }

  private history(skill: Skill, job: string): void {
    this.readSheet("Результат проверки", `${itemPath(skillsPath, skill.name, "review-history")}/${encodeURIComponent(job)}`, this.detail?.dialog);
  }

  private readSheet(title: string, path: string, parent: any): void {
    const content = column();
    const dialog = sheet(title, content);
    const load = async () => {
      clear(content);
      text(content, "Загрузка…");
      try {
        const result = await this.gateway.json<Record<string, unknown>>("GET", path);
        if (!this.children.has(dialog)) return;
        clear(content);
        if (typeof result.markdown === "string") {
          text(content, [result.status, result.job_status, result.content_hash].filter(Boolean).join(" · "));
          text(content, result.markdown);
        } else text(content, JSON.stringify(result, null, 2));
      } catch (error) {
        if (!this.children.has(dialog)) return;
        clear(content);
        text(content, errorText(error));
        content.append(button("Повторить чтение", () => void load()));
      }
    };
    this.present(dialog, parent);
    void load();
  }

  private publication(skill: Skill): void {
    const publication = new SkillPublication(this.gateway, skill, () => this.currentRevision(skill), this.openTask);
    publication.show((dialog, parent) => this.present(dialog, parent), this.detail?.dialog);
  }
}
