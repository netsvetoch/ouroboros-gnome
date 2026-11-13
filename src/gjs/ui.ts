import { Adw, GLib, Gtk } from "./gi.js";
import { bindChrome, chromeText, watchNativeI18n } from "./native-i18n.js";

export function button(label: string, activate: () => void): any {
  const widget = new Gtk.Button({ label });
  widget.connect("clicked", activate);
  return widget;
}

export function column(spacing = 8): any {
  return new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing });
}

export function row(spacing = 8): any {
  return new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing });
}

export function label(text: string, css?: string): any {
  const widget = new Gtk.Label({ label: text, xalign: 0, wrap: true });
  if (css) widget.add_css_class(css);
  return widget;
}

/** Disable markup before assigning server data, including during construction. */
export function actionRow(properties: Record<string, unknown> = {}): any {
  const { title, subtitle, ...options } = properties;
  const widget = new Adw.ActionRow({ ...options, use_markup: false });
  if (title !== undefined) widget.set_title(title);
  if (subtitle !== undefined) widget.set_subtitle(subtitle);
  return widget;
}

export function clear(box: any): void {
  let child;
  while ((child = box.get_first_child())) box.remove(child);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface DialogChrome {
  heading?: string; body?: string; action?: string;
  params?: Record<string, string | number>;
}

/** Sources are client-authored constants; unmarked headings/bodies/actions are data. */
function localizeDialog(dialog: any, responses: [string, string | undefined, string][], sources?: DialogChrome): () => void {
  const releases: (() => void)[] = [];
  let released = false;
  for (const property of ["heading", "body"] as const) {
    if (sources?.[property]) releases.push(bindChrome(dialog, property, sources[property], sources.params));
  }
  const repaint = () => {
    if (released) return;
    for (const [id, source, fallback] of responses) if (source) dialog.set_response_label(id, chromeText(source, sources?.params, fallback));
  };
  repaint();
  const unwatch = watchNativeI18n(repaint);
  const release = () => {
    if (released) return;
    released = true; unwatch();
    for (const stop of releases) stop();
  };
  dialog.connect("closed", release);
  return release;
}

export function alert(parent: any, title: string, body: string, sources?: DialogChrome): void {
  const dialog = new Adw.AlertDialog({ heading: title, body });
  dialog.add_response("ok", "Закрыть");
  localizeDialog(dialog, [["ok", "Close", "Закрыть"]], sources);
  dialog.present(parent);
}

export function confirm(parent: any, title: string, body: string, action: string, cancel?: any, sources?: DialogChrome): Promise<boolean> {
  if (cancel?.is_cancelled()) return Promise.resolve(false);
  const dialog = new Adw.AlertDialog({ heading: title, body });
  dialog.add_response("cancel", "Отмена");
  dialog.add_response("ok", action);
  dialog.set_close_response("cancel");
  dialog.set_default_response("cancel");
  dialog.set_response_appearance("ok", Adw.ResponseAppearance.DESTRUCTIVE);
  const release = localizeDialog(dialog, [["cancel", "Cancel", "Отмена"], ["ok", sources?.action, action]], sources);
  return new Promise((resolve) => {
    let settled = false, idle = 0;
    let signal: number | undefined;
    const finish = (approved: boolean) => {
      if (settled) return;
      settled = true;
      release();
      if (idle) { GLib.Source.remove(idle); idle = 0; }
      if (signal !== undefined) { cancel.disconnect(signal); signal = undefined; }
      resolve(approved && !cancel?.is_cancelled());
    };
    dialog.connect("response", (_dialog: unknown, response: string) => finish(response === "ok"));
    if (cancel) signal = cancel.connect(() => {
      // Gio.Cancellable.disconnect must run after its cancellation callback returns.
      if (!idle && !settled) idle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        idle = 0;
        finish(false);
        if (dialog.get_mapped()) dialog.force_close();
        return GLib.SOURCE_REMOVE;
      });
    });
    dialog.present(parent);
  });
}

export function sheet(title: string, content: any): any {
  const dialog = new Adw.Dialog({ title, content_width: 580, content_height: 480 });
  const toolbar = new Adw.ToolbarView();
  toolbar.add_top_bar(new Adw.HeaderBar());
  content.set_margin_top(12);
  content.set_margin_bottom(12);
  content.set_margin_start(12);
  content.set_margin_end(12);
  toolbar.set_content(new Gtk.ScrolledWindow({ child: content, hscrollbar_policy: Gtk.PolicyType.NEVER }));
  dialog.set_child(toolbar);
  return dialog;
}

export function chooseFile(parent: any, filename?: string, cancel: any = null): Promise<any> {
  const dialog = new Gtk.FileDialog({ modal: true });
  const owner = parent instanceof Gtk.Window ? parent : parent?.get_root?.() ?? null;
  if (filename !== undefined) dialog.set_initial_name(filename);
  return new Promise((resolve, reject) => {
    const callback = (_dialog: unknown, result: unknown) => {
      try {
        resolve(filename === undefined ? dialog.open_finish(result) : dialog.save_finish(result));
      } catch (error: any) {
        if (error.matches?.(Gtk.dialog_error_quark(), Gtk.DialogError.DISMISSED)) resolve(null);
        else reject(error);
      }
    };
    if (filename === undefined) dialog.open(owner, cancel, callback);
    else dialog.save(owner, cancel, callback);
  });
}

