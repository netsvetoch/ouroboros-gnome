import type { Room } from "./chat.js";
import { Adw, Gtk } from "./gi.js";
import { object } from "./settings-write.js";
import { column, label } from "./ui.js";

import { chrome, chromeText, watchNativeI18n } from "./native-i18n.js";

export type LaunchBody = Record<string, unknown> & { task_id: string; description: string; metadata: Record<string, unknown> };
export interface LaunchAttachment { path: string; label?: string }
export const submissionKey = "gnome_submission_id";

type FieldKind = "text" | "integer" | "seconds" | "map" | "claims" | "mappings" | "lines" | "multiline";
type Field = [key: string, title: string, kind?: FieldKind];

const titles: Record<string, string> = {
  "Запросить документы о собственном устройстве агента": "Request agent self-description documents",
  "Запускать только со всеми вложениями": "Require all attachments",
  "Название": "Title",
  "Описание задачи": "Task description",
  "Контекст": "Context",
  "Ожидаемый результат": "Expected output",
  "Ограничения": "Constraints",
  "Рабочая папка, память и лимиты": "Workspace, memory and limits",
  "Рабочая папка на шлюзе": "Gateway workspace",
  "Выбрать папку на шлюзе…": "Choose gateway folder…",
  "Режим рабочей папки": "Workspace mode",
  "Срок ISO 8601 с часовым поясом": "ISO 8601 deadline with time zone",
  "Секунд от отправки, включая очередь": "Seconds from submission, including queue",
  "Секунд выполнения, без очереди и пауз": "Execution seconds, excluding queue and pauses",
  "Память": "Memory",
  "Начальное усилие": "Starting effort",
  "Вложения": "Attachments",
  "Политики и приёмка": "Policies and acceptance",
  "Разрешённые ресурсы · объект JSON": "Allowed resources · JSON object",
  "Политика ресурсов · объект JSON": "Resource policy · JSON object",
  "Критерии приёмки · массив объектов JSON": "Acceptance claims · JSON object array",
  "Отключённые инструменты · по одному на строку": "Disabled tools · one per line",
  "Формат ответа": "Answer format",
  "Сервисы после завершения": "Services after completion",
  "Исполнитель": "Executor",
  "Тип исполнителя": "Executor type",
  "Идентификатор исполнителя": "Executor ID",
  "Имя контейнера Docker": "Docker container name",
  "Путь рабочей папки на хосте": "Host workspace path",
  "Путь у исполнителя": "Executor workspace path",
  "Соответствия путей · массив объектов JSON": "Path mappings · JSON object array",
  "Сеть исполнителя": "Executor network",
  "Маршрут и идентификаторы": "Routing and identifiers",
  "Номер чата (пусто — по назначению)": "Chat ID (blank to use destination)",
  "Идентификатор проекта": "Project ID",
  "Идентификатор задачи (автоматический, если пусто)": "Task ID (automatic if blank)",
  "Тип задачи": "Task type",
  "Глубина": "Depth",
  "Идентификатор сеанса": "Session ID",
  "Идентификатор инициатора": "Actor ID",
  "Источник запроса": "Request source",
  "Дополнительные данные · объект JSON": "Metadata · JSON object"
};
const captions: Record<string, string> = { "По умолчанию":"Default", "Общая":"Shared", "Копия":"Forked", "Пустая":"Empty", "Итог в отдельной строке":"Final answer line", "Остановить":"Stop", "Оставить":"Keep", "Локальный":"Local", "Docker":"Docker", "Сеть хоста":"Host network", "Без сети":"No network", none:"None", minimal:"Minimal", low:"Low", medium:"Medium", high:"High", xhigh:"Extra high", max:"Maximum", ultra:"Ultra" };
function titleChrome<T>(widget: T, property: string, title: string): T {
  return Object.hasOwn(titles, title) ? chrome(widget, property, titles[title]) : widget;
}
function fieldTitle(title: string): string {
  return Object.hasOwn(titles, title) ? chromeText(titles[title], undefined, title) : title;
}

function block(title: string): { panel: any; content: any } {
  const content = column(8);
  return { panel: titleChrome(new Gtk.Expander({ label: title, child: content }), "label", title), content };
}

