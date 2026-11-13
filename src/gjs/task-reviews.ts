import { chrome, chromeText } from "./native-i18n.js";
import { Adw, Gio, GLib, Gtk, Pango } from "./gi.js";
import { renderReviewExecution } from "./review-execution.js";
import { adoptionPanel, adoptionRelation, type BodyAdoption, mergeBodyAdoptions } from "./body-adoptions.js";
import { type DownloadIdentity, type Gateway, query } from "./gateway.js";
import { pdfPreview } from "./pdf-preview.js";
import { type PlanReviewData, renderPlanReview } from "./plan-review.js";
import { object } from "./settings-write.js";
import { type AcceptanceData, type TaskSource, renderAcceptance, renderCompletion, taskSource } from "./task-acceptance.js";
import { button, chooseFile, clear, column, errorText, label, row, sheet } from "./ui.js";
import { exactWorkTarget } from "./work-actions.js";

interface Source {
  role?: string;
  part?: string;
  status?: string;
  sha256?: string;
}
interface CommitLanding {
  commit_sha: string;
  tree_sha?: string;
  parent_sha?: string;
  reviewed_subject?: string;
  author_subject?: string;
  author_disposition?: string;
  author_reason?: string;
  recorded_at?: string;
}
interface Panel {
  panel_id?: string;
  record_id?: string;
  surface?: string;
  ts?: string;
  revision?: number;
  record_state?: string;
  aggregate_signal?: string;
  reason?: string;
  goal?: string;
  quorum?: unknown;
  cost?: unknown;
  authority?: string;
  transport_status?: string;
  parse_status?: string;
  enforcement_impact?: string;
  panel_facts?: unknown;
  coverage?: unknown;
  wave_failures?: unknown[];
  task_attempt?: number;
  panel_index?: number;
  publication_revision?: number;
  applied_source_status?: string;
  applied_source_ref?: unknown;
  late_settlement?: { note?: string; settled_at?: string };
  superseded?: boolean;
  author_disposition?: { action?: string; disposition?: string; rationale?: string; reviewer_signal?: string; subject_hash?: string };
  commit_landings?: CommitLanding[];
  commit_landings_omitted?: number;
  source_ref?: { path?: string };
  author_decision?: { disposition?: string; rationale?: string; reviewer_signal?: string; enforcement?: string;
    subject_hash?: string; recorded_at?: string };
  actors?: {
    observed_model?: string; operation_state?: string; failure_code?: string; http_status?: unknown; reset_at?: string;
    reported_cause?: string; failure_details?: unknown; executions?: unknown; execution?: unknown;
    slot_id?: string; model?: string; requested_model?: string; actor_role?: string; transport_status?: string;
    parse_status?: string; semantic_verdict?: string; reason?: string; cost?: unknown; findings?: unknown[]; sources?: Source[];
    additional?: boolean; quorum_contribution?: boolean; enforcement_impact?: string; provider?: string;
    findings_omitted?: number; answers?: Record<string, unknown>; parts?: string[]; coverage?: unknown;
  }[];
}
interface Projection {
  panels?: Panel[];
  gaps?: { record_id?: string; review_gap?: string }[];
  review_records_omitted?: string | number;
  acceptance_incident?: unknown;
}
interface History { task_id: string; review_projection: Projection; next_offset: number | null }
export interface TaskReviewData extends PlanReviewData, AcceptanceData {
  review_projection?: Projection;
  body_adoptions?: BodyAdoption[];
}
interface LandingLabel { sha: string; widget: any }
interface SkillAttempt {
  skill?: string; job_id?: string; record_id?: string; task_id?: string; initiator_task_id?: string; origin_task_id?: string;
  review_status?: string; lifecycle_status?: string; status?: string;
}
export interface SkillReviewGroup extends SkillAttempt {
  surface?: string;
  presentation_owner_task_id?: string;
  attempts?: SkillAttempt[];
}

