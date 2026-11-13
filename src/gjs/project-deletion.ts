import { type Gateway, HttpError } from "./gateway.js";
import { Gio, GLib } from "./gi.js";
import { readProject, type Project } from "./project-directory.js";
import { button, column, confirm, errorText, label, row, sheet } from "./ui.js";

interface DeleteReceipt { ok?: boolean; project_id?: string; folder_untouched?: boolean }

export function projectDeletion(gateway: Gateway, project: Project, changed: () => void): any {
  const content = column();
  const dialog = sheet("Удаление проекта", content);
  const cancel = new Gio.Cancellable();
  const state = label("");
  const problem = label("", "error");
  const feedback = label("", "dim-label");
  const read = button("Перечитать состояние", () => void refresh());
  const remove = button("Удалить проект…", () => void submit());
  remove.add_css_class("destructive-action");
  let current: Project | null | undefined;
  let lastLifecycle = project.lifecycle || "active";
  let lastError = project.delete_error || "";
  let seenDeleting = lastLifecycle === "deleting";
  let accepted = false;
  let uncertain = false;
  let readable = false;
  let reading = false;
  let writing = false;
  let timer = 0;

  function render(): void {
    let description = "Состояние проекта ещё не прочитано.";
    if (current === null) {
      description = accepted || seenDeleting ? "Проект больше не доступен в реестре шлюза."
        : "Шлюз не вернул проект с этим ID.";
    } else if (current?.lifecycle === "deleting") {
      description = current.delete_error ? `Удаление не завершилось. ${current.delete_error}`
        : "Шлюз отменяет задачи проекта и завершает удаление.";
    } else if (current) {
      description = "Проект ещё доступен.";
    }
    state.set_label(reading && current === undefined ? "Читаю состояние проекта…" : !readable && current !== undefined
      ? `Последнее прочитанное состояние. ${description}` : description);
    read.set_sensitive(!cancel.is_cancelled() && !reading && !writing);
    remove.set_sensitive(Boolean(!cancel.is_cancelled() && readable && !reading && !writing && current
      && (current.lifecycle !== "deleting" ? !accepted : current.delete_error)));
    remove.set_visible(current !== null);
    remove.set_label(uncertain || current?.lifecycle === "deleting" ? "Повторить удаление…" : "Удалить проект…");
  }

  function stopTimer(): void {
    if (timer) GLib.Source.remove(timer);
    timer = 0;
  }

  function plan(): void {
    stopTimer();
    if (cancel.is_cancelled() || (current === null && readable)
      || (!accepted && !uncertain && !seenDeleting)) return;
    timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
      timer = 0;
      void refresh();
      return GLib.SOURCE_REMOVE;
    });
  }

  async function refresh(): Promise<void> {
    if (reading || writing || cancel.is_cancelled()) return;
    stopTimer();
    reading = true;
    render();
    try {
      const value = await readProject(gateway, { id: project.id }, cancel);
      if (cancel.is_cancelled()) return;
      if (value && value.chat_id !== project.chat_id) throw new Error("Шлюз вернул другую комнату для этого ID.");
      if (value && ((value.lifecycle !== undefined && !["active", "deleting"].includes(value.lifecycle))
        || (value.delete_error !== undefined && typeof value.delete_error !== "string"))) {
        throw new Error("Шлюз вернул неполное состояние удаления проекта.");
      }
      current = value ?? null;
      readable = true;
      problem.set_label("");
      seenDeleting ||= value?.lifecycle === "deleting";
      const lifecycle = value ? value.lifecycle || "active" : "absent";
      const detail = value?.delete_error || "";
      if (lastLifecycle !== lifecycle || lastError !== detail) {
        lastLifecycle = lifecycle;
        lastError = detail;
        changed();
      }
    } catch (error) {
      if (cancel.is_cancelled()) return;
      readable = false;
      problem.set_label(`Не удалось прочитать состояние. ${errorText(error)}`);
    } finally {
      reading = false;
      if (!cancel.is_cancelled()) { render(); plan(); }
    }
  }

  async function submit(): Promise<void> {
    if (!remove.get_sensitive() || cancel.is_cancelled()) return;
    writing = true;
    stopTimer();
    render();
    let sent = false;
    try {
      if (!await confirm(dialog, current?.lifecycle === "deleting" || uncertain ? "Повторить удаление проекта?" : "Удалить проект?",
        `${project.name || project.id}\nШлюз закроет приём новых задач и отменит текущие. Рабочая папка, история и память сохранятся.`,
        "Подтвердить удаление", cancel) || cancel.is_cancelled()) return;
      sent = true;
      feedback.set_label("Отправляю запрос на удаление…");
      try {
        const result = await gateway.json<DeleteReceipt>("POST", `/api/projects/${encodeURIComponent(project.id)}/delete`,
          undefined, undefined, false, cancel);
        if (cancel.is_cancelled()) return;
        if (result?.ok !== true || result.project_id !== project.id || result.folder_untouched !== true) {
          throw new Error("Шлюз не вернул полную квитанцию для этого проекта.");
        }
        accepted = true;
        uncertain = false;
        feedback.set_label("Шлюз принял запрос. Рабочая папка сохранена.");
      } catch (error) {
        if (cancel.is_cancelled()) return;
        const refused = error instanceof HttpError && error.status >= 400 && error.status < 500 && error.status !== 408;
        uncertain ||= !refused;
        feedback.set_label(`${refused ? "Шлюз отклонил запрос." : "Результат запроса не подтверждён."} ${errorText(error)}`);
      }
    } finally {
      writing = false;
      if (!cancel.is_cancelled()) {
        if (sent) await refresh();
        else { render(); plan(); }
      }
    }
  }

  const controls = row();
  controls.append(read);
  controls.append(remove);
  const identity = label(`${project.name || project.id} · ${project.id}`, "title-3");
  identity.set_selectable(true);
  for (const item of [identity, state, problem, feedback, controls]) content.append(item);
  dialog.connect("closed", () => { stopTimer(); cancel.cancel(); render(); });
  void refresh();
  return dialog;
}
