import { Gio, GLib, Gtk } from "./gi.js";
import { type Gateway, query } from "./gateway.js";
import { renderCostDashboard, usd } from "./cost-view.js";
import { button, clear, column, errorText, label, row } from "./ui.js";

type Document = Record<string, unknown>;
const streams = ["events", "chat", "progress", "tools", "supervisor"];

function record(value: unknown): Document {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Document : {};
}

function records(value: unknown): Document[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "";
}

function selectable(text: string): any {
  const widget = label(text);
  widget.set_selectable(true);
  return widget;
}

function lines(values: [string, unknown][]): string {
  return values.filter(([, value]) => value != null && value !== "").map(([name, value]) => `${name} · ${text(value)}`).join("\n");
}

function details(parent: any, title: string, value: string): void {
  const widget = new Gtk.Expander({ label: title });
  widget.set_child(selectable(value));
  parent.append(widget);
}

function scroll(widget: any): any {
  return new Gtk.ScrolledWindow({ child: widget, vexpand: true, hscrollbar_policy: Gtk.PolicyType.NEVER });
}

export class Diagnostics {
  readonly logs = column();
  readonly cost = column();
  readonly versions = column();
  private readonly stream = Gtk.DropDown.new_from_strings(streams);
  private readonly task = new Gtk.Entry({ hexpand: true, placeholder_text: "ID задачи (фильтр)" });
  private readonly limit = Gtk.SpinButton.new_with_range(1, 2000, 1);
  private readonly automatic = new Gtk.CheckButton({ label: "Автообновление", active: true });
  private readonly logView = new Gtk.TextView({ monospace: true, editable: false, wrap_mode: Gtk.WrapMode.WORD_CHAR });
  private readonly logStatus = label("", "dim-label");
  private readonly logScroll = scroll(this.logView);
  private readonly costStatus = label("", "dim-label");
  private readonly costBody = column();
  private readonly versionsStatus = label("", "dim-label");
  private readonly versionsBody = column();
  private readonly gitBody = column();
  private readonly gitStatus = label("", "dim-label");
  private readonly cancel = new Gio.Cancellable();
  private logCancel?: any;
  private costCancel?: any;
  private hasCost = false;
  private readonly remeasure: any;
  private logTimer = 0;
  private logSequence = 0;
  private costSequence = 0;
  private readingLogs = false;
  private readingVersions = false;
  private versionsRunning = false;
  private versionSnapshot?: string;
  private gitSnapshot?: string;
  private previousLog = "";
  private previousLogKey = "";
  private taskFilter = "";
  private disposed = false;

  constructor(private readonly gateway: Gateway, private readonly openTask: (id: string) => void) {
    const filters = row();
    this.limit.set_value(100);
    this.limit.set_tooltip_text("Количество строк");
    const applyFilter = () => {
      this.taskFilter = this.task.get_text().trim();
      void this.readLogs();
    };
    for (const item of [this.stream, this.task, this.limit, button("Прочитать", applyFilter)]) filters.append(item);
    this.task.connect("activate", applyFilter);
    this.stream.connect("notify::selected", () => void this.readLogs());
    this.limit.connect("value-changed", () => this.scheduleLogs());
    for (const item of [filters, this.automatic, this.logStatus, this.logScroll]) this.logs.append(item);

    this.cost.append(button("Обновить расходы", () => void this.readCost()));
    this.cost.append(this.costStatus);
    this.cost.append(scroll(this.costBody));
    this.remeasure = button("Пересчитать историю версий", () => void this.readVersions(true));
    this.versions.append(this.remeasure);
    this.versions.append(this.versionsStatus);
    const history = column();
    history.append(this.versionsBody);
    history.append(this.gitStatus);
    history.append(this.gitBody);
    this.versions.append(scroll(history));
  }

  close(): void {
    this.disposed = true;
    this.cancel.cancel();
    this.logCancel?.cancel();
    this.costCancel?.cancel();
    this.readingLogs = this.readingVersions = false;
    this.cancelLogTimer();
  }

  suspendLogs(): void { this.cancelLogTimer(); }

  refresh(view: string): Promise<void> {
    if (view === "logs") return this.readLogs();
    if (view === "cost") return this.readCost();
    if (view === "versions") return this.readVersions();
    return Promise.resolve();
  }

  tick(view: string): void {
    if (view === "logs" && this.automatic.get_active() && !this.readingLogs) void this.readLogs();
    if (view === "versions" && this.versionsRunning && !this.readingVersions) void this.readVersions();
  }

  onLog(): void {
    if (this.automatic.get_active() && this.stream.get_selected() === 0 && !this.readingLogs) this.scheduleLogs();
  }

