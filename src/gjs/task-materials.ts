import { type DownloadIdentity, type Query, query } from "./gateway.js";
import { GLib, Gtk } from "./gi.js";
import { object } from "./settings-write.js";
import type { TaskReviews } from "./task-reviews.js";
import { button, column, label, row } from "./ui.js";

type Data = Record<string, unknown>;
type Download = (name: string, selector: Query, identity?: DownloadIdentity) => void;
const text = (value: unknown): string => typeof value === "string" ? value : "";
const strings = (value: unknown): string[] => Array.isArray(value) ? value.map(text).filter(Boolean) : [];
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const records = (value: unknown): Data[] => Array.isArray(value) ? value.map(object).filter((item) => Object.keys(item).length > 0) : [];

function section(target: any, title: string): any {
  const content = column(5);
  target.append(new Gtk.Expander({ label: title, child: content }));
  return content;
}

function fact(target: any, title: string, value: unknown): void {
  if (value === "" || (typeof value !== "string" && typeof value !== "number")) return;
  const item = label(`${title} · ${value}`);
  item.set_selectable(true);
  target.append(item);
}

function structured(target: any, title: string, value: unknown): void {
  if (!value || typeof value !== "object" || !Object.keys(value).length) return;
  const content = section(target, title);
  const words = label(JSON.stringify(value, null, 2));
  words.set_selectable(true);
  words.add_css_class("monospace");
  content.append(words);
}

export function renderTaskContract(target: any, raw: unknown): void {
  const task = object(raw);
  const meta = object(task.metadata);
  const contract = object(task.task_contract ?? meta.task_contract);
  const workspace = object(contract.workspace);
  const executor = object(task.executor_ref ?? meta.executor_ref);
  const workspaceRoot = text(workspace.root) || text(task.workspace_root) || text(meta.workspace_root);
  if (!Object.keys(contract).length && !workspaceRoot && !Object.keys(executor).length && !Object.keys(object(task.api_admission)).length) return;
  const content = section(target, "Контракт и параметры задачи");
  const admission = object(task.api_admission);
  if (admission.status === "accepted") content.append(label("Шлюз сохранил квитанцию запуска."));
  fact(content, "Состояние контракта", contract.status);
  fact(content, "Источник контракта", contract.source);
  fact(content, "Тип задачи", contract.task_type || task.type);
  fact(content, "Рабочая папка", workspaceRoot);
  fact(content, "Режим рабочей папки", workspace.mode || task.workspace_mode);
  const memory = text(task.memory_mode);
  fact(content, "Память", ({ shared: "Общая", forked: "Копия", empty: "Пустая" } as Record<string, string>)[memory] || memory);
  fact(content, "Начальное усилие", task.reasoning_effort);
  fact(content, "Календарный срок", contract.deadline_at || task.deadline_at);
  if (typeof task.execution_timeout_sec === "number" && Number.isFinite(task.execution_timeout_sec) && task.execution_timeout_sec >= 0) {
    fact(content, "Лимит времени выполнения", task.execution_timeout_sec === 0 ? "Без лимита" : `${task.execution_timeout_sec} с`);
  }
  fact(content, "Контекст", contract.context || task.context);
  fact(content, "Ожидаемый результат", contract.expected_output || task.expected_output);
  fact(content, "Ограничения", contract.constraints || task.constraints);
  fact(content, "Формат ответа", contract.answer_protocol);
  fact(content, "Сервисы после завершения", contract.service_teardown || meta.service_teardown);
  fact(content, "Отключённые инструменты", strings(contract.disabled_tools).join(", "));
  if (typeof contract.context_requires_self_body_docs === "boolean") {
    fact(content, "Документы об устройстве агента", contract.context_requires_self_body_docs ? "Запрошены" : "Без специального запроса");
  }
  const claims = records(contract.acceptance_claims);
  const earlier = strings(contract.success_criteria);
  if (claims.length || earlier.length) {
    const conditions = section(content, "Критерии приёмки");
    for (const claim of claims) {
      fact(conditions, [text(claim.id), text(claim.priority)].filter(Boolean).join(" · ") || "Критерий", claim.claim);
      fact(conditions, "Область", claim.surface);
      fact(conditions, "Подтверждение", claim.support);
    }
    for (const claim of earlier) fact(conditions, "Критерий", claim);
  }
  structured(content, "Разрешённые ресурсы", contract.allowed_resources ?? task.allowed_resources);
  structured(content, "Политика ресурсов", contract.resource_policy);
  if (Object.keys(executor).length) {
    const host = section(content, "Исполнитель рабочей папки");
    fact(host, "Тип", executor.type);
    fact(host, "Идентификатор", executor.id);
    fact(host, "Контейнер", executor.container_name);
    fact(host, "Сеть", executor.network);
    const mappings = records(executor.path_mappings);
    if (mappings.length) {
      for (const mapping of mappings) fact(host, text(mapping.host_path) || "Хост", mapping.backend_path);
    } else fact(host, text(executor.workspace_host_path) || "Хост", executor.workspace_backend_path);
  }
}

