import { type Gateway, HttpError } from "./gateway.js";
import { gatewayStatePath, readGatewayState, writeGatewayState } from "./gateway-state.js";
import { Adw, Gio, GLib, Gtk } from "./gi.js";
import { object, ownerHeaders, type SettingsDocument } from "./settings-write.js";
import { type SkillSource, sourcesPath, type ShowSkillDialog } from "./skill-sources.js";
import { type LaunchBody, submissionKey } from "./task-launch-fields.js";
import { button, clear, column, confirm, errorText, label, sheet } from "./ui.js";

interface Destination {
  source_id: string;
  mode: "origin" | "entry" | "new_entry";
}

interface Target {
  skill: string;
  repository: string;
  destination?: Destination;
}

interface PublicationSkill {
  name: string;
  content_hash: string;
  install?: { source?: { id?: string; name?: string; kind?: string }; release?: { repo?: string } };
}

interface Attempt {
  body: LaunchBody;
  target: Target;
  approval: string;
  accepted?: true;
}

type Choice = { title: string; destination?: Destination };
const startStates = new Set(["ready", "warnings", "repairable", "needs_attention"]);
const stateLabels: Record<string, string> = {
  ready: "Готово к публикации", warnings: "Есть предупреждения", repairable: "Нужна доработка",
  needs_attention: "Требует внимания", hard_block: "Публикация заблокирована",
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function id(): string {
  return GLib.uuid_string_random().replace(/-/g, "");
}

function sha(value: string): string {
  return GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, value, -1);
}

function repositoryName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value);
}

function targetFrom(value: unknown): Target | undefined {
  const target = object(value);
  const { skill, repository } = target;
  if (typeof skill !== "string" || !skill || !repositoryName(repository)) return;
  if (target.destination === undefined) return { skill, repository };
  const { source_id, mode } = object(target.destination);
  if (typeof source_id !== "string" || !source_id || (mode !== "origin" && mode !== "entry" && mode !== "new_entry")) return;
  return { skill, repository, destination: { source_id, mode } };
}

function savedAttempt(value: unknown, skill: string): Attempt | undefined {
  const saved = object(value);
  const body = object(saved.body);
  const metadata = object(body.metadata);
  const target = targetFrom(metadata.skill_publish_target);
  if (target?.skill !== skill || body.type !== "skill_publish" || body.chat_id !== 1 || body.source !== "web" || !text(body.description)
    || !/^[a-f0-9]{32}$/u.test(text(body.task_id)) || !/^[a-f0-9]{32}$/u.test(text(metadata[submissionKey]))
    || !/^[a-f0-9]{64}$/u.test(text(saved.approval))) return;
  return { body: body as LaunchBody, target, approval: text(saved.approval), ...(saved.accepted === true ? { accepted: true } : {}) };
}

function publicationChoices(skill: PublicationSkill, sources: SkillSource[]): Choice[] {
  const choices: Choice[] = [{ title: "Направление по умолчанию" }];
  const origin = skill.install?.source;
  const originRow = sources.find((source) => source.id === origin?.id);
  const originKind = originRow?.kind || origin?.kind;
  const folderHub = originKind === "hub" && Boolean(originRow?.path);
  if (origin?.id && ["hub", "git"].includes(originKind ?? "") && (skill.install?.release?.repo || !folderHub)) {
    choices.push({ title: `В исходный репозиторий · ${origin.name ?? origin.id}`, destination: { source_id: origin.id, mode: "origin" } });
  }
  for (const source of sources) {
    if (source.kind === "git" && !source.commit && !source.ref?.startsWith("refs/tags/") && source.id !== origin?.id) {
      choices.push({ title: source.name, destination: { source_id: source.id, mode: "entry" } });
    }
  }
  const community = sources.find((source) => source.kind === "hub" && source.part === "community");
  if (community) choices.push({ title: `Общий каталог · ${community.name}`,
    destination: { source_id: community.id, mode: originKind === "hub" && !folderHub ? "new_entry" : "entry" } });
  return choices;
}

export class SkillPublication {
  private readonly content = column();
  private readonly controls = column();
  private readonly results = column();
  private readonly status = label("", "dim-label");
  private readonly recovery = column();
  private readonly cancel = new Gio.Cancellable();
  private readonly location: string;
  private readonly dialog: any;
  private attempt?: Attempt;
  private stateIssue = false;
  private retry = false;
  private busy = false;
  private closed = false;
  private displayed?: SettingsDocument;
  private selectionEpoch = 0;

