import { readProject, type Project } from "./project-directory.js";
import { type Gateway } from "./gateway.js";
import { Adw, Gio, Gtk, Pango } from "./gi.js";
import { chrome, chromeText, watchNativeI18n } from "./native-i18n.js";
import { object } from "./settings-write.js";
import { button, clear, column, errorText, label, sheet } from "./ui.js";

/** Published registry facts; historical provenance never implies live Git state. */
export class ProjectFacts {
  readonly widget = column(4);
  private value?: unknown;
  private readonly unwatch = watchNativeI18n(() => this.render());
  update(value?: unknown): void { this.value = value; this.render(); }
  close(): void { this.unwatch(); }
  private render(): void {
    clear(this.widget);this.widget.set_visible(this.value !== undefined);
    if (this.value === undefined) return;
    const data = object(this.value);let malformed = false;
    const line = (english: string, russian: string, value: string) => {
      const field = label(`${chromeText(english, undefined, russian)} · ${value}`);
      field.set_selectable(true);field.set_wrap_mode(Pango.WrapMode.WORD_CHAR);field.set_max_width_chars(64);this.widget.append(field);
    };
    const fields = (raw: Record<string, unknown>, names: readonly (readonly [string, string, string])[]) => {
      for (const [key, english, russian] of names) if (raw[key] != null) {
        if (typeof raw[key] !== "string") { malformed = true;continue; }
        if (raw[key]) line(english, russian, raw[key]);
      }
    };
    fields(data, [["id", "Project ID", "ID проекта"], ["name", "Project name", "Название"],
      ["origin", "Registration origin", "Источник регистрации"], ["created_at", "Registered at", "Зарегистрирован"],
      ["last_active_at", "Published last activity", "Опубликованная последняя активность"],
      ["clone_url", "Clone URL at registration", "URL при клонировании"], ["trusted_at", "Recorded trust time", "Записанное время доверия"],
      ["lifecycle", "Registry lifecycle", "Состояние записи реестра"], ["delete_error", "Deletion error", "Ошибка удаления"],
      ["routing_incarnation", "Routing incarnation", "Экземпляр маршрутизации"], ["last_task_result_id", "Last recorded task result", "Последний записанный результат задачи"]]);
    if (typeof data.working_dir === "string") line("Registered workspace path", "Путь рабочей папки в реестре", data.working_dir || chromeText("No workspace assigned", undefined, "Папка не назначена"));
    else if (data.working_dir != null) malformed = true;
    if (data.provenance != null) {
      const origins: Record<string, [string, string]> = { attached: ["Attached directory", "Подключённая папка"],
        cloned: ["Cloned repository", "Клонированный репозиторий"], genesis: ["Provisioned workspace", "Созданная рабочая папка"],
        none: ["Registered without a workspace", "Регистрация без рабочей папки"] };
      if (typeof data.provenance !== "string") malformed = true;
      else {
        const known = Object.hasOwn(origins, data.provenance) ? origins[data.provenance] : undefined;
        line("Historical workspace provenance", "Историческое происхождение папки", known ? chromeText(known[0], undefined, known[1]) : data.provenance || chromeText("Not published", undefined, "Не опубликовано"));
      }
    }
    for (const [key, english, russian] of [["chat_id", "Project room", "Комната проекта"], ["routing_generation", "Routing generation", "Поколение маршрутизации"], ["visible_revision", "Visible revision", "Видимая ревизия"]] as const) if (data[key] != null) {
      const value = data[key];if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) line(english, russian, String(value));else malformed = true;
    }
    for (const [key, english, russian] of [["pinned", "Pinned", "Закреплён"], ["has_thread_activity", "Published thread activity flag", "Опубликованный признак активности комнаты"],
      ["thread_activity_seen", "Retained historical activity flag", "Сохранённый исторический признак активности"], ["created", "Created by this operation", "Создан этой операцией"]] as const) if (data[key] != null) {
      if (typeof data[key] === "boolean") line(english, russian, data[key] ? chromeText("Yes", undefined, "Да") : chromeText("No", undefined, "Нет"));else malformed = true;
    }
    line("Closed by a separate decision", "Закрыт отдельным решением", data.closed != null ? chromeText("Yes", undefined, "Да") : chromeText("No", undefined, "Нет"));
    if (data.closed != null) {
      if (!data.closed || typeof data.closed !== "object" || Array.isArray(data.closed)) malformed = true;
      else {
        const closure = object(data.closed);
        if (["at", "by", "note"].some(key => typeof closure[key] !== "string")) malformed = true;
        fields(closure, [["at", "Closed at", "Закрыт"], ["by", "Closure author", "Автор закрытия"], ["note", "Closure note", "Примечание о закрытии"]]);
      }
    }
    const notice = label(chromeText("Registry provenance is historical; it does not confirm the current Git checkout or workspace availability.", undefined,
      "Происхождение записано в реестре; оно не подтверждает текущий Git checkout или доступность папки."), "dim-label");
    this.widget.append(notice);
    if (malformed) this.widget.append(label(chromeText("Some published project facts could not be read.", undefined, "Часть опубликованных сведений о проекте прочитать не удалось."), "warning"));
  }
}