function numberValue(raw: string, title: string, whole: boolean): number {
  const value = Number(raw.replace(",", "."));
  if (!/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:[eE][+-]?\d+)?$/u.test(raw) || !Number.isFinite(value) || (whole && !Number.isSafeInteger(value))) {
    throw new Error(`${title} · укажите ${whole ? "целое число" : "число секунд"}.`);
  }
  if (!whole && value < 0) throw new Error(`${title} · укажите неотрицательное число.`);
  return value;
}

function structured(raw: string, title: string, kind: "map" | "claims" | "mappings"): unknown {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error(`${title} · проверьте синтаксис JSON.`); }
  const document = (item: unknown) => Boolean(item && typeof item === "object" && !Array.isArray(item));
  if (kind === "map" ? !document(value) : !Array.isArray(value) || value.some((item) => !document(item))) {
    throw new Error(`${title} · требуется ${kind === "map" ? "объект JSON" : "массив объектов JSON"}.`);
  }
  if (kind === "mappings" && (value as Record<string, unknown>[]).some((item) =>
    typeof item.host_path !== "string" || typeof item.backend_path !== "string"
    || Object.values(item).some((part) => typeof part !== "string"))) {
    throw new Error("В каждой записи путей исполнителя нужны строки host_path и backend_path.");
  }
  return value;
}

export class TaskLaunchFields {
  readonly widget = column(10);
  readonly attachments = column(6);
  private readonly fields = new Map<string, { title: string; kind: FieldKind; get: () => string; set: (value: string) => void }>();
  private readonly options = new Map<string, { widget: any; values: string[] }>();
  private readonly ownBody = titleChrome(new Adw.SwitchRow({ title: "Запросить документы о собственном устройстве агента" }), "title", "Запросить документы о собственном устройстве агента");
  private readonly atomic = titleChrome(new Adw.SwitchRow({ title: "Запускать только со всеми вложениями" }), "title", "Запускать только со всеми вложениями");
  private readonly executor = column(8);
  private disposed = false;
  private painting = false;
  private readonly stops: (() => void)[] = [];