  constructor(private readonly gateway: Gateway, private readonly skill: PublicationSkill, private readonly current: () => boolean,
    private readonly openTask?: (task: string) => void) {
    this.location = gatewayStatePath(gateway.base, `skill-publication-${sha(skill.name)}`);
    this.dialog = sheet(`Публикация ${skill.name}`, this.content);
    this.dialog.connect("closed", () => {
      this.closed = true;
      this.cancel.cancel();
    });
    this.status.set_selectable(true);
    for (const widget of [this.controls, this.results, this.status, this.recovery]) this.content.append(widget);
  }

  show(present: ShowSkillDialog, parent: any): void {
    const parentClosed = parent instanceof Adw.Dialog ? parent.connect("closed", () => this.dialog.force_close()) : undefined;
    let linked = true;
    this.dialog.connect("closed", () => { if (!linked) return; linked = false; if (parentClosed !== undefined) parent.disconnect(parentClosed); });
    if (GLib.file_test(this.location, GLib.FileTest.EXISTS)) {
      try {
        const value = readGatewayState(this.location);
        this.attempt = savedAttempt(value, this.skill.name);
        if (value !== null && !this.attempt) throw new Error("invalid saved publication");
      } catch {
        this.stateIssue = true;
        this.status.set_label("Не удалось прочитать сохранённый запрос публикации.");
      }
    }
    if (this.attempt) this.status.set_label(this.attempt.accepted
      ? `Шлюз подтвердил запуск · ${this.attempt.body.task_id}`
      : `Запуск не подтверждён · ${this.attempt.body.task_id}`);
    this.sync();
    present(this.dialog, parent);
    void this.loadChoices();
  }

  private async loadChoices(): Promise<void> {
    let sources: SkillSource[] = [];
    try {
      const result = await this.gateway.json<{ sources?: SkillSource[] }>("GET", sourcesPath, undefined, undefined, false, this.cancel);
      if (!Array.isArray(result?.sources) || result.sources.some(source => !source || typeof source.id !== "string")) throw new Error("Шлюз не подтвердил направления публикации.");
      sources = result.sources;
    } catch (error) {
      if (!this.closed && !this.attempt && !this.stateIssue) this.status.set_label(errorText(error));
    }
    if (this.closed) return;
    const choices = publicationChoices(this.skill, sources);
    const select = Gtk.DropDown.new_from_strings(choices.map(({ title }) => title));
    select.connect("notify::selected", () => {
      this.selectionEpoch++;
      this.displayed = undefined;
      clear(this.results);
      this.status.set_label("");
    });
    this.controls.append(select);
    this.controls.append(button("Проверить публикацию", () => void this.check(choices[select.get_selected()]?.destination)));
  }

  private sync(): void {
    this.controls.set_visible(!this.attempt && !this.stateIssue);
    this.controls.set_sensitive(!this.busy);
    this.results.set_sensitive(!this.busy);
    clear(this.recovery);
    const attempt = this.attempt;
    if (attempt) {
      const address = label(`Репозиторий · ${attempt.target.repository}`);
      address.set_selectable(true);
      this.recovery.append(address);
      if (attempt.accepted && this.openTask) this.recovery.append(button("Открыть задачу публикации", () => {
        if (!this.closed && this.dialog.close()) this.openTask?.(attempt.body.task_id);
      }));
      if (!attempt.accepted) {
        this.recovery.append(button("Проверить квитанцию на шлюзе", () => void this.verify()));
        if (this.retry) this.recovery.append(button("Повторить тот же запрос", () => void this.submit(attempt)));
      }
    }
    if (attempt || this.stateIssue) this.recovery.append(button(attempt?.accepted ? "Подготовить новую публикацию" : "Оставить без повтора…",
      () => void this.forget()));
    this.recovery.set_sensitive(!this.busy);
  }

  private async preflight(destination?: Destination): Promise<SettingsDocument> {
    const facts = object(await this.gateway.json("POST", `/api/skills/${encodeURIComponent(this.skill.name)}/publish-preflight`,
      destination ? { destination } : {}, ownerHeaders, true, this.cancel));
    if (!Object.keys(stateLabels).includes(text(facts.state)) || !Array.isArray(facts.findings)
      || facts.findings.some(item => !item || typeof item !== "object" || Array.isArray(item))) {
      throw new Error("Шлюз не подтвердил результаты проверки публикации.");
    }
    return facts;
  }

  private approval(facts: SettingsDocument): string {
    const scanner = object(facts.scanner);
    const review = object(facts.review);
    return sha(JSON.stringify([facts.skill, facts.repository, facts.snapshot_hash, facts.state,
      facts.publication_ready, facts.reason_code, facts.blocker_count, facts.warning_count, facts.findings,
      review.status, review.stale, review.profile, review.reviewed_content_hash, review.author_disposition, review.author_accepted,
      facts.omitted_count, facts.audited_false_positive_count, scanner.status, scanner.engine, scanner.version, scanner.ruleset_sha256]));
  }

