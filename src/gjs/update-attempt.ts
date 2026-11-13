import { GLib, Gtk } from "./gi.js";
import { type UpdateRange } from "./update-evidence.js";
import { button, clear, column, label } from "./ui.js";

export interface UpdateProgress extends UpdateRange {
  operation_id?: string;
  stage?: string;
  stage_started_at?: string;
  started_at?: string;
  active?: boolean;
  outcome?: string;
  outcome_at?: string;
  concluded_by?: string;
  reason?: string;
  result?: string;
  error?: string;
  keep_branch?: string;
  stash_note?: string;
  blockers?: string[];
  work_stop?: string;
  tx_attempt_id?: string;
  current_generation?: boolean;
  restart_required?: boolean;
  retention_unconfirmed?: boolean;
}

export interface UpdateTransaction {
  active: boolean;
  attempt_id?: string;
  phase?: string;
  task_id?: string;
  restart_required?: boolean;
  local_work_recovery?: boolean;
}

export function updateRecovery(tx?: UpdateTransaction): { restart: boolean; message?: string } | undefined {
  if (!tx?.active) return undefined;
  const restartProcess = "Перезапустите процесс шлюза, чтобы продолжить восстановление.";
  if (tx.local_work_recovery) return {
    restart: false,
    message: `Шлюз ещё восстанавливает локальные изменения. Снимок рабочей копии сохранён. ${restartProcess}`,
  };
  if (tx.phase === "corrupt") return {
    restart: false,
    message: `Шлюз не может прочитать запись транзакции обновления. ${restartProcess} Затем перечитайте состояние.`,
  };
  if (tx.phase === "gate_blocked" || tx.phase === "marker_cleanup_retry") return {
    restart: false,
    message: `Попытка обновления ждёт завершения восстановления. ${restartProcess}`,
  };
  if (tx.phase === "pending_boot_smoke") return {
    restart: true,
    message: "Обновление ждёт перезапуска шлюза и проверок при запуске.",
  };
  return { restart: tx.phase === "applying_replace" && tx.restart_required === true };
}

interface Sample {
  source_sha?: string;
  observed_at?: string;
  rss_bytes?: number | null;
  rss_measure?: string;
  cpu_seconds?: number | null;
  cpu_percent?: number | null;
  cpu_interval_seconds?: number | null;
  duty_overruns?: Record<string, number> | null;
  direct_message_first_dispatch?: { seconds?: number; task_id?: string } | null;
}

export interface UpdateSamples extends UpdateRange {
  operation_id?: string;
  outcome?: string;
  before?: Sample | null;
  after?: Sample | null;
}

export const updateOutcomes: Record<string, string> = {
  applied: "Обновление применено", not_applied: "Обновление не применено", rolled_back: "Восстановлена предыдущая версия",
  failed: "Обновление завершилось с ошибкой", unknown: "Исход обновления неизвестен",
};
const stages: Record<string, string> = {
  draining_writers: "Завершение текущей работы", stopping_workers: "Остановка рабочих процессов",
  stopping_services: "Остановка служб", preparing: "Подготовка обновления", applying: "Применение обновления",
  checking: "Проверка обновления и зависимостей", rolling_back: "Восстановление предыдущей версии",
  restart_requested: "Запрошен перезапуск",
};
const reasons: Record<string, string> = {
  startup_unconfirmed: "Шлюз не подтвердил проверки при запуске.",
  running_source_mismatch: "Запущенный коммит отличается от результата обновления.",
  record_unreadable: "Сохранённую запись попытки не удалось прочитать.",
  state_unreadable: "Сохранённое состояние шлюза не удалось прочитать.",
  no_completion_record: "В журнале шлюза нет записи о завершении.",
  release_moved: "Целевой коммит изменился после подготовки плана.",
  late_local_changes: "Рабочие файлы изменились после подготовки плана.",
  rollback_incomplete: "Восстановление предыдущей версии не завершилось.",
};
const assistedPhases = ["materializing_assisted", "assisted_resolution", "committing_assisted"];

function readName(names: Record<string, string>, key?: string): string | undefined {
  return key && Object.hasOwn(names, key) ? names[key] : key;
}

function fact(box: any, name: string, value?: string): void {
  if (!value) return;
  const text = label(`${name} · ${value}`);
  text.set_selectable(true);
  box.append(text);
}