  constructor(private readonly room: Room, browse: (initial: string, select: (path: string) => void) => void) {
    this.add(this.widget, [["title", "Название"], ["description", "Описание задачи", "multiline"],
      ["context", "Контекст", "multiline"], ["expected_output", "Ожидаемый результат", "multiline"], ["constraints", "Ограничения", "multiline"]]);
    const runtime = block("Рабочая папка, память и лимиты");
    this.add(runtime.content, [["workspace_root", "Рабочая папка на шлюзе"]]);
    const picker = titleChrome(new Gtk.Button({ label: "Выбрать папку на шлюзе…", halign: Gtk.Align.START }), "label", "Выбрать папку на шлюзе…");
    picker.connect("clicked", () => {
      if (this.disposed) return;
      const path = this.fields.get("workspace_root")!;
      browse(path.get().trim(), path.set);
    });
    runtime.content.append(picker);
    this.add(runtime.content, [["workspace_mode", "Режим рабочей папки"], ["deadline_at", "Срок ISO 8601 с часовым поясом"],
      ["timeout_sec", "Секунд от отправки, включая очередь", "seconds"], ["execution_timeout_sec", "Секунд выполнения, без очереди и пауз", "seconds"]]);
    this.select(runtime.content, "memory_mode", "Память", [["", "По умолчанию"], ["shared", "Общая"], ["forked", "Копия"], ["empty", "Пустая"]]);
    this.select(runtime.content, "reasoning_effort", "Начальное усилие", ["", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
      .map((value) => [value, value || "По умолчанию"]));
    this.widget.append(runtime.panel);

    const inputs = block("Вложения");
    const inputRules = new Adw.PreferencesGroup();
    inputRules.add(this.atomic);
    inputs.content.append(inputRules);
    inputs.content.append(this.attachments);
    this.widget.append(inputs.panel);

    const policies = block("Политики и приёмка");
    this.add(policies.content, [["allowed_resources", "Разрешённые ресурсы · объект JSON", "map"],
      ["resource_policy", "Политика ресурсов · объект JSON", "map"],
      ["acceptance_claims", "Критерии приёмки · массив объектов JSON", "claims"],
      ["disabled_tools", "Отключённые инструменты · по одному на строку", "lines"]]);
    this.select(policies.content, "answer_protocol", "Формат ответа", [["", "По умолчанию"], ["final_answer_line", "Итог в отдельной строке"]]);
    this.select(policies.content, "service_teardown", "Сервисы после завершения", [["", "По умолчанию"], ["stop", "Остановить"], ["keep", "Оставить"]]);
    const bodyRules = new Adw.PreferencesGroup();
    bodyRules.add(this.ownBody);
    policies.content.append(bodyRules);
    this.widget.append(policies.panel);

    const execution = block("Исполнитель");
    this.select(execution.content, "executor.type", "Тип исполнителя", [["", "По умолчанию"], ["local", "Локальный"], ["docker_exec", "Docker"]]);
    this.add(this.executor, [["executor.id", "Идентификатор исполнителя"], ["executor.container_name", "Имя контейнера Docker"],
      ["executor.workspace_host_path", "Путь рабочей папки на хосте"], ["executor.workspace_backend_path", "Путь у исполнителя"],
      ["executor.path_mappings", "Соответствия путей · массив объектов JSON", "mappings"]]);
    this.select(this.executor, "executor.network", "Сеть исполнителя", [["", "По умолчанию"], ["host", "Сеть хоста"], ["none", "Без сети"]]);
    this.executor.set_visible(false);
    this.options.get("executor.type")!.widget.connect("notify::selected", (widget: any) => { if (!this.disposed && !this.painting) this.executor.set_visible(widget.get_selected() > 0); });
    execution.content.append(this.executor);
    this.widget.append(execution.panel);

    const route = block("Маршрут и идентификаторы");
    this.add(route.content, [["chat_id", "Номер чата (пусто — по назначению)", "integer"], ["project_id", "Идентификатор проекта"],
      ["task_id", "Идентификатор задачи (автоматический, если пусто)"], ["type", "Тип задачи"], ["depth", "Глубина", "integer"],
      ["session_id", "Идентификатор сеанса"], ["actor_id", "Идентификатор инициатора"], ["source", "Источник запроса"],
      ["metadata", "Дополнительные данные · объект JSON", "map"]]);
    this.widget.append(route.panel);
    this.fields.get("chat_id")!.set(room.projectId ? String(room.chatId) : "");
    this.fields.get("project_id")!.set(room.projectId ?? "");
  }

  private add(target: any, descriptors: Field[]): void {
    for (const [key, title, kind = "text"] of descriptors) {
      const multiline = ["map", "claims", "mappings", "lines", "multiline"].includes(kind);
      if (multiline) {
        const editor = new Gtk.TextView({ wrap_mode: Gtk.WrapMode.WORD_CHAR, monospace: kind !== "multiline" });
        editor.set_name(`task-launch-${key}`);
        const buffer = editor.get_buffer();
        target.append(titleChrome(label(title), "label", title));
        const repaint = () => editor.update_property([Gtk.AccessibleProperty.LABEL], [fieldTitle(title)]);
        this.stops.push(watchNativeI18n(repaint)); repaint();
        target.append(new Gtk.ScrolledWindow({ child: editor, min_content_height: key === "description" ? 104 : 64 }));
        this.fields.set(key, { title, kind, get: () => buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false),
          set: (value) => buffer.set_text(value, -1) });
      } else {
        const group = new Adw.PreferencesGroup();
        const entry = titleChrome(new Adw.EntryRow({ title }), "title", title);
        entry.set_name(`task-launch-${key}`);
        group.add(entry);
        target.append(group);
        this.fields.set(key, { title, kind, get: () => entry.get_text(), set: (value) => entry.set_text(value) });
      }
    }
  }

