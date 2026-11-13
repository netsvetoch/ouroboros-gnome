import { Gtk } from "./gi.js";
import { object, type SettingsDocument } from "./settings-write.js";
import { button, clear, column, label } from "./ui.js";

interface Target { skill: string; repository: string }
interface Attempt { time: string; invocation: string; facts?: SettingsDocument }

const tool = "submit_skill_to_hub";
const stages: Record<string, string> = {
  local_validation: "Локальная проверка", snapshot_captured: "Снимок файлов получен",
  local_preflight: "Предварительная проверка завершена", upstream_read: "Прочитан исходный репозиторий",
  fork_ready: "Форк готов", fork_synced: "Форк синхронизирован", branch_created: "Ветка создана",
  commit_created: "Коммит создан", pr_create_attempted: "Запрос на создание pull request отправлен", pr_opened: "Pull request открыт",
};
const vetoes: Record<string, string> = {
  skill_publish_pr_not_created: "Публикация остановилась до создания ветки. Pull request не создан.",
  skill_publish_receipt_mismatch: "Квитанция pull request не совпала с целью задачи.",
  skill_publish_receipt_absent: "Шлюз не подтвердил создание pull request.",
  skill_publish_not_attempted: "Шлюз не подтвердил вызов публикации.",
  skill_publish_target_missing: "Шлюз не подтвердил репозиторий и навык для публикации.",
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function hash(value: unknown): string {
  const candidate = text(value);
  return /^[a-f0-9]{64}$/i.test(candidate) ? candidate.toLowerCase() : "";
}

function fact(target: any, title: string, value: unknown): void {
  if (typeof value !== "number" && !text(value)) return;
  const field = label(`${title} · ${value}`);
  field.set_selectable(true);
  target.append(field);
}

function pullRequest(target: any, repository: string, number: unknown, url: unknown): boolean {
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) return false;
  const uri = text(url);
  const path = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)$/.exec(uri);
  if (path?.[0] !== uri || path[1]?.toLowerCase() !== repository.toLowerCase() || Number(path[2]) !== number) return false;
  target.append(new Gtk.LinkButton({ label: `Открыть pull request #${number}`, uri, halign: Gtk.Align.START }));
  return true;
}

export function skillPublicationReceipt(target: any, skill: string, value: unknown, malformed: boolean): void {
  const receipt = object(value);
  if (!Object.keys(receipt).length && !malformed) return;
  const body = column(4);
  if (malformed || receipt.slug !== skill || !hash(receipt.content_hash)
    || !pullRequest(body, text(receipt.repository), receipt.pr_number, receipt.pr_url)) {
    body.append(label("Сохранённая квитанция не подтверждает ссылку на pull request.", "dim-label"));
  }
  fact(body, "Репозиторий", receipt.repository);
  fact(body, "Выпуск", receipt.version);
  fact(body, "Опубликованный снимок", receipt.content_hash);
  fact(body, "Квитанция записана", receipt.published_at);
  const raw = label(JSON.stringify(receipt, null, 2));
  raw.set_selectable(true);
  body.append(new Gtk.Expander({ label: "Запись шлюза", child: raw }));
  target.append(new Gtk.Expander({ label: "Квитанция о публикации", child: body }));
}

function resultPreview(value: unknown): SettingsDocument | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const result = object(JSON.parse(value));
    if (result.operation === "skill_publish" && typeof result.ok === "boolean" && text(result.status) && text(result.skill)) return result;
  } catch { /* The log preview may be truncated. */ }
  return undefined;
}

export class PublicationResult {
  readonly widget = column(6);
  private readonly summary = column(4);
  private readonly attempts = column(4);
  private readonly read: any;
  private readonly known = new Set<string>();
  private readonly records: Attempt[] = [];
  private target?: Target;
  private dropped = 0;

  constructor(private readonly taskId: string, readEvents: () => void) {
    this.read = button("Прочитать журнал публикации", readEvents);
    this.widget.set_visible(false);
    this.widget.append(label("Публикация навыка", "title-3"));
    this.widget.append(this.summary);
    this.widget.append(this.read);
    this.widget.append(this.attempts);
  }