export function renderWorkspacePreflight(target: any, raw: unknown): void {
  const task = object(raw);
  const summary = object(task.workspace_preflight ?? object(task.metadata).workspace_preflight);
  if (!Object.keys(summary).length) return;
  const content = section(target, "Проверка рабочей папки перед запуском");
  const git = object(summary.git);
  const tools = object(summary.tools);
  fact(content, "Папка", summary.workspace_root);
  fact(content, "Ошибка проверки", summary.error);
  fact(content, "Ветка Git", git.branch);
  fact(content, "Коммит Git", git.head);
  fact(content, "Состояние HEAD", git.head_state);
  if (git.head_state === "known" && typeof git.dirty === "boolean") fact(content, "Рабочее дерево", git.dirty ? "Есть изменения" : "Без изменений");
  if (count(git.status_count) && (git.head_state === "known" || git.status_count > 0)) fact(content, "Записей статуса Git", git.status_count);
  fact(content, "Инструменты на PATH", strings(tools.available).join(", "));
  fact(content, "Инструменты не найдены", strings(tools.missing).join(", "));
  for (const broken of records(tools.broken)) fact(content, text(broken.tool) || "Ошибка инструмента", broken.reason);
  for (const item of records(summary.manifests)) {
    fact(content, "Манифест", [text(item.path), text(item.type), strings(item.scripts).join(", ")].filter(Boolean).join(" · "));
  }
}

const artifactStates: Record<string, string> = {
  pending: "Ожидают подготовки", finalizing: "Формируются", ready: "Готовы",
  ready_with_changes: "Готовы, есть изменения", ready_no_changes: "Готовы, изменений нет",
  missing: "Не найдены", failed: "Ошибка подготовки", not_applicable: "Не предусмотрены",
};
export const artifactStateName = (status: string): string => Object.hasOwn(artifactStates, status) ? artifactStates[status] : status;
const artifactKinds: Record<string, string> = {
  workspace_preflight: "Отчёт проверки рабочей папки", workspace_patch: "Патч Git",
  workspace_patch_manifest: "Манифест результата", workspace_file_outputs: "Файлы результата",
  workspace_file_output: "Файл результата", workspace_file_outputs_manifest: "Манифест файлов результата",
  verification_ledger: "Журнал проверки",
};
const blocked = new Set(["missing", "failed", "pending", "finalizing", "rejected", "not_applicable"]);

function parts(value: unknown): string[] {
  const path = text(value);
  if (!path || /[\\\x00-\x1f\x7f]/u.test(path)) return [];
  const components = path.split("/");
  return components.every((item) => item && item !== "." && item !== "..") ? components : [];
}