function seconds(value?: number | null): string | undefined {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(2)} с` : undefined;
}

function sampleRows(box: any, name: string, sample: Sample | null | undefined, openTask: (id: string) => void): void {
  box.append(label(name, "heading"));
  if (!sample) {
    box.append(label("Замер отсутствует", "dim-label"));
    return;
  }
  fact(box, "Коммит процесса шлюза", sample.source_sha);
  fact(box, "Время замера", sample.observed_at);
  const memory = sample.rss_measure === "peak" ? "Пиковая RSS" : sample.rss_measure === "footprint" ? "Физический объём памяти" : "RSS";
  if (typeof sample.rss_bytes === "number" && sample.rss_bytes >= 0 && Number.isFinite(sample.rss_bytes)) {
    fact(box, memory, GLib.format_size(sample.rss_bytes));
  }
  fact(box, "Время CPU за жизнь процесса", seconds(sample.cpu_seconds));
  const percent = typeof sample.cpu_percent === "number" && Number.isFinite(sample.cpu_percent)
    ? `${sample.cpu_percent.toFixed(1)} %` : undefined;
  const interval = seconds(sample.cpu_interval_seconds);
  if (percent || interval) fact(box, "Доля CPU за интервал", `${percent ?? "доля неизвестна"} · ${interval ?? "интервал неизвестен"}`);
  if (sample.duty_overruns) {
    const overruns = Object.entries(sample.duty_overruns).map(([duty, count]) => `${duty} ×${count}`);
    fact(box, "Превышения времени служебных операций", overruns.length ? overruns.join(", ") : "нет");
  }
  const dispatch = sample.direct_message_first_dispatch;
  fact(box, "От приёма сообщения до первого вызова модели", seconds(dispatch?.seconds));
  const task = dispatch?.task_id;
  if (task) box.append(button(`Открыть задачу ${task}`, () => openTask(task)));
}

export class UpdateAttemptView {
  readonly widget = column(6);
  private readonly title = label("", "title-3");
  private readonly details = column(6);
  private readonly expander = new Gtk.Expander({ label: "Подробности попытки", child: this.details });
  private readonly rawText = label("");
  private readonly raw = new Gtk.Expander({ child: this.rawText });
  private key = "";

  constructor(private readonly openTask: (id: string) => void) {
    this.rawText.set_selectable(true);
    this.widget.append(this.title);
    this.widget.append(this.expander);
  }

  show(progress?: UpdateProgress, tx?: UpdateTransaction, samples?: UpdateSamples | null): boolean {
    if (!progress?.operation_id && !tx?.active) return false;
    const bound = tx?.active && tx.attempt_id && tx.attempt_id === progress?.tx_attempt_id ? tx : undefined;
    const key = JSON.stringify([progress, tx, samples]);
    if (this.key === key) return true;
    this.key = key;
    const outcome = progress?.outcome || (!progress?.active && progress?.result === "failed" ? "failed" : undefined);
    const stage = readName(stages, progress?.stage);
    const concluded = !progress?.active && outcome;
    const resolving = bound?.phase && assistedPhases.includes(bound.phase);
    const awaiting = progress?.current_generation === false || progress?.result === "assisted_started";
    const headline = concluded ? readName(updateOutcomes, outcome) : resolving ? "Идёт разрешение конфликтов с ревью"
      : awaiting ? "Ожидается результат попытки обновления" : stage || "Идёт обновление шлюза";
    this.title.set_label(progress?.operation_id ? `Последняя попытка · ${headline}` : headline);
    clear(this.details);
    fact(this.details, "Операция", progress?.operation_id);
    fact(this.details, "Исходный коммит", progress?.base_sha);
    fact(this.details, "Целевой коммит", progress?.target_sha);
    fact(this.details, "Последний этап", stage);
    fact(this.details, "Фаза транзакции", bound?.phase || (!progress?.operation_id ? tx?.phase : undefined));
    fact(this.details, "Время", progress?.outcome_at || progress?.stage_started_at || progress?.started_at);
    const concludedBy = progress?.concluded_by;
    fact(this.details, "Кто записал исход", concludedBy === "boot" ? "шлюз после перезапуска"
      : concludedBy === "executor" ? "процесс обновления" : concludedBy);
    fact(this.details, "Причина", readName(reasons, progress?.reason));
    fact(this.details, "Ошибка", progress?.error);
    fact(this.details, "Блокировки", progress?.blockers?.join(", "));
    fact(this.details, "Сохранённая ветка", progress?.keep_branch);
    fact(this.details, "Рабочие изменения", progress?.stash_note);
    if (concludedBy === "executor" && progress?.work_stop === "invoked") {
      this.details.append(label("Обновление запросило остановку текущей работы.", "dim-label"));
    }
    if (concludedBy === "executor" && progress?.work_stop === "none" && outcome === "not_applied") {
      this.details.append(label("Эта попытка не останавливала текущую работу.", "dim-label"));
    }
    if (progress?.retention_unconfirmed) this.details.append(label("Сохранение исхода попытки не подтверждено.", "dim-label"));
    if (bound && !updateRecovery(bound)?.message && outcome === "failed" && progress?.reason === "rollback_incomplete") {
      this.details.append(label("Перезапустите процесс шлюза, чтобы продолжить восстановление.", "dim-label"));
    }
    if (samples && !progress?.active) {
      const match = Boolean(progress?.operation_id && samples.operation_id === progress.operation_id);
      if (match) {
        sampleRows(this.details, "До обновления", samples.before, this.openTask);
        sampleRows(this.details, "После обновления", samples.after, this.openTask);
      }
      this.raw.set_label(match ? "Запись замеров JSON" : "Запись замеров JSON без привязки к этой попытке");
      const text = JSON.stringify(samples, null, 2);
      if (text !== this.rawText.get_label()) this.rawText.set_label(text);
      this.details.append(this.raw);
    }
    return true;
  }
}
