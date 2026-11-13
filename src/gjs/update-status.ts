import { Gtk } from "./gi.js";
import { column, label } from "./ui.js";

export interface UpdateStatus {
  current_version?: string;
  latest_version?: string;
  current_sha?: string;
  running_sha?: string;
  latest_sha?: string;
  latest_message?: string;
  checked_target_sha?: string;
  update_channel?: string;
  official_repo_url?: string;
  current_branch?: string;
  target_ref?: string;
  managed?: boolean;
  available?: boolean;
  check_ok?: boolean | null;
  checked_at?: string;
  from_cache?: boolean;
  safe_to_apply?: boolean;
  ahead?: number;
  behind?: number;
  dirty?: boolean;
  dirty_count?: number;
  dirty_preview?: string[];
  local_changes?: string;
  local_changes_base?: string;
  local_changes_reason?: string;
  warnings?: string[];
}

const warningNames: Record<string, string> = {
  fetch_error: "Не удалось получить данные из источника обновлений",
  remote_config_error: "Не удалось настроить источник обновлений",
  managed_update_requires_branch: "Для управляемого обновления требуется ветка",
  missing_remote: "Источник Git отсутствует",
  branch_error: "Не удалось прочитать имя ветки",
  head_error: "Не удалось прочитать текущий коммит",
  status_error: "Не удалось проверить рабочую копию",
  target_ref_error: "Не удалось определить целевой коммит",
  divergence_parse_error: "Шлюз не разобрал результаты сравнения",
  divergence_error: "Не удалось сравнить коммиты",
};

const changeReasons: Record<string, string> = {
  unresolved_sha: "коммит не определён", shallow_history: "история Git неполная",
  no_shared_base: "общий коммит не найден", several_bases: "найдено несколько общих оснований",
  git_error: "ошибка Git",
};

export function canPrepareUpdate(status?: UpdateStatus): boolean {
  return Boolean(status && status.managed !== false && !status.warnings?.some(
    warning => warning === "managed_updates_unavailable" || warning.startsWith("managed_update_requires_branch:"),
  ));
}

function add(container: any, title: string, value?: string | number): void {
  if (value == null || value === "") return;
  const widget = label(`${title} · ${value}`);
  widget.set_selectable(true);
  container.append(widget);
}

export function updateStatusView(status: UpdateStatus): any {
  const content = column(6);
  const warnings = status.warnings ?? [];
  const compared = status.check_ok === true || Boolean(status.checked_at && status.check_ok !== false);
  const available = compared && status.available === true;
  const workspaceError = warnings.some(warning => warning.startsWith("status_error:"));
  const workspaceRead = !workspaceError && !warnings.some(warning => warning.startsWith("remote_config_error:"));
  let headline = "Состояние канала обновлений неизвестно.";
  if (status.check_ok === false) headline = "Проверка канала обновлений не удалась.";
  else if (workspaceError) headline = "Шлюз не смог проверить рабочую копию.";
  else if (!canPrepareUpdate(status)) headline = "Управляемое обновление для этой рабочей копии недоступно.";
  else if (available) headline = status.latest_version ? `Доступно обновление до ${status.latest_version}.` : "Доступно обновление.";
  else if (compared && status.available === false) headline = "Доступных обновлений нет.";
  else if (warnings.includes("official_status_requires_check")) headline = "Канал обновлений ещё не проверен.";
  content.append(label(headline, "title-3"));
  if (available && status.safe_to_apply === false) content.append(label("Перед применением шлюзу нужно построить план для текущей рабочей копии."));

  add(content, "Источник", status.official_repo_url);
  add(content, "Канал", status.update_channel);
  add(content, "Текущая ветка", status.current_branch);
  add(content, "Целевая ссылка", status.target_ref);
  add(content, "Версия шлюза", status.current_version);
  add(content, "Коммит на диске", status.current_sha);
  add(content, "Запущенный коммит", status.running_sha);
  add(content, "Коммит канала", status.checked_target_sha || status.latest_sha);
  add(content, "Описание целевого коммита", status.latest_message);
  add(content, "Последняя успешная проверка", status.checked_at);
  if (available && status.from_cache) content.append(label("Доступность вычислена по данным последней проверки.", "dim-label"));
  if (compared) {
    add(content, "Входящие коммиты", status.behind);
    add(content, "Локальные коммиты", status.ahead);
    const changes = status.local_changes;
    const reason = status.local_changes_reason;
    const changeText = changes === "present" ? "есть" : changes === "absent" ? "нет"
      : reason ? `неизвестно · ${Object.hasOwn(changeReasons, reason) ? changeReasons[reason] : reason}` : "неизвестно";
    add(content, "Изменения содержимого относительно общей базы", changeText);
    add(content, "Общий коммит", status.local_changes_base);
  }
  if (workspaceRead && (status.dirty === true || status.dirty === false)) {
    add(content, "Незафиксированные изменения", status.dirty ? status.dirty_count ?? "есть" : "нет");
    if (status.dirty && status.dirty_preview?.length) {
      const preview = column(4);
      const lines = label(status.dirty_preview.join("\n"), "monospace");
      lines.set_selectable(true);
      preview.append(lines);
      if ((status.dirty_count ?? 0) > status.dirty_preview.length) {
        preview.append(label(`Показано ${status.dirty_preview.length} из ${status.dirty_count} записей.`, "dim-label"));
      }
      content.append(new Gtk.Expander({ label: "Список изменённых файлов", child: preview }));
    }
  }
  for (const warning of warnings) {
    if (warning === "official_status_requires_check" || warning === "managed_updates_unavailable") continue;
    const delimiter = warning.indexOf(":");
    const key = delimiter < 0 ? warning : warning.slice(0, delimiter);
    const detail = delimiter < 0 ? "" : warning.slice(delimiter + 1);
    add(content, Object.hasOwn(warningNames, key) ? warningNames[key] : key, detail || "по данным шлюза");
  }
  return content;
}
