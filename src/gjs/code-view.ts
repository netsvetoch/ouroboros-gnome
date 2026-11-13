import { Adw, Gtk, sourceView } from "./gi.js";
import { selectCodeLanguage } from "./code-language.js";
import { button, column, label, row } from "./ui.js";

/** A read-only GTK code block. Neither highlighting nor language detection executes code. */
export function codeView(text: string, language?: string, title?: string): any {
  const box = column(4);
  const actions = row();
  let view: any;
  let detected: string | undefined;
  try {
    const Source = sourceView();
    const languages = Source.LanguageManager.get_default();
    const id = selectCodeLanguage(text, language, id => Boolean(languages.get_language(id)), hint =>
      (languages.guess_language(hint, null) ?? languages.guess_language(null, hint))?.get_id());
    const grammar = id ? languages.get_language(id) : null;
    detected = grammar?.get_name();
    const buffer = new Source.Buffer({ language: grammar, highlight_syntax: Boolean(grammar),
      highlight_matching_brackets: false, implicit_trailing_newline: false });
    buffer.set_text(text, -1);
    view = new Source.View({ buffer, editable: false, cursor_visible: false, monospace: true,
      wrap_mode: Gtk.WrapMode.NONE, tab_width: 4 });
    const style = Adw.StyleManager.get_default();
    const schemes = Source.StyleSchemeManager.get_default();
    const update = () => buffer.set_style_scheme(schemes.get_scheme(style.get_dark() ? "Adwaita-dark" : "Adwaita")
      ?? schemes.get_scheme(style.get_dark() ? "classic-dark" : "classic"));
    let signal = 0;
    view.connect("map", () => {
      update();
      if (!signal) signal = style.connect("notify::dark", update);
    });
    view.connect("unmap", () => {
      if (signal) style.disconnect(signal);
      signal = 0;
    });
    update();
  } catch {
    // Source launches on older distributions retain readable, selectable code.
    view = new Gtk.TextView({ editable: false, cursor_visible: false, monospace: true, wrap_mode: Gtk.WrapMode.NONE });
    view.get_buffer().set_text(text, -1);
  }
  if (title) actions.append(label(title, "heading"));
  if (language || detected) actions.append(label(language || detected!, "dim-label"));
  actions.append(button("Скопировать код", () => box.get_clipboard().set(text)));
  box.append(actions);
  box.append(new Gtk.ScrolledWindow({ vexpand: false, child: view, min_content_height: 45, max_content_height: 260,
    propagate_natural_height: true, hscrollbar_policy: Gtk.PolicyType.AUTOMATIC }));
  return box;
}
