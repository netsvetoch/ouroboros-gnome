import { Gtk } from "./gi.js";
import { validProjectId } from "./project-directory.js";
import { button, column, errorText, label, sheet } from "./ui.js";

export interface ProjectFromTaskOptions { project_id?: string; name?: string; objective_hint?: string }
export interface ProjectFromTaskRequest extends ProjectFromTaskOptions { task_id: string }

export function projectFromTaskOptions(parent: any, submit: (options: ProjectFromTaskOptions) => boolean,
  initial: ProjectFromTaskOptions = {}): any {
  const content = column();
  const dialog = sheet("Проект из задачи", content);
  let closed = false, submitting = false;
  let parentClosed: number | undefined;
  const close = () => {
    closed = true;
    if (parentClosed !== undefined) { parent.disconnect(parentClosed); parentClosed = undefined; }
  };
  dialog.connect("closed", close);
  parentClosed = parent.connect("closed", () => {
    close();
    if (dialog.get_mapped()) dialog.force_close();
  });
  const id = new Gtk.Entry({ placeholder_text: "ID нового или существующего проекта", text: initial.project_id ?? "" });
  const name = new Gtk.Entry({ placeholder_text: "Название — до 80 символов", text: initial.name ?? "" });
  const hint = new Gtk.TextView({ wrap_mode: Gtk.WrapMode.WORD_CHAR });
  hint.get_buffer().set_text(initial.objective_hint ?? "", -1);
  const feedback = label("", "dim-label");
  feedback.set_selectable(true);
  content.append(label("Пустые поля оставляют выбор шлюзу. Если задача уже привязана, шлюз сохранит её проект и может применить указанное имя."));
  for (const widget of [label("ID проекта"), id, label("Название"), name,
    label("Исходный запрос владельца — подсказка для названия"),
    new Gtk.ScrolledWindow({ child: hint, min_content_height: 110, hscrollbar_policy: Gtk.PolicyType.NEVER }), feedback]) content.append(widget);
  content.append(button("Перенести задачу", () => {
    if (closed || submitting) return;
    try {
      const projectId = id.get_text().trim();
      const projectName = name.get_text().trim();
      const buffer = hint.get_buffer();
      const objective = buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false).trim();
      if (projectId && !validProjectId(projectId)) throw new Error("Проверьте ID проекта: до 64 строчных латинских букв, цифр, точек, дефисов и подчёркиваний.");
      if ([...projectName].length > 80) throw new Error("Название должно содержать не более 80 символов.");
      submitting = true;
      if (submit({ ...(projectId ? { project_id: projectId } : {}), ...(projectName ? { name: projectName } : {}),
        ...(objective ? { objective_hint: objective } : {}) })) { close(); dialog.close(); }
      else {
        submitting = false;
        feedback.set_label("Состояние задачи изменилось. Проверьте её текущую привязку перед переносом.");
      }
    } catch (error) { submitting = false; feedback.set_label(errorText(error)); }
  }));
  dialog.present(parent);
  return dialog;
}