function nameOf(raw: Data): string {
  return text(raw.name) || text(raw.filename) || parts(raw.relpath).at(-1) || text(raw.path).split(/[\\/]/u).at(-1) || "";
}

function identity(raw: Data): DownloadIdentity | undefined {
  if (raw.measured === false || !count(raw.size) || !/^[0-9a-f]{64}$/u.test(text(raw.sha256))) return undefined;
  return { size: raw.size, sha256: text(raw.sha256) };
}

function describeCapture(target: any, raw: unknown): void {
  const data = object(raw);
  const kind = text(data.capture_kind);
  const state = text(data.status);
  if (state) fact(target, "Состояние снимка", artifactStateName(state));
  if (kind === "directory_direct" || kind === "engine_directory") fact(target, "Способ фиксации", "Снимок файлов рабочей папки");
  else if (kind) fact(target, "Способ фиксации", kind);
  if (data.apply_state === "already_applied") fact(target, "Изменения", "Уже находятся в рабочей папке на шлюзе");
  if (data.complete === false) fact(target, "Покрытие", "Снимок охватывает часть результата");
  fact(target, "Рабочая папка", data.workspace_root);
  fact(target, "Исходный коммит", data.base_head);
  fact(target, "Коммит при фиксации", data.current_head);
  fact(target, "Основание сравнения", data.base_provenance);
  fact(target, "Ветка", data.current_branch);
  fact(target, "Сводка изменений", data.diffstat);
  fact(target, "Примечание", data.note || data.base_explanation);
  for (const error of records(data.errors)) fact(target, text(error.type) || "Ошибка", error.message);
  const changes = records(data.file_output_changes);
  const outputs = records(data.registered_outputs);
  if (changes.length) {
    const files = section(target, `Изменения файлов · ${changes.length}`);
    for (const change of changes) {
      const operation = change.before === null && change.after ? "Добавлен"
        : change.before && change.after === null ? "Удалён" : change.before && change.after ? "Изменён" : "Файл";
      fact(files, operation, change.path);
    }
  }
  if (outputs.length) {
    const files = section(target, `Зарегистрированные выходные файлы · ${outputs.length}`);
    for (const output of outputs) fact(files, text(output.name) || "Файл", output.relpath || output.source_path);
  }
}

function artifactPairs(rawRows: Data[], bundle: Data[]): [Data, Data][] {
  const used = new Set<Data>();
  const byPath = new Map(bundle.filter((item) => text(item.path)).map((item) => [item.path, item]));
  const fallback = (items: Data[], key: (item: Data) => string): Map<string, Data | undefined> => {
    const index = new Map<string, Data | undefined>();
    for (const item of items) {
      const value = key(item);
      if (value) index.set(value, index.has(value) ? undefined : item);
    }
    return index;
  };
  const rawRelative = fallback(rawRows, (item) => text(item.relpath));
  const viewRelative = fallback(bundle, (item) => text(item.relpath));
  const rawNames = fallback(rawRows, nameOf);
  const viewNames = fallback(bundle, nameOf);
  const result: [Data, Data][] = rawRows.map((item) => {
    const rel = text(item.relpath);
    const name = nameOf(item);
    const sameName = rawNames.get(name) === item ? viewNames.get(name) : undefined;
    const match = byPath.get(item.path) ?? (rawRelative.get(rel) === item ? viewRelative.get(rel) : undefined)
      ?? (sameName && !text(item.path) && !text(sameName.path) ? sameName : undefined);
    if (match) used.add(match);
    return [item, match ?? {}];
  });
  for (const item of bundle) if (!used.has(item)) result.push([{}, item]);
  return result;
}