/** An addressed, read-only refresh of the selected immutable project binding. */
export class ProjectDetails {
  private readonly content = column();
  readonly dialog = sheet("Сведения о проекте", this.content);
  private readonly facts = new ProjectFacts();
  private receiptFacts?: ProjectFacts;
  private readonly status = label("");
  private readonly refreshButton = button("Перечитать сведения", () => { if (!this.closed) void this.refresh(); });
  private reading?: any;
  private generation = 0;
  private closed = false;
  private parentSignal = 0;
  constructor(private readonly parent: any, private readonly gateway: Gateway, private readonly identity: Project, receipt?: Project) {
    chrome(this.dialog, "title", "Project details");chrome(this.refreshButton, "label", "Refresh project details");
    this.status.set_selectable(true);this.content.append(this.status);this.content.append(this.facts.widget);this.content.append(this.refreshButton);
    if (receipt && receipt.id === identity.id && receipt.chat_id === identity.chat_id) {
      this.receiptFacts = new ProjectFacts();this.receiptFacts.update(receipt);
      this.content.append(new Gtk.Expander({ label: "Последний полученный ответ создания/изменения", child: this.receiptFacts.widget }));
      this.content.append(label("Это сохранённая квитанция текущего окна; актуальная запись читается отдельно.", "dim-label"));
    }
    this.dialog.connect("closed", () => this.close());
    if (parent instanceof Gtk.Window || parent instanceof Adw.Dialog) this.parentSignal = parent.connect(parent instanceof Gtk.Window ? "close-request" : "closed", () => { this.dialog.force_close();this.close();return false; });
    void this.refresh();
  }
  get projectId(): string { return this.identity.id; }
  async refresh(): Promise<void> {
    if (this.closed) return;
    const version = ++this.generation;this.reading?.cancel();const cancel = new Gio.Cancellable();this.reading = cancel;
    this.refreshButton.set_sensitive(false);this.status.set_label("Читаю актуальную запись проекта…");
    try {
      const project = await readProject(this.gateway, { id: this.identity.id }, cancel);
      if (this.closed || version !== this.generation) return;
      if (project && project.chat_id !== this.identity.chat_id) throw new Error("Шлюз вернул другую привязку комнаты проекта.");
      this.facts.update(project);
      this.status.set_label(project ? "Сведения опубликованы текущим ответом шлюза." : "Проект отсутствует в текущем ответе шлюза.");
    } catch (error) {
      if (!this.closed && version === this.generation) this.status.set_label(`Свежие сведения не подтверждены. Показанные данные могут быть устаревшими. ${errorText(error)}`);
    } finally { if (!this.closed && version === this.generation) { this.reading = undefined;this.refreshButton.set_sensitive(true); } }
  }
  close(): void {
    if (this.closed) return;this.closed = true;++this.generation;this.reading?.cancel();this.facts.close();this.receiptFacts?.close();this.refreshButton.set_sensitive(false);
    if (this.parentSignal) this.parent.disconnect(this.parentSignal);this.parentSignal = 0;
  }
}