  private canStart(facts: SettingsDocument): boolean {
    return facts.ok === true && facts.skill === this.skill.name && repositoryName(facts.repository)
      && facts.task_start_allowed === true && startStates.has(text(facts.state));
  }

  private showFacts(facts: SettingsDocument): void {
    this.displayed = undefined;
    clear(this.results);
    const state = text(facts.state);
    const summary = label([facts.repository, stateLabels[state] ?? state, facts.summary, facts.repair_hint].filter(Boolean).join("\n"));
    summary.set_selectable(true);
    this.results.append(summary);
    const add = (...values: unknown[]) => {
      const line = label(values.filter(value => value !== undefined && value !== null && value !== "")
        .map(value => typeof value === "object" ? JSON.stringify(value) : String(value)).join(" · "));
      line.set_selectable(true);
      this.results.append(line);
    };
    add("Файлы", facts.skill, facts.snapshot_hash);
    const review = object(facts.review), scanner = object(facts.scanner);
    add("Ревью", review.status || "не сообщено", review.profile, review.stale === true ? "устарело" : review.stale === false ? "для текущих файлов" : "свежесть не сообщена");
    if (review.author_accepted === true) add("Автор принял замечания", review.author_disposition);
    add("Сканер", scanner.status || "не запускался", scanner.engine, scanner.version, scanner.ruleset_sha256, scanner.reason_code, scanner.repair_hint);
    add("Блокирующих замечаний", facts.blocker_count ?? "не сообщено", "Предупреждений", facts.warning_count ?? "не сообщено",
      "Подтверждённых ложных срабатываний", facts.audited_false_positive_count ?? "не сообщено");
    for (const finding of Array.isArray(facts.findings) ? facts.findings : []) {
      const item = object(finding);
      add(item.path, item.line != null ? `строка ${item.line}` : undefined, item.detector, item.confidence, item.disposition, item.verification, item.reason);
    }
    if (typeof facts.omitted_count === "number" && facts.omitted_count > 0) add("Других замечаний вне списка", facts.omitted_count);
    if (this.canStart(facts) && facts.publication_ready !== true) {
      this.results.append(label("Задача начнётся с доработки навыка. Публикация возможна после итоговых проверок."));
    }
    if (Object.keys(facts).length) {
      const detail = label(JSON.stringify(facts, null, 2));
      detail.set_selectable(true);
      detail.add_css_class("monospace");
      this.results.append(new Gtk.Expander({ label: "Сведения проверки", child: detail }));
    }
  }

  private showPreflightError(error: unknown): void {
    const facts = error instanceof HttpError ? object(error.body) : {};
    if (facts.state) this.showFacts(facts);
    this.status.set_label(errorText(error));
  }

  private async check(destination?: Destination): Promise<void> {
    if (this.busy || this.closed || this.attempt) return;
    this.busy = true;
    this.displayed = undefined;
    const epoch = this.selectionEpoch;
    clear(this.results);
    this.status.set_label("Шлюз проверяет готовность файлов…");
    this.sync();
    try {
      const facts = await this.preflight(destination);
      if (this.closed || epoch !== this.selectionEpoch) return;
      this.status.set_label("");
      this.showFacts(facts);
      this.displayed = facts;
      if (this.canStart(facts)) this.results.append(button(facts.publication_ready === true
        ? "Запустить задачу публикации…" : "Запустить доработку и публикацию…", () => void this.start(facts, destination)));
    } catch (error) {
      if (!this.closed && epoch === this.selectionEpoch) this.showPreflightError(error);
    } finally {
      this.busy = false;
      if (!this.closed) this.sync();
    }
  }

  private async start(facts: SettingsDocument, destination?: Destination): Promise<void> {
    if (this.busy || this.closed || this.attempt || this.displayed !== facts || !this.canStart(facts)) return;
    const target = { skill: this.skill.name, repository: text(facts.repository), ...(destination ? { destination } : {}) };
    const disclosure = `Файлы навыка будут переданы в ${target.repository}. Их увидят все, у кого есть доступ к репозиторию.`;
    this.busy = true;
    this.sync();
    let accepted: boolean;
    try {
      accepted = await confirm(this.dialog, `Опубликовать ${target.skill}?`, disclosure, "Запустить публикацию");
    } finally {
      this.busy = false;
      if (!this.closed) this.sync();
    }
    if (!accepted || this.closed || this.displayed !== facts) return;
    const body: LaunchBody = {
      task_id: id(), source: "web", chat_id: 1, type: "skill_publish",
      description: `Publish the selected installed skill "${target.skill}" to "${target.repository}" and return a validated GitHub pull request URL.`,
      expected_output: `A validated pull request URL for "${target.skill}" in "${target.repository}".`,
      constraints: `Publish only this skill to the confirmed repository. Do not change accounts or credentials. If the repository-pinned Betterleaks runtime is missing or corrupt, only its checksum-pinned installer is authorized: python -m ouroboros.betterleaks_runtime install.`,
      context: `The owner approved publication to this repository. ${disclosure} Address any repairable preflight findings within the selected skill and complete the final checks before publishing.\nPreflight evidence: ${JSON.stringify(facts)}`,
      metadata: { [submissionKey]: id(), skill_publish_target: target },
    };
    await this.submit({ body, target, approval: this.approval(facts) });
  }