const hash = /^[a-f0-9]{64}$/;
const reviewPath = (task: string) => `/api/tasks/${encodeURIComponent(task)}/reviews`;

export function reviewReference(value: unknown): { task: string; surface: string; revision?: string } | undefined {
  const row = object(value);
  const direct = (row.system_type || row.type || row.event) === "review_reference";
  const reference = direct ? row : object(row.review_reference ?? object(row.progress_meta).review_reference);
  if (reference.surface !== "plan_review" && reference.surface !== "task_acceptance") return undefined;
  const task = reference.presentation_owner_task_id || reference.task_id || row.presentation_owner_task_id || row.task_id;
  if (!exactWorkTarget(task)) return undefined;
  const revision = typeof reference.state_revision === "string" && reference.state_revision ? reference.state_revision : undefined;
  return { task, surface: reference.surface, revision };
}

function detail(target: any, ...values: unknown[]): void {
  const text = values.filter((value) => value != null && value !== "").map((value) =>
    typeof value === "object" ? JSON.stringify(value) : String(value)).join(" · ");
  if (!text) return;
  const field = label(text);
  field.set_wrap_mode(Pango.WrapMode.WORD_CHAR);field.set_max_width_chars(64);
  field.set_selectable(true);
  target.append(field);
}

export class TaskReviews {
  private readonly dialogs = new Set<any>();
  private readonly closers = new Map<any, () => void>();
  private readonly closed = new WeakSet<object>();
  private readonly detailReaders = new Map<any, { task: string; revisions: Map<string, string>; refresh: () => void }>();

  constructor(private readonly gateway: Gateway) {}

  close(): void {
    for (const close of [...this.closers.values()].reverse()) close();
  }

  reference({ task, surface, revision }: NonNullable<ReturnType<typeof reviewReference>>): void {
    for (const reader of this.detailReaders.values()) {
      if (reader.task !== task || (revision && reader.revisions.get(surface) === revision)) continue;
      if (revision) reader.revisions.set(surface, revision);
      reader.refresh();
    }
  }

  private show(dialog: any, parent: any, cancel?: any): void {
    this.dialogs.add(dialog);
    let signal = 0;
    const dispose = () => {
      cancel?.cancel();
      this.closed.add(dialog);
      this.dialogs.delete(dialog);
      this.closers.delete(dialog);
      this.detailReaders.delete(dialog);
      if (signal) { parent.disconnect(signal); signal = 0; }
    };
    const close = () => { dispose(); if (dialog.get_mapped()) dialog.force_close(); };
    this.closers.set(dialog, close);
    dialog.connect("closed", dispose);
    if (parent instanceof Adw.Dialog) signal = parent.connect("closed", close);
    dialog.present(parent);
  }

