import { bindChrome } from "./native-i18n.js";
import { Adw, GLib, Gtk } from "./gi.js";
import { button, column, label, row, sheet } from "./ui.js";

/** A pending request is immutable: editing its reason would change an idempotent retry. */
export function choosePauseReason(parent: any, target: string, cancel: any,
  pending?: { request_id: string; reason?: string }): Promise<{ reason: string } | undefined> {
  if (cancel.is_cancelled()) return Promise.resolve(undefined);
  const stops: (() => void)[] = [];
  const caption = (widget: any, property: string, english: string, params?: Record<string, string | number>): any => {
    stops.push(bindChrome(widget, property, english, params));
    return widget;
  };
  const content = column(10);
  const dialog = sheet("Пауза с причиной", content);
  dialog.set_name("work-pause-reason");
  dialog.set_content_width(600);
  caption(dialog, "title", "Pause with a reason");
  content.append(caption(label(`Задача · ${target}`), "label", "Task · {id}", { id: target }));
  if (pending) {
    content.append(caption(label("Результат предыдущего запроса ещё не подтверждён. Повтор сохранит исходную причину."), "label",
      "The previous request is not yet confirmed. Retrying will keep its original reason."));
    content.append(caption(label(`Запрос · ${pending.request_id}`), "label", "Request · {id}", { id: pending.request_id }));
  }
  content.append(caption(label("Причина (необязательно)"), "label", "Reason (optional)"));
  const reason = new Gtk.TextView({ wrap_mode: Gtk.WrapMode.WORD_CHAR, editable: !pending });
  reason.get_buffer().set_text(pending?.reason ?? "", -1);
  content.append(new Gtk.ScrolledWindow({ child: reason, min_content_height: 120, hscrollbar_policy: Gtk.PolicyType.NEVER }));
  return new Promise(resolve => {
    let settled = false, cancelSignal = 0;
    const parents: [any, number][] = [];
    const finish = (choice?: { reason: string }) => {
      if (settled) return;
      settled = true;
      for (const [object, signal] of parents.splice(0)) object.disconnect(signal);
      if (cancelSignal) GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        cancel.disconnect(cancelSignal); return GLib.SOURCE_REMOVE;
      });
      for (const stop of stops.splice(0)) stop();
      resolve(choice);
      if (dialog.get_parent()) dialog.force_close();
    };
    const controls = row();
    controls.append(caption(button("Отмена", () => finish()), "label", "Cancel"));
    const submit = button(pending ? "Повторить исходный запрос" : "Поставить на паузу", () => {
      if (settled || cancel.is_cancelled()) return;
      const buffer = reason.get_buffer();
      finish({ reason: buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false) });
    });
    caption(submit, "label", pending ? "Retry original request" : "Pause task");
    submit.add_css_class("suggested-action");
    controls.append(submit);
    content.append(controls);
    dialog.connect("closed", () => finish());
    const follow = (object: any, signal: string) => parents.push([object, object.connect(signal, () => { finish(); return false; })]);
    if (parent instanceof Adw.Dialog) follow(parent, "closed");
    const window = parent instanceof Gtk.Window ? parent : parent?.get_root?.();
    if (window instanceof Gtk.Window) follow(window, "close-request");
    cancelSignal = cancel.connect(() => finish());
    if (!settled) dialog.present(parent);
  });
}
