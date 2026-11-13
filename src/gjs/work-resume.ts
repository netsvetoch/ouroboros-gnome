import { bindChrome } from "./native-i18n.js";
import { Adw, GLib, Gtk, Pango } from "./gi.js";
import { button, column, label, row, sheet } from "./ui.js";

export interface ResumeUnknownChoice { accept_unknown: string[]; reason: string }

function wrapped(text: string): any {
  const widget = label(text);
  widget.set_wrap_mode(Pango.WrapMode.WORD_CHAR);
  widget.set_max_width_chars(72);
  widget.set_selectable(true);
  return widget;
}

/** A decision about named unknown outcomes, never permission to replay their calls. */
export function chooseResumeUnknown(parent: any, target: string, ids: string[], blockers: unknown,
  cancel: any, message?: string): Promise<ResumeUnknownChoice | undefined> {
  if (cancel.is_cancelled()) return Promise.resolve(undefined);
  const stops: (() => void)[] = [];
  const caption = (widget: any, property: string, english: string, params?: Record<string, string | number>): any => {
    stops.push(bindChrome(widget, property, english, params));
    return widget;
  };
  const content = column(10);
  const dialog = sheet("Неизвестные результаты вызовов", content);
  caption(dialog, "title", "Unknown call outcomes");
  dialog.set_name("work-resume-unknown");
  dialog.set_content_width(680);
  dialog.set_content_height(600);
  content.append(caption(wrapped(`Задача · ${target}`), "label", "Task · {id}", { id: target }));
  content.append(caption(wrapped("Отметьте вызовы, без результатов которых вы готовы продолжить. Остальные могут оставить задачу на паузе. Вызовы не будут повторены; выбор и причина сохранятся в истории задачи."), "label",
    "Select the calls whose unknown outcomes you accept. Other calls may keep the task paused. Calls will not be replayed; your selection and reason will be recorded."));
  if (message) content.append(wrapped(message));
  const options = ids.map(id => {
    const box = column(3);
    const choice = new Gtk.CheckButton({ label: id });
    const caption = choice.get_child();
    if (caption instanceof Gtk.Label) {
      caption.set_wrap(true);
      caption.set_wrap_mode(Pango.WrapMode.WORD_CHAR);
      caption.set_max_width_chars(64);
    }
    box.append(choice);
    for (const item of Array.isArray(blockers) ? blockers : []) {
      if (!item || typeof item !== "object" || Array.isArray(item) || (item.operation_id !== id && item.attempt_id !== id)) continue;
      const operation = item.operation && typeof item.operation === "object" && !Array.isArray(item.operation) ? item.operation : {};
      const effects = Array.isArray(item.effects) ? item.effects.filter((value: unknown) => typeof value === "string") : [];
      const facts = [item.task_id, item.tool, item.kind, item.state ?? operation.state, item.reason, ...effects].filter(value => typeof value === "string" && value).join(" · ");
      if (facts) box.append(wrapped(facts));
    }
    content.append(box);
    return { id, choice };
  });
  content.append(caption(label("Причина (необязательно)"), "label", "Reason (optional)"));
  const reason = new Gtk.TextView({ wrap_mode: Gtk.WrapMode.WORD_CHAR });
  content.append(new Gtk.ScrolledWindow({ child: reason, min_content_height: 90, hscrollbar_policy: Gtk.PolicyType.NEVER }));
  const feedback = label("", "dim-label");
  content.append(feedback);
  return new Promise(resolve => {
    let settled = false, cancelSignal = 0;
    const parents: [any, number][] = [];
    const finish = (decision?: ResumeUnknownChoice) => {
      if (settled) return;
      settled = true;
      for (const [object, signal] of parents.splice(0)) object.disconnect(signal);
      // Gio.Cancellable.disconnect cannot run in its own cancellation callback.
      if (cancelSignal) GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        cancel.disconnect(cancelSignal); return GLib.SOURCE_REMOVE;
      });
      for (const stop of stops.splice(0)) stop();
      resolve(decision);
      if (dialog.get_parent()) dialog.force_close();
    };
    const submit = caption(button("Продолжить без выбранных результатов", () => {
      if (settled || cancel.is_cancelled()) return;
      const selected = options.filter(item => item.choice.get_active()).map(item => item.id);
      if (!selected.length) { feedback.set_label("Отметьте хотя бы один вызов."); caption(feedback, "label", "Select at least one call."); return; }
      const buffer = reason.get_buffer();
      finish({ accept_unknown: selected, reason: buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false) });
    }), "label", "Continue without selected results");
    submit.add_css_class("destructive-action");
    const sync = () => { if (!settled) submit.set_sensitive(options.some(item => item.choice.get_active())); };
    for (const { choice } of options) choice.connect("toggled", sync);
    const selection = row();
    selection.append(caption(button("Выбрать все", () => { if (!settled) for (const { choice } of options) choice.set_active(true); }), "label", "Select all"));
    selection.append(caption(button("Снять выбор", () => { if (!settled) for (const { choice } of options) choice.set_active(false); }), "label", "Clear selection"));
    content.append(selection);
    const controls = row();
    controls.append(caption(button("Отмена", () => finish()), "label", "Cancel"));
    controls.append(submit);
    content.append(controls);
    sync();
    dialog.connect("closed", () => finish());
    const follow = (object: any, signal: string) => parents.push([object, object.connect(signal, () => { finish(); return false; })]);
    if (parent instanceof Adw.Dialog) follow(parent, "closed");
    const window = parent instanceof Gtk.Window ? parent : parent?.get_root?.();
    if (window instanceof Gtk.Window) follow(window, "close-request");
    cancelSignal = cancel.connect(() => finish());
    if (!settled) dialog.present(parent);
  });
}