  private async submit(attempt: Attempt): Promise<void> {
    if (this.busy || this.closed || (this.attempt && (!this.retry || this.attempt !== attempt))) return;
    this.retry = false;
    this.busy = true;
    this.status.set_label("Сверяю условия публикации…");
    this.sync();
    try {
      const facts = await this.preflight(attempt.target.destination);
      if (this.closed) return;
      if (!this.current() || !this.canStart(facts) || this.approval(facts) !== attempt.approval) {
        this.showFacts(facts);
        this.status.set_label("Условия публикации изменились. Проверьте навык и направление заново.");
        return;
      }
      writeGatewayState(this.location, attempt);
      this.attempt = attempt;
    } catch (error) {
      if (!this.closed) this.showPreflightError(error);
      return;
    } finally {
      this.busy = false;
      if (!this.closed) this.sync();
    }
    this.busy = true;
    this.status.set_label("Отправляю задачу публикации…");
    clear(this.results);
    this.sync();
    try {
      const reply = object(await this.gateway.json("POST", "/api/tasks", attempt.body, undefined, false, this.cancel));
      if (this.closed) return;
      if (reply.ok !== true || reply.status !== "scheduled" || reply.task_id !== attempt.body.task_id) {
        throw new Error(text(reply.error) || "Шлюз не подтвердил создание задачи с этим ID.");
      }
      this.accept(attempt);
    } catch (error) {
      if (this.closed) return;
      const refused = error instanceof HttpError && error.status >= 400 && error.status < 500 && ![408, 409].includes(error.status);
      this.status.set_label(refused ? errorText(error) : `Запуск не подтверждён · ${attempt.body.task_id}\n${errorText(error)}`);
    } finally {
      this.busy = false;
      if (!this.closed) this.sync();
    }
  }

  private async verify(): Promise<void> {
    const attempt = this.attempt;
    if (!attempt || this.busy || this.closed) return;
    this.retry = false;
    this.busy = true;
    const task = attempt.body.task_id;
    this.status.set_label("Читаю сохранённую запись задачи…");
    this.sync();
    try {
      const reply = object(await this.gateway.json("GET", `/api/tasks/${encodeURIComponent(task)}`, undefined, undefined, false, this.cancel));
      if (this.closed) return;
      const metadata = object(reply.metadata);
      const target = targetFrom(metadata.skill_publish_target);
      const admission = object(reply.api_admission);
      if ((reply.task_id || reply.id) !== task || metadata[submissionKey] !== attempt.body.metadata[submissionKey]
        || JSON.stringify(target) !== JSON.stringify(attempt.target)) {
        this.status.set_label(`Найденная запись не подтверждает этот запрос · ${task}`);
      } else if (admission.status === "accepted" && text(admission.token)) this.accept(attempt);
      else this.status.set_label(`Запись задачи найдена · ${task}. Приём задачи ещё не подтверждён.`);
    } catch (error) {
      if (this.closed) return;
      if (error instanceof HttpError && error.status === 404) {
        this.retry = true;
        this.status.set_label(`Запись задачи пока отсутствует · ${task}. Можно повторить тот же запрос.`);
      } else this.status.set_label(errorText(error));
    } finally {
      this.busy = false;
      if (!this.closed) this.sync();
    }
  }

  private accept(attempt: Attempt): void {
    this.attempt = { ...attempt, accepted: true };
    let message = `Шлюз подтвердил запуск · ${attempt.body.task_id}`;
    try { writeGatewayState(this.location, this.attempt); } catch (error) { message += "\n" + errorText(error); }
    this.status.set_label(message);
  }

  private async forget(): Promise<void> {
    if (this.busy || this.closed) return;
    if (!this.attempt?.accepted && !await confirm(this.dialog, "Убрать сохранённый запрос?",
      "Запись исчезнет из клиента. Шлюз мог уже принять задачу публикации.", "Убрать запрос")) return;
    if (this.closed || this.busy) return;
    try {
      writeGatewayState(this.location, null);
      this.attempt = undefined;
      this.displayed = undefined;
      this.retry = false;
      this.stateIssue = false;
      this.status.set_label("");
      clear(this.results);
    } catch (error) {
      this.status.set_label(errorText(error));
    }
    this.sync();
  }
}
