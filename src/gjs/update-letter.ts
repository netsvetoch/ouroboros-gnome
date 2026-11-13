import { GLib, Gtk } from "./gi.js";
import { markdownView } from "./markdown-view.js";
import { type UpdateEvidence, type UpdateRange as Range, updateEvidence } from "./update-evidence.js";
import { button, column, label } from "./ui.js";

export type LetterMode = "write" | "rewrite";
type ExactRange = Required<Range>;

export interface LetterRequest {
  task_id?: string;
  current_task_id?: string;
  status?: string;
  mode?: string;
  key?: Range;
  requested_at?: string;
  saved?: boolean;
}

export interface Letter {
  key?: Range;
  checked_key?: Range | null;
  text?: string;
  state?: string;
  relation?: string;
  description_current?: boolean;
  author_version?: string;
  target_version?: string;
  written_at?: string;
  revision?: number;
  author?: { task_id?: string; model?: string; requested?: boolean };
  material?: {
    key?: Range;
    collected_at?: string;
    commits?: number;
    bodies_read?: number;
    bodies_omitted?: number;
    text_bytes?: number;
  } | null;
  qualification?: UpdateEvidence | null;
  error_kind?: string;
  error_text?: string;
  failed_at?: string;
  latest_failed_key?: Range | null;
  request?: LetterRequest | null;
}

const live = new Set(["requested", "scheduled", "running", "interrupted", "cancel_requested"]);
const requestStates: Record<string, string> = {
  requested: "запрошена", scheduled: "в очереди", running: "выполняется", interrupted: "прервана",
  cancel_requested: "запрошена остановка", completed: "завершена", failed: "завершилась с ошибкой", cancelled: "отменена",
  missing: "результат задачи отсутствует", unknown: "состояние неизвестно",
};

export function pinned<T extends Range>(value?: T | null): value is T & ExactRange {
  return typeof value?.base_sha === "string" && Boolean(value.base_sha)
    && typeof value.target_sha === "string" && Boolean(value.target_sha);
}

export function sameRange(left?: Range | null, right?: Range | null): boolean {
  return pinned(left) && pinned(right) && left.base_sha === right.base_sha && left.target_sha === right.target_sha;
}

export function letterInProgress(request?: LetterRequest | null): boolean {
  return Boolean(request?.status && live.has(request.status));
}

export function letterAction(letter?: Letter | null): { mode: LetterMode; range: ExactRange } | undefined {
  const range = pinned(letter?.checked_key) ? letter.checked_key : undefined;
  if (range && range.base_sha !== range.target_sha) {
    return { mode: letter?.text && sameRange(letter.key, range) ? "rewrite" : "write", range };
  }
  if (letter?.text && pinned(letter.key)) return { mode: "rewrite", range: letter.key };
  return undefined;
}

function line(container: any, text?: string): void {
  if (!text) return;
  const widget = label(text);
  widget.set_selectable(true);
  container.append(widget);
}

function rangeRows(container: any, range?: Range | null): void {
  if (!pinned(range)) return;
  line(container, `Исходный коммит · ${range.base_sha}`);
  line(container, `Целевой коммит · ${range.target_sha}`);
}

export function letterContent(letter: Letter, openTask: (id: string) => void, base?: string): any {
  const content = column(6);
  rangeRows(content, letter.key);
  if (letter.target_version) line(content, `Версия обновления · ${letter.target_version}`);
  if (letter.author_version) line(content, `Версия Ouroboros при написании · ${letter.author_version}`);
  if (letter.written_at) line(content, `Сохранено · ${letter.written_at}`);
  const author = letter.author;
  if (author?.model) line(content, `Модель автора · ${author.model}`);
  if (author?.requested === true) line(content, "Написано по запросу владельца.");
  const task = author?.task_id;
  if (task) {
    line(content, `Задача автора · ${task}`);
    content.append(button("Открыть задачу автора", () => openTask(task)));
  }
  if (letter.text) content.append(markdownView(letter.text, base));
  return new Gtk.Expander({
    label: letter.relation === "applied" ? "Что изменилось в установленной версии" : "Описание изменений", child: content,
  });
}

export function letterSources(letter: Letter): any {
  const content = column(6);
  if (typeof letter.revision === "number") line(content, `Ревизия записи шлюза · ${letter.revision}`);
  const material = letter.material;
  const checked = letter.checked_key;
  if (material && pinned(material.key)) {
    const details = column(6);
    rangeRows(details, material.key);
    if (material.collected_at) line(details, `Собраны · ${material.collected_at}`);
    const counts: [string, number | undefined][] = [
      ["Коммитов в материалах", material.commits], ["Текстов коммитов прочитано", material.bodies_read],
      ["Текстов коммитов пропущено", material.bodies_omitted],
    ];
    for (const [name, count] of counts) if (typeof count === "number") line(details, `${name} · ${count}`);
    if (typeof material.text_bytes === "number" && Number.isFinite(material.text_bytes) && material.text_bytes >= 0) {
      line(details, `Размер текста материалов · ${GLib.format_size(material.text_bytes)}`);
    }
    content.append(new Gtk.Expander({ label: sameRange(checked, material.key)
      ? "Материалы проверенного диапазона" : "Сохранённые материалы другого диапазона", child: details }));
  }
  const evidence = letter.qualification;
  if (pinned(evidence)) content.append(updateEvidence(evidence, evidence, sameRange(checked, evidence)
    ? "Результаты для проверенного диапазона" : "Сохранённые проверки другого диапазона"));
  return content;
}

export function letterRequestView(request: LetterRequest, openTask: (id: string) => void): any {
  const content = column(6);
  content.append(label("Задача описания обновления", "heading"));
  const status = request.status || "unknown";
  line(content, `Состояние задачи · ${Object.hasOwn(requestStates, status) ? requestStates[status] : status}`);
  if (request.requested_at) line(content, `Запрошено · ${request.requested_at}`);
  rangeRows(content, request.key);
  const working = letterInProgress(request);
  if (request.saved) line(content, working ? "Описание уже сохранено. Задача ещё выполняется." : "Задача сохранила описание.");
  else line(content, working ? "Ожидается сохранение описания."
    : status === "unknown" || status === "missing" ? "Сохранение описания этой задачей не подтверждено." : "Задача завершилась без сохранения описания.");
  const task = request.current_task_id || request.task_id;
  if (task) content.append(button("Открыть задачу описания", () => openTask(task)));
  return content;
}

export function letterFailure(letter: Letter, range?: Range): any | undefined {
  if (!letter.error_kind && !letter.error_text && letter.state !== "failed") return undefined;
  if (pinned(letter.latest_failed_key) && !sameRange(letter.latest_failed_key, range)) return undefined;
  const content = column(6);
  line(content, letter.text ? "Подготовка описания не удалась. Предыдущий текст сохранён." : "Подготовка описания не удалась.");
  rangeRows(content, letter.latest_failed_key);
  line(content, [letter.failed_at, letter.error_kind, letter.error_text].filter(Boolean).join(" · "));
  return content;
}