export function renderTaskArtifacts(parent: any, target: any, taskId: string, raw: unknown, sources: TaskReviews, download: Download): void {
  const task = object(raw);
  const bundle = object(task.artifact_bundle);
  const status = text(bundle.status) || text(task.artifact_status);
  const pairs = artifactPairs(records(task.artifacts), records(bundle.artifacts));
  const archives = Object.entries(object(task.artifact_archives));
  const errors = [...new Set([...strings(bundle.errors), text(task.artifact_error)].filter(Boolean))];
  if (!pairs.length && !archives.length && !errors.length && (!status || status === "not_applicable")) return;
  const content = section(target, status ? `Артефакты · ${artifactStateName(status)}` : "Артефакты");
  for (const error of errors) fact(content, "Ошибка", error);
  const history = column(5);
  const addresses = new Map<string, number>();
  for (const [original, view] of pairs) {
    const record = { ...view, ...original };
    const address = text(record.relpath) || nameOf(record);
    if (address) addresses.set(address, (addresses.get(address) ?? 0) + 1);
  }
  for (const [original, view] of pairs) {
    const record = { ...view, ...original };
    const state = text(view.status) || text(original.status);
    const name = nameOf(record);
    const relative = text(record.relpath);
    const kind = text(record.kind);
    const historical = kind === "workspace_capture_history";
    const location = historical ? history : content;
    const entry = column(4);
    const kindLabel = historical ? text(record.capture_kind) : kind;
    fact(entry, artifactKinds[kindLabel] || kindLabel || "Файл", relative || name || "Имя недоступно");
    if (state) fact(entry, "Состояние", artifactStateName(state));
    for (const problem of new Set([...strings(view.errors), ...strings(original.errors), text(original.copy_error)].filter(Boolean))) {
      fact(entry, "Ошибка", problem);
    }
    const originalIdentity = identity(original);
    const projectedIdentity = identity(view);
    const described = original.measured === false ? undefined
      : originalIdentity ?? (!Object.keys(original).length || count(original.size) ? projectedIdentity : undefined);
    const conflict = originalIdentity && projectedIdentity
      && (originalIdentity.size !== projectedIdentity.size || originalIdentity.sha256 !== projectedIdentity.sha256);
    const exact = parts(name).length === 1 && (!relative || parts(relative).at(-1) === name)
      && addresses.get(relative || name) === 1;
    if (conflict) fact(entry, "Проверка", "Описания контрольной суммы расходятся");
    else if (described) {
      fact(entry, "Размер", GLib.format_size(described.size));
      fact(entry, "SHA‑256", described.sha256);
    } else if (exact) fact(entry, "Проверка", "Контрольная сумма и размер не подтверждены");
    if (!exact) fact(entry, "Адрес", "Шлюз не указал однозначный путь");
    if (exact && !conflict && !blocked.has(state) && original.copy_status !== "failed"
      && (original.immutable !== true || described)) {
      const actions = row(5);
      const selector = { relpath: relative || undefined };
      const save = button("Скачать…", () => download(name, selector, described));
      save.set_tooltip_text(relative || name);
      actions.append(save);
      if (described) {
        const path = `/api/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(name)}${query(selector)}`;
        if (/\.pdf$/iu.test(name)) actions.append(button("Посмотреть PDF…", () => sources.artifactPdf(parent, relative || name, path, described)));
        else if (/\.(json|jsonl|patch|diff|txt|log|md|csv)$/iu.test(name)) {
          const describe = kindLabel === "workspace_patch_manifest" ? describeCapture : undefined;
          actions.append(button("Открыть…", () => sources.artifactDocument(parent, relative || name, name, path, described, describe)));
        }
      }
      entry.append(actions);
    }
    location.append(entry);
  }
  if (history.get_first_child()) content.append(new Gtk.Expander({ label: "Предыдущие снимки рабочей папки", child: history }));
  for (const [directory, value] of archives) {
    const archive = object(value);
    const name = text(archive.name);
    if (!parts(directory).length || parts(name).length !== 1) continue;
    if (archive.available === true) content.append(button(`Скачать архив · ${name}`, () => download(name, { archive: directory })));
    else if (archive.available === false) fact(content, "Архив недоступен", name);
  }
}