  private scheduleLogs(): void {
    if (this.disposed || this.logTimer) return;
    this.logTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
      this.logTimer = 0;
      void this.readLogs();
      return GLib.SOURCE_REMOVE;
    });
  }

  private cancelLogTimer(): void {
    if (this.logTimer) GLib.Source.remove(this.logTimer);
    this.logTimer = 0;
  }

  private async readLogs(): Promise<void> {
    if (this.disposed) return;
    this.cancelLogTimer();
    const seq = ++this.logSequence;
    this.logCancel?.cancel();
    const cancel = this.logCancel = new Gio.Cancellable();
    const name = streams[this.stream.get_selected()] ?? "events";
    const filters = query({ limit: this.limit.get_value_as_int(), task_id: this.taskFilter || undefined });
    const key = name + filters;
    this.readingLogs = true;
    if (key !== this.previousLogKey) {
      this.previousLog = "";
      this.logView.get_buffer().set_text("", -1);
    }
    this.logStatus.set_label("Читаю журнал…");
    try {
      const result = await this.gateway.json<{ entries?: Document[] }>("GET", "/api/logs/" + key, undefined, undefined, false, cancel);
      if (this.disposed || seq !== this.logSequence) return;
      if (!Array.isArray(result?.entries) || result.entries.some(entry => !entry || typeof entry !== "object" || Array.isArray(entry))) throw new Error("Шлюз не вернул строки журнала.");
      const output = result.entries.map((entry) => JSON.stringify(entry)).join("\n");
      const adjustment = this.logScroll.get_vadjustment();
      const bottom = adjustment.get_upper() - adjustment.get_page_size();
      const follow = key !== this.previousLogKey || bottom - adjustment.get_value() < 32;
      if (output !== this.previousLog) {
        this.logView.get_buffer().set_text(output, -1);
        if (follow) this.logView.add_tick_callback(() => {
          if (!this.disposed && seq === this.logSequence) adjustment.set_value(adjustment.get_upper() - adjustment.get_page_size());
          return GLib.SOURCE_REMOVE;
        });
      }
      this.previousLog = output;
      this.previousLogKey = key;
      this.logStatus.set_label(result.entries.length ? `Строк в выборке: ${result.entries.length}` : "В выборке нет строк.");
    } catch (error) {
      if (!this.disposed && seq === this.logSequence) this.logStatus.set_label(
        key === this.previousLogKey && this.previousLog ? `Показана последняя прочитанная выборка. ${errorText(error)}` : errorText(error));
    } finally {
      if (seq === this.logSequence) this.readingLogs = false;
    }
  }

  private async readCost(): Promise<void> {
    if (this.disposed) return;
    const seq = ++this.costSequence;
    this.costCancel?.cancel();
    const cancel = this.costCancel = new Gio.Cancellable();
    this.costStatus.set_label("Читаю учёт расходов…");
    try {
      const result = await this.gateway.json<Document>("GET", "/api/cost-breakdown", undefined, undefined, false, cancel);
      if (this.disposed || seq !== this.costSequence) return;
      if (result !== record(result) || result.error || (result.accounting === undefined
        ? typeof result.total_cost !== "number" : result.accounting !== record(result.accounting))) {
        throw new Error("Шлюз не подтвердил структуру учёта расходов.");
      }
      this.costStatus.set_label(renderCostDashboard(this.costBody, result));
      this.hasCost = true;
    } catch (error) {
      if (!this.disposed && seq === this.costSequence) {
        this.costStatus.set_label(`${this.hasCost ? "Показан последний прочитанный учёт. " : ""}Текущие расходы неизвестны. ${errorText(error)}`);
      }
    }
  }

  private async readVersions(force = false): Promise<void> {
    if (this.disposed || this.readingVersions) return;
    this.readingVersions = true;
    this.remeasure.set_sensitive(false);
    const [history, git] = await Promise.allSettled([
      this.gateway.json<Document>("GET", "/api/evolution-data" + query({ force: force ? 1 : undefined }), undefined, undefined, false, this.cancel).then(result => {
        if (result !== record(result) || result.error || (!Array.isArray(result.versions) && !Array.isArray(result.points))
          || (Array.isArray(result.versions) ? result.versions : result.points as unknown[]).some(item => item !== record(item))) {
          throw new Error("Шлюз не подтвердил историю версий.");
        }
        return result;
      }),
      this.gateway.json<Document>("GET", "/api/git/log", undefined, undefined, false, this.cancel).then(result => {
        if (result !== record(result) || result.error || !Array.isArray(result.commits) || !Array.isArray(result.tags)
          || [...result.commits, ...result.tags].some(item => item !== record(item))) throw new Error("Шлюз не подтвердил историю Git.");
        return result;
      }),
    ]);
    if (this.disposed) return;
    this.readingVersions = false;
    if (history.status === "fulfilled") {
      const result = history.value;
      const status = record(result.refresh);
      this.versionsRunning = status.state === "running";
      this.versionsStatus.set_label(this.versionsRunning ? (result.saved_at
        ? "Пересчёт выполняется. Показана сохранённая история." : "Выполняется первый замер версий.")
        : status.state === "failed" ? `Пересчёт не завершился. ${text(status.error)}` : "История версий шлюза.");
      const key = JSON.stringify([result.saved_at, result.versions, result.points, result.install, result.checkpoints,
        status.unmeasured, status.unmeasured_error]);
      if (key !== this.versionSnapshot) {
        this.versionSnapshot = key;
        this.renderVersions(result, status);
      }
    } else {
      const previous = this.versionSnapshot ? "Показана последняя прочитанная история. " : "";
      this.versionsStatus.set_label(previous + errorText(history.reason));
    }
    if (git.status === "fulfilled") {
      this.gitStatus.set_label("");
      const value = git.value;
      const key = JSON.stringify(value);
      if (key !== this.gitSnapshot) {
        this.gitSnapshot = key;
        clear(this.gitBody);
        details(this.gitBody, "Git · текущая версия и коммиты", [
          lines([["Ветка", value.branch], ["Коммит", value.sha]]),
          ...records(value.commits).map((item) => [text(item.sha ?? item.hash), text(item.date), text(item.message ?? item.subject)].filter(Boolean).join(" · ")),
        ].filter(Boolean).join("\n"));
        const tags = records(value.tags).map((item) => [text(item.tag), text(item.date), text(item.sha), text(item.message)].filter(Boolean).join(" · "));
        if (tags.length) details(this.gitBody, "Теги Git", tags.join("\n"));
      }
    } else {
      this.gitStatus.set_label(`${this.gitSnapshot ? "Показана последняя прочитанная история Git. " : ""}${errorText(git.reason)}`);
    }
    this.remeasure.set_sensitive(!this.versionsRunning || history.status === "rejected");
  }

  private renderVersions(result: Document, status: Document): void {
    clear(this.versionsBody);
    this.versionsBody.append(selectable(lines([["Сохранено", result.saved_at], ["Версии без замера", status.unmeasured],
      ["Причина", status.unmeasured_error]])));
    const modern = Array.isArray(result.versions);
    const versions = records(modern ? result.versions : result.points);
    const install = record(result.install);
    const measurement = (kind: string, index: number) => {
      const samples = record(install[kind]).at_versions;
      return Array.isArray(samples) ? samples[index] ?? "нет наблюдения" : undefined;
    };
    for (let index = versions.length - 1; index >= 0; index--) {
      const version = versions[index]!;
      const release = record(version.release);
      const name = text(version.tag ?? version.version) || "Версия";
      details(this.versionsBody, [name, text(version.date), version.milestone === true ? "Веха" : ""].filter(Boolean).join(" · "), lines([
        ["Коммит", version.commit], ["Уровень", version.level], ["Другие теги", Array.isArray(version.aliases) ? version.aliases.join(", ") : undefined],
        ["Строки Python", version.code_lines ?? "не измерено"],
        ["Байт в BIBLE", modern ? version.bible_bytes ?? "не измерено" : undefined],
        ["Байт в системном промпте", modern ? version.system_bytes ?? "не измерено" : undefined],
        ["KiB в BIBLE", version.bible_kb], ["KiB в системном промпте", version.system_kb],
        ["Символы в identity.md", measurement("identity", index)], ["Символы в блокноте", measurement("scratchpad", index)],
        ["Источник описания", release.source], ["Тип изменения", release.kind],
        ["Название", release.title], ["Заголовок", release.heading], ["Текст релиза", release.body],
      ]));
    }
    for (const [kind, value] of Object.entries(install)) {
      const journal = record(value);
      const latest = record(journal.latest);
      details(this.versionsBody, kind, lines([["Первая запись", journal.first_at], ["Последняя запись", latest.at], ["Символы", latest.chars]]));
    }
    if (!Array.isArray(result.checkpoints)) return;
    const checkpoints = records(result.checkpoints);
    const group = new Gtk.Expander({ label: `Последние контрольные точки саморазвития · ${checkpoints.length}` });
    const list = column();
    if (!checkpoints.length) list.append(label("Шлюз не вернул контрольных точек.", "dim-label"));
    for (const checkpoint of checkpoints.toReversed()) {
      const id = text(checkpoint.task_id);
      const transaction = record(checkpoint.transaction);
      const execution = record(record(checkpoint.outcome_axes).execution);
      const checkpointBody = column();
      checkpointBody.append(selectable(lines([
        ["Цель кампании", checkpoint.campaign_objective], ["ID кампании", checkpoint.campaign_id],
        ["Выполнение", execution.status], ["Исход цикла на момент записи", transaction.cycle_outcome],
        ["Коммит", transaction.commit_sha || checkpoint.git_sha], ["Раунды", checkpoint.rounds],
        ["Стоимость", checkpoint.cost_usd == null && checkpoint.cost_accounting_status === "unavailable"
          ? "учёт недоступен" : checkpoint.cost_usd == null ? undefined : usd(checkpoint.cost_usd)],
      ])));
      if (id) checkpointBody.append(button("Открыть задачу", () => { if (!this.disposed) this.openTask(id); }));
      details(checkpointBody, "Запись шлюза", JSON.stringify(checkpoint, null, 2));
      const entry = new Gtk.Expander({ label: [text(checkpoint.ts), id].filter(Boolean).join(" · ") || "Контрольная точка" });
      entry.set_child(checkpointBody);
      list.append(entry);
    }
    group.set_child(list);
    this.versionsBody.append(group);
  }
}