  private select(target: any, key: string, title: string, choices: [string, string][]): void {
    const group = new Adw.PreferencesGroup();
    const model = Gtk.StringList.new(choices.map(([, caption]) => caption));
    const item = titleChrome(new Adw.ComboRow({ title, model }), "title", title);
    const repaint = () => {
      if (this.disposed) return;
      const selected = item.get_selected();
      this.painting = true;
      try {
        model.splice(0, model.get_n_items(), choices.map(([, caption]) => Object.hasOwn(captions, caption) ? chromeText(captions[caption], undefined, caption) : caption));
        item.set_selected(selected);
      } finally { this.painting = false; }
    };
    this.stops.push(watchNativeI18n(repaint)); repaint();
    group.add(item);
    target.append(group);
    this.options.set(key, { widget: item, values: choices.map(([value]) => value) });
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const stop of this.stops.splice(0)) stop();
  }

  restore(body: LaunchBody): void {
    if (this.disposed) return;
    const values: LaunchBody = { ...body, metadata: { ...body.metadata } };
    delete values.metadata[submissionKey];
    for (const [key, field] of this.fields) {
      const value = key.startsWith("executor.") ? object(body.executor_ref)[key.slice(9)] : values[key];
      field.set(Array.isArray(value) && field.kind === "lines" ? value.join("\n")
        : value && typeof value === "object" ? JSON.stringify(value, null, 2) : value == null ? "" : String(value));
    }
    for (const [key, { widget, values }] of this.options) {
      const value = key.startsWith("executor.") ? object(body.executor_ref)[key.slice(9)] : body[key];
      widget.set_selected(Math.max(0, values.indexOf(String(value ?? ""))));
    }
    this.atomic.set_active(body.allow_partial_attachments === false);
    this.ownBody.set_active(body.context_requires_self_body_docs === true);
  }

  request(id: string, submission: string, attachments: LaunchAttachment[]): LaunchBody {
    if (this.disposed) throw new Error("Редактор задачи закрыт.");
    const body: Record<string, unknown> = {};
    const executor: Record<string, unknown> = {};
    const activeExecutor = this.options.get("executor.type")!.widget.get_selected() > 0;
    for (const [key, { title, kind, get }] of this.fields) {
      // These task-contract fields are verbatim text in the gateway API.
      const entered = get();
      const raw = ["context", "expected_output", "constraints"].includes(key) ? entered : entered.trim();
      const child = key.startsWith("executor.");
      if (!raw || (child && !activeExecutor)) continue;
      const value = kind === "integer" || kind === "seconds" ? numberValue(raw, fieldTitle(title), kind === "integer")
        : kind === "map" || kind === "claims" || kind === "mappings" ? structured(raw, fieldTitle(title), kind)
          : kind === "lines" ? [...new Set(raw.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean))] : raw;
      if (child) executor[key.slice(9)] = value;
      else body[key] = value;
    }
    for (const [key, { widget, values }] of this.options) {
      const value = values[widget.get_selected()];
      if (!value) continue;
      if (key.startsWith("executor.")) {
        if (activeExecutor) executor[key.slice(9)] = value;
      } else body[key] = value;
    }
    if (!body.description) throw new Error("Опишите задачу.");
    if (typeof body.depth === "number" && body.depth < 0) throw new Error("Глубина задачи должна быть неотрицательной.");
    if (activeExecutor) {
      if (!body.workspace_root) throw new Error("Для выбранного исполнителя нужна рабочая папка на шлюзе.");
      if (executor.type === "docker_exec" && !executor.container_name) throw new Error("Укажите имя контейнера Docker.");
      body.executor_ref = executor;
    }
    if (body.workspace_root && body.memory_mode === "shared") throw new Error("Для внешней папки выберите копию или пустую память.");
    if (body.chat_id === undefined && !body.workspace_root && !body.project_id && this.room.chatId === 1) body.chat_id = 1;
    // The gateway's ABI calls its owner-UI address into Main "web".
    if (body.chat_id === 1 && !body.project_id && body.source === undefined) body.source = "web";
    if (attachments.length) body.attachments = attachments.map((item) => ({ ...item }));
    if (this.atomic.get_active()) body.allow_partial_attachments = false;
    if (this.ownBody.get_active()) body.context_requires_self_body_docs = true;
    return { ...body, task_id: String(body.task_id || id), description: String(body.description),
      metadata: { ...object(body.metadata), [submissionKey]: submission } };
  }
}