  update(task: unknown): void {
    const row = object(task);
    const target = object(object(row.metadata).skill_publish_target);
    const next = text(target.skill) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text(target.repository))
      ? { skill: text(target.skill), repository: text(target.repository) } : undefined;
    const previous = this.target;
    this.target = next;
    const objective = object(object(row.outcome_axes).objective);
    const veto = object(objective.receipt_veto);
    const reason = vetoes[text(veto.reason || row.reason_code)];
    this.widget.set_visible(Boolean(next || reason));
    this.read.set_visible(Boolean(next));
    this.attempts.set_visible(Boolean(next));
    clear(this.summary);
    if (reason) this.summary.append(label(reason));
    if (!next) return;
    fact(this.summary, "Навык", next.skill);
    fact(this.summary, "Репозиторий задачи", next.repository);
    if (!previous || previous.skill !== next.skill || previous.repository !== next.repository) this.renderAttempts();
  }

  observe(event: SettingsDocument): void {
    const data = object(event.data);
    if (event.task_id !== this.taskId || (data.task_id && data.task_id !== this.taskId) || event.source !== "tools"
      || event.type !== "tool_call" || data.tool !== tool) return;
    const invocation = text(data.invocation_id) || text(event.event_id) || JSON.stringify([event.root, event.line]);
    if (this.known.has(invocation)) return;
    this.known.add(invocation);
    const attempt = { time: text(event.ts), invocation, facts: resultPreview(data.result_preview) };
    this.records.push(attempt);
    if (this.records.length > 50) {
      this.records.shift();
      this.dropped++;
      if (this.target) this.renderAttempts();
    } else if (this.target) this.renderAttempt(this.target, attempt);
  }

  private renderAttempts(): void {
    clear(this.attempts);
    if (!this.target) return;
    if (this.dropped) fact(this.attempts, "Более ранние записи вне списка", this.dropped);
    for (const attempt of this.records) this.renderAttempt(this.target, attempt);
  }

  private renderAttempt(target: Target, { time, invocation, facts }: Attempt): void {
    const body = column(4);
    const detail = new Gtk.Expander({ label: ["Попытка публикации", time, text(facts?.status)].filter(Boolean).join(" · "), child: body });
    this.attempts.append(detail);
    fact(body, "Вызов", invocation);
    if (!facts || facts.skill !== target.skill) {
      body.append(label(facts ? "Запись журнала относится к другому навыку." : "В журнале отсутствует полный отчёт инструмента."));
      return;
    }
    const stage = text(facts.completed_stage);
    fact(body, "Последний подтверждённый этап", stages[stage] ?? stage);
    fact(body, "Причина", facts.reason_code);
    fact(body, "Ошибка GitHub", facts.error_detail);
    fact(body, "Операция GitHub", facts.github_operation);
    fact(body, "HTTP GitHub", facts.github_status);
    fact(body, "Дальнейшие действия", facts.repair_hint);
    fact(body, "Снимок файлов", facts.snapshot_hash);
    fact(body, "Источник назначения", facts.destination_source);
    fact(body, "Папка назначения", facts.destination_folder);
    fact(body, "Публикация файлов", facts.files_published);
    fact(body, "Запись в каталоге", facts.listed);
    fact(body, "Коммит объединения", facts.merged_commit);
    const scanner = object(facts.scanner);
    fact(body, "Сканер", [scanner.engine, scanner.version, scanner.status].map(text).filter(Boolean).join(" · "));
    fact(body, "Правила сканера", scanner.ruleset_sha256);
    fact(body, "Блокирующие находки", facts.blocker_count);
    fact(body, "Предупреждения", facts.warning_count);
    fact(body, "Проверенные ложные срабатывания", facts.audited_false_positive_count);
    fact(body, "Находки вне отчёта", facts.omitted_count);
    if (Array.isArray(facts.findings)) {
      for (const value of facts.findings) {
        const finding = object(value);
        fact(body, "Находка", [finding.path, finding.line, finding.detector, finding.disposition, finding.reason].filter(Boolean).join(" · "));
      }
    }
    if (Array.isArray(facts.completed_effects)) {
      for (const value of facts.completed_effects) {
        const effect = object(value);
        const key = text(effect.stage);
        fact(body, stages[key] ?? (key || "Подтверждённое действие"),
          [effect.repository, effect.branch, effect.commit_sha, effect.mode].map(text).filter(Boolean).join(" · ") || effect.kind);
      }
    }
    if (facts.ok !== true) return;
    const receipt = object(facts.receipt);
    const snapshot = hash(facts.snapshot_hash);
    const ruleset = text(scanner.ruleset_sha256);
    const receiptRuleset = text(receipt.ruleset_sha256);
    if (facts.status !== "pr_opened" || stage !== "pr_opened" || receipt.kind !== "github_pull_request"
      || receipt.skill !== target.skill || text(receipt.repository).toLowerCase() !== target.repository.toLowerCase()
      || !snapshot || hash(receipt.snapshot_hash) !== snapshot
      || (receiptRuleset && !hash(receiptRuleset)) || (ruleset && (!hash(ruleset) || hash(receiptRuleset) !== hash(ruleset)))
      || !pullRequest(body, target.repository, receipt.number, receipt.url)) {
      body.append(label("Квитанция pull request не соответствует этой задаче."));
    } else if (facts.publication_recorded === false) {
      body.append(label("Pull request подтверждён. Шлюз не смог сохранить квитанцию в карточке навыка."));
      fact(body, "Ошибка сохранения", facts.publication_record_error);
    }
  }
}