  history(parent: any, task: string, source?: TaskReviewData, hydrate = false): void {
    if (this.closed.has(parent)) return;
    const content = column(10);
    const dialog = sheet("Ревью задачи", content);
    dialog.set_content_width(720);
    dialog.set_content_height(660);
    const summary = column(4);
    const status = label("", "dim-label");
    const records = column();
    const adoption = column();
    const current = column();
    const plan = column();
    const acceptance = column();
    const detailStatus = label("", "dim-label");
    const cancel = new Gio.Cancellable();
    dialog.connect("closed", () => { cancel.cancel(); this.detailReaders.delete(dialog); });
    let adoptions = mergeBodyAdoptions(undefined, source?.body_adoptions);
    const currentLandings: LandingLabel[] = [];
    const archivedLandings: LandingLabel[] = [];
    const syncLandings = () => {
      for (const { sha, widget } of [...currentLandings, ...archivedLandings]) {
        const text = adoptionRelation(sha, adoptions);
        widget.set_label(text);
        widget.set_visible(Boolean(text));
      }
    };
    const renderAdoptions = () => {
      const expanded = adoption.get_first_child()?.get_expanded();
      clear(adoption);
      const panel = adoptionPanel(adoptions);
      if (panel) {
        panel.set_expanded(expanded ?? false);
        adoption.append(panel);
      }
      syncLandings();
    };
    const currentReview = new Gtk.Expander({ label: "Ревью в текущем результате", child: current });
    let shownProjection: Projection | undefined;
    const renderCurrent = (projection?: Projection) => {
      if (JSON.stringify(projection) === JSON.stringify(shownProjection)) return;
      shownProjection = projection;
      clear(current);
      currentLandings.length = 0;
      currentReview.set_visible(Boolean(projection?.panels?.length || projection?.gaps?.length));
      if (projection) this.projection(dialog, current, task, projection, currentLandings);
      syncLandings();
    };
    let next: number | null = 0;
    let busy = false;
    currentReview.set_visible(false);
    summary.append(adoption);
    summary.append(plan);
    summary.append(acceptance);
    summary.append(currentReview);
    renderAdoptions();
    renderCurrent(source?.review_projection);
    let shownPlan = "";
    const renderPlan = (detail?: TaskReviewData) => {
      const key = JSON.stringify([detail?.plan_record, detail?.plan_objections, detail?.plan_review_state]);
      if (key === shownPlan) return;
      shownPlan = key;
      const expanded = new Map<string, boolean>();
      const visit = (widget: any, path: string[], restore: boolean) => {
        if (!widget) return;
        if (widget instanceof Gtk.Expander) {
          const next = [...path, widget.get_label()], id = JSON.stringify(next);
          if (restore) { if (expanded.has(id)) widget.set_expanded(expanded.get(id)); }
          else expanded.set(id, widget.get_expanded());
          visit(widget.get_child(), next, restore);return;
        }
        for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) visit(child, path, restore);
      };
      visit(plan, [], false);
      clear(plan);
      renderPlanReview(plan, detail, (target, ask, seat, sha256) =>
        this.sourceButton(dialog, target, task, ask, seat, { role: "response", sha256 }, "plan"));
      visit(plan, [], true);
    };
    renderPlan(source);
    let shownEvidence = "";
    const renderEvidence = (data?: TaskReviewData) => {
      const key = JSON.stringify([data?.outcome_axes, data?.review_status, data?.review_projection?.acceptance_incident,
        data?.acceptance_debt, data?.completion_observations]);
      if (key === shownEvidence) return;
      shownEvidence = key;
      clear(acceptance);
      if (data) this.taskEvidence(dialog, acceptance, task, data);
    };
    renderEvidence(source);
    const load = async () => {
      if (busy || next == null || !this.dialogs.has(dialog)) return;
      busy = true;
      more.set_sensitive(false);
      status.set_label("Читаю журнал ревью…");
      const offset = next;
      try {
        const result = await this.gateway.json<History>("GET", `${reviewPath(task)}${query({ offset, limit: 20 })}`,
          undefined, undefined, false, cancel);
        if (!this.dialogs.has(dialog)) return;
        if (result.task_id !== task || (result.next_offset != null && (!Number.isSafeInteger(result.next_offset) || result.next_offset <= offset))) {
          throw new Error("Шлюз вернул другую задачу или неверную позицию архива.");
        }
        next = result.next_offset;
        this.projection(dialog, records, task, result.review_projection, archivedLandings);
        syncLandings();
        status.set_label(offset === 0 && !result.review_projection.panels?.length && !result.review_projection.gaps?.length
          ? "В архивном журнале этой задачи нет записей." : "");
        more.set_visible(next != null);
        more.set_label("Следующая страница");
      } catch (error) {
        if (this.dialogs.has(dialog)) status.set_label(errorText(error));
      } finally {
        busy = false;
        if (this.dialogs.has(dialog)) more.set_sensitive(next != null);
      }
    };
    let readingDetail = false;
    let newer = false;
    const readDetail = async () => {
      if (!this.dialogs.has(dialog)) return;
      if (readingDetail) { newer = true; return; }
      readingDetail = true;
      detailStatus.set_label("Читаю текущий план и ревью…");
      try {
        const result = await this.gateway.json<TaskReviewData & { task_id?: string; id?: string }>("GET", `/api/tasks/${encodeURIComponent(task)}`,
          undefined, undefined, false, cancel);
        if (!this.dialogs.has(dialog)) return;
        if ((result?.task_id ?? result?.id) !== task) throw new Error("Шлюз вернул сведения о другой задаче.");
        const updated = mergeBodyAdoptions(adoptions, result.body_adoptions);
        if (JSON.stringify(updated) !== JSON.stringify(adoptions)) {
          adoptions = updated;
          renderAdoptions();
        }
        if (result.review_projection) renderCurrent(result.review_projection);
        renderPlan(result);
        renderEvidence(result);
        detailStatus.set_label("");
      } catch (error) {
        if (this.dialogs.has(dialog)) detailStatus.set_label(errorText(error));
      } finally {
        readingDetail = false;
        if (newer) { newer = false; void readDetail(); }
      }
    };
    const more = button("Прочитать архив", () => void load());
    const refresh = button("Перечитать план и ревью", () => void readDetail());
    for (const widget of [refresh, detailStatus, summary, status, records, more]) content.append(widget);
    this.show(dialog, parent, cancel);
    this.detailReaders.set(dialog, { task, revisions: new Map(), refresh: () => void readDetail() });
    void load();
    if (hydrate) void readDetail();
  }

  taskEvidence(parent: any, target: any, task: string, data: TaskReviewData): void {
    const open = (container: any, title: string, ref: unknown) => this.publishedSource(parent, container, task, title, ref);
    renderAcceptance(target, data, data.review_projection?.acceptance_incident, open);
    renderCompletion(target, data.completion_observations, open);
  }

  lateEvidence(parent: any, target: any, task: string | undefined, value: unknown): void {
    const evidence = object(value);
    const source = object(evidence.review_source);
    if (evidence.kind === "merge_review" && exactWorkTarget(source.task_id)
      && typeof source.record_id === "string" && typeof source.seat_id === "string" && typeof source.sha256 === "string") {
      this.sourceButton(parent, target, source.task_id, source.record_id, source.seat_id, {
        role: typeof source.role === "string" ? source.role : "response", sha256: source.sha256,
        part: typeof source.part === "string" ? source.part : undefined,
      }, source.domain === "plan" ? "plan" : "ledger");
    } else if (task) this.publishedSource(parent, target, task, "Открыть сохранённое заключение", evidence.source_ref);
  }

  publishedSource(parent: any, target: any, task: string, title: string, ref: unknown, englishTitle?: string): boolean {
    const source = taskSource(task, ref);
    if (!source) return false;
    const open = button(`${title}…`, () => this.document(parent, englishTitle ? chromeText(englishTitle, undefined, title) : title, source.path, source));
    if (englishTitle) chrome(open, "label", englishTitle + "…");
    target.append(open);
    return true;
  }

  artifactDocument(parent: any, title: string, name: string, path: string, identity: DownloadIdentity,
    describe?: (target: any, data: unknown) => void): void {
    this.document(parent, title, path, { name, path, ...identity }, describe);
  }

  artifactPdf(parent: any, title: string, path: string, identity: DownloadIdentity): void {
    if (this.closed.has(parent)) return;
    const cancel = new Gio.Cancellable();
    const dialog = sheet(title, pdfPreview(title, identity.size, () => this.readArtifact(path, identity, cancel), cancel));
    dialog.set_content_width(760);
    dialog.set_content_height(650);
    dialog.connect("closed", () => cancel.cancel());
    this.show(dialog, parent, cancel);
  }

  private async readArtifact(path: string, identity: DownloadIdentity, cancel: any): Promise<Uint8Array> {
    const bytes = await this.gateway.previewBytes(path, identity.size, cancel);
    if (bytes.length !== identity.size || GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, bytes) !== identity.sha256) {
      throw new Error("Размер или контрольная сумма сохранённого материала не совпали.");
    }
    return bytes;
  }

  private projection(dialog: any, target: any, task: string, projection: Projection, landings: LandingLabel[]): void {
    for (const panel of projection.panels ?? []) {
      const item = column(4);
      const surface = panel.surface === "task_acceptance" ? "Приёмка задачи" : panel.surface;
      target.append(new Gtk.Expander({ label: [surface, panel.aggregate_signal, panel.ts, panel.record_id].filter(Boolean).join(" · ") || "Запись ревью", child: item }));
      detail(item, panel.record_state, panel.revision, panel.goal, panel.reason, panel.quorum, panel.cost);
      detail(item, panel.authority, panel.transport_status, panel.parse_status, panel.enforcement_impact);
      if (panel.panel_facts) detail(item, "Состав проверки", panel.panel_facts);
      if (panel.coverage) detail(item, "Охват проверки", panel.coverage);
      for (const failure of panel.wave_failures ?? []) detail(item, "Сбой проверки", failure);
      if (panel.surface === "task_acceptance") {
        if (panel.task_attempt !== undefined) detail(item, "Попытка задачи", panel.task_attempt);
        if (panel.panel_index !== undefined) detail(item, "Номер проверки", panel.panel_index);
        if (panel.publication_revision !== undefined) detail(item, "Версия записи", panel.publication_revision);
        if (panel.superseded === true) detail(item, "Проверка заменена более поздней записью.");
        if (panel.late_settlement) {
          detail(item, "Позднее завершение проверки", panel.late_settlement.settled_at);
          detail(item, panel.late_settlement.note);
        }
        const author = panel.author_disposition;
        if (author?.disposition || author?.action) {
          detail(item, "Решение автора для этой проверки", author.action, author.disposition, author.reviewer_signal, author.subject_hash);
          detail(item, author.rationale);
        }
        if (panel.applied_source_status !== "available"
          || !this.publishedSource(dialog, item, task, "Открыть полное заключение приёмки", panel.applied_source_ref)) {
          detail(item, "Полное заключение приёмки недоступно.");
        }
      }
      for (const landing of Array.isArray(panel.commit_landings) ? panel.commit_landings : []) {
        if (typeof landing?.commit_sha !== "string" || !landing.commit_sha) continue;
        const facts = column(4);
        item.append(new Gtk.Expander({ label: `Коммит · ${landing.commit_sha.slice(0, 12)}`, child: facts }));
        detail(facts, landing.commit_sha, landing.recorded_at);
        detail(facts, landing.reviewed_subject === "same" ? "Ревью относится к тому же дереву файлов."
          : landing.reviewed_subject === "different" ? "Это ревью относится к другому дереву файлов."
            : "Связь дерева файлов с этим ревью не подтверждена.");
        if (landing.tree_sha) detail(facts, "Дерево", landing.tree_sha);
        if (landing.parent_sha) detail(facts, "Родитель", landing.parent_sha);
        if (landing.author_disposition || landing.author_subject) {
          detail(facts, "Решение автора для этого коммита", landing.author_disposition, landing.author_subject);
        }
        if (landing.author_reason) detail(facts, "Обоснование", landing.author_reason);
        const relation = label("", "dim-label");
        relation.set_selectable(true);
        facts.append(relation);
        landings.push({ sha: landing.commit_sha, widget: relation });
      }
      if (typeof panel.commit_landings_omitted === "number" && panel.commit_landings_omitted > 0) {
        detail(item, "Более ранних коммитов за пределами списка", panel.commit_landings_omitted, panel.source_ref?.path);
      }
      if (panel.author_decision) {
        const decision = panel.author_decision;
        detail(item, "Решение автора в записи ревью", decision.disposition, decision.reviewer_signal, decision.enforcement,
          decision.subject_hash, decision.recorded_at);
        detail(item, decision.rationale);
      }
      for (const actor of panel.actors ?? []) {
        detail(item, actor.slot_id, actor.model || "Модель не указана", actor.provider, actor.actor_role, actor.semantic_verdict,
          actor.transport_status, actor.parse_status, actor.reason, actor.cost);
        if (actor.requested_model && actor.requested_model !== actor.model) detail(item, "Запрошенная модель", actor.requested_model);
        renderReviewExecution(item, actor);
        if (actor.additional !== undefined) detail(item, actor.additional ? "Советник вне кворума" : "Участник кворума");
        if (actor.quorum_contribution !== undefined) detail(item, actor.quorum_contribution ? "Ответ учитывается в кворуме" : "Ответ не учитывается в кворуме", actor.enforcement_impact);
        if (actor.coverage) detail(item, "Охват ответа", actor.coverage);
        const parts = [...new Set([...(actor.parts ?? []), ...Object.keys(actor.answers ?? {})])];
        for (const part of parts) {
          const answer = object(actor.answers?.[part]);
          detail(item, "Раздел", part, answer.status, answer.verdict,
            answer.findings !== undefined ? `Замечаний · ${answer.findings}` : "",
            answer.critical !== undefined ? `Критических · ${answer.critical}` : "", answer.coverage);
        }
        for (const finding of actor.findings ?? []) {
          const row = object(finding);
          const title = row.item ?? row.summary ?? row.title;
          detail(item, row.severity, row.verdict, row.id, title, row.description ?? row.text ?? row.message, row.file, row.line);
          if (row.summary && row.summary !== title) detail(item, "Кратко", row.summary);
          if (row.reason) detail(item, "Обоснование", row.reason);
          if (row.evidence) detail(item, "Свидетельство", row.evidence);
          if (row.recommendation) detail(item, "Рекомендация", row.recommendation);
        }
        if (typeof actor.findings_omitted === "number" && actor.findings_omitted > 0) detail(item, "Замечаний за пределами списка", actor.findings_omitted);
        if (!panel.record_id || !actor.slot_id) continue;
        for (const source of actor.sources ?? []) {
          if (source.status === "retained") this.sourceButton(dialog, item, task, panel.record_id, actor.slot_id, source, "ledger");
        }
      }
    }
    for (const gap of projection.gaps ?? []) detail(target, "Запись недоступна", gap.record_id, gap.review_gap);
    if (projection.review_records_omitted && projection.review_records_omitted !== "0") {
      detail(target, "Более ранних записей за пределами этой порции", projection.review_records_omitted);
    }
  }

  private sourceButton(parent: any, target: any, task: string, record: string, seat: string, source: Source, domain: string): void {
    const sha256 = source.sha256;
    if (!record || !seat || !sha256 || !hash.test(sha256) || !["response", "failure"].includes(source.role ?? "")) return;
    const path = `${reviewPath(task)}/${encodeURIComponent(record)}/${encodeURIComponent(seat)}${query({
      role: source.role, part: source.part ?? "", sha256, domain,
    })}`;
    const name = [source.role === "failure" ? "Запись об ошибке" : "Сохранённый ответ", source.part].filter(Boolean).join(" · ");
    target.append(button(`${name}…`, () => this.document(parent, name, path, sha256)));
  }

  skill(parent: any, group: SkillReviewGroup, task?: string): void {
    if (this.closed.has(parent)) return;
    const content = column();
    const dialog = sheet("Сохранённые проверки навыка", content);
    const attempts = group.attempts?.length ? group.attempts : [group];
    for (const attempt of attempts) {
      const name = attempt.skill || group.skill;
      const id = attempt.record_id || attempt.job_id;
      const owner = attempt.initiator_task_id || attempt.origin_task_id || attempt.task_id
        || group.initiator_task_id || group.origin_task_id || group.presentation_owner_task_id || task;
      detail(content, name, id, attempt.review_status ?? attempt.status, attempt.lifecycle_status);
      if (!name || !id || !owner) continue;
      const path = `${reviewPath(owner)}/skill/${encodeURIComponent(id)}${query({ skill: name, format: "text" })}`;
      content.append(button("Прочитать сохранённую проверку…", () => this.document(dialog, name, path)));
    }
    this.show(dialog, parent);
  }

  private document(parent: any, title: string, path: string, source?: string | TaskSource,
    describe?: (target: any, data: unknown) => void): void {
    if (this.closed.has(parent)) return;
    const content = column();
    const dialog = sheet(title, content);
    dialog.set_content_width(750);
    dialog.set_content_height(640);
    const status = label("Читаю сохранённый текст…", "dim-label");
    const text = new Gtk.TextView({ editable: false, wrap_mode: Gtk.WrapMode.WORD_CHAR, monospace: true });
    const buffer = text.get_buffer();
    const overview = describe ? column(5) : undefined;
    const actions = row();
    const cancel = new Gio.Cancellable();
    dialog.connect("closed", () => cancel.cancel());
    let bytes: any;
    let busy = false;
    let saving = false;
    const artifact = typeof source === "object" ? source : undefined;
    const large = artifact && artifact.size > 1024 * 1024;
    if (artifact) {
      const identity = label(`${artifact.name} · ${GLib.format_size(artifact.size)}\nSHA-256 · ${artifact.sha256}`);
      identity.set_selectable(true);
      content.append(identity);
    }
    const read = async () => {
      if (cancel.is_cancelled() || busy || saving || large) return;
      busy = true;
      bytes = undefined;
      buffer.set_text("", -1);
      if (overview) clear(overview);
      save.set_sensitive(false);
      status.set_label("Читаю сохранённый текст…");
      try {
        let verified: any;
        if (artifact) verified = GLib.Bytes.new(await this.readArtifact(path, artifact, cancel));
        else verified = await this.gateway.reviewExport(path, typeof source === "string" ? source : undefined, cancel);
        if (!this.dialogs.has(dialog)) return;
        bytes = verified;
        let preview = new TextDecoder().decode(bytes.get_data());
        if (artifact?.name.endsWith(".json")) {
          let parsed: unknown;
          try { parsed = JSON.parse(preview); } catch { /* Earlier records may contain plain text. */ }
          if (parsed !== undefined) {
            preview = JSON.stringify(parsed, null, 2);
            if (overview) describe?.(overview, parsed);
          }
        }
        buffer.set_text(preview, -1);
        status.set_label("");
        save.set_sensitive(true);
      } catch (error) {
        if (this.dialogs.has(dialog)) status.set_label(errorText(error));
      } finally { busy = false; }
    };
    const save = button(artifact ? "Скачать материал…" : "Скачать текст…", () => {
      void (async () => {
        const selected = bytes;
        if (cancel.is_cancelled() || saving || (!selected && !large)) return;
        saving = true;
        save.set_sensitive(false);
        try {
          const destination = await chooseFile(dialog, artifact?.name ?? "review.txt", cancel);
          if (!destination || !this.dialogs.has(dialog)) return;
          if (large) {
            status.set_label("Скачиваю и проверяю материал…");
            await this.gateway.download(path, destination, true, cancel, artifact);
          } else await new Promise<void>((resolve, reject) => {
            destination.replace_contents_bytes_async(selected, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, cancel,
              (_file: unknown, result: unknown) => {
                try { destination.replace_contents_finish(result); resolve(); } catch (error) { reject(error); }
              });
          });
          if (this.dialogs.has(dialog)) status.set_label(artifact ? "Проверенный материал сохранён." : "Текст сохранён.");
        } catch (error) {
          if (this.dialogs.has(dialog)) status.set_label(errorText(error));
        } finally {
          saving = false;
          if (this.dialogs.has(dialog)) save.set_sensitive(Boolean(bytes || large));
        }
      })();
    });
    actions.append(save);
    if (large) status.set_label("Материал больше 1 МиБ. Его можно скачать с проверкой SHA‑256.");
    else actions.append(button("Перечитать текст", () => void read()));
    for (const widget of [actions, status, overview, text]) if (widget) content.append(widget);
    this.show(dialog, parent, cancel);
    void read();
  }
}
