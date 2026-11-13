import { Gtk, Pango } from "./gi.js";
import { chrome } from "./native-i18n.js";
import { button, column, label } from "./ui.js";

const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
/** A saved lookup is evidence from that time; unresolved never proves permanent absence. */
export function replyQuote(raw: unknown, jump: (address: string) => void): any | undefined {
  if (raw == null) return undefined;
  const body = column(3);
  const text = (value: string, css?: string) => {
    const item = label(value, css);item.set_selectable(true);item.set_wrap_mode(Pango.WrapMode.WORD_CHAR);item.set_max_width_chars(64);body.append(item);return item;
  };
  const valid = object(raw) && ["address", "snippet", "author_label", "ts", "kind", "role"].every(key =>
    raw[key] === undefined || typeof raw[key] === "string")
    && (raw.unresolved === undefined || typeof raw.unresolved === "boolean")
    && (raw.chars === undefined || Number.isSafeInteger(raw.chars) && raw.chars >= 0);
  if (!valid) chrome(text("Сведения о цитируемом сообщении недоступны.", "warning"), "label", "Quoted message details are unavailable.");
  else {
    if (!raw.address && !raw.snippet) return undefined;
    if (raw.author_label) chrome(text("Ответ на сообщение · " + raw.author_label, "dim-label"), "label", "Reply to · {author}", { author: raw.author_label });
    else {
      const fallback: Record<string, [string, string]> = { user: ["Reply to You", "Ответ на ваше сообщение"],
        assistant: ["Reply to Ouroboros", "Ответ на сообщение Ouroboros"], system: ["Reply to System", "Ответ на системное сообщение"] };
      const [english, russian] = Object.hasOwn(fallback, raw.role) ? fallback[raw.role]! : ["Quoted message", "Цитируемое сообщение"];
      chrome(text(russian, "dim-label"), "label", english);
    }
    if (raw.ts) text(raw.ts, "dim-label");
    if (raw.address) {
      const open = button(raw.snippet || "Открыть исходное сообщение", () => jump(raw.address));
      if (!raw.snippet) chrome(open, "label", "Open original message");
      const child = open.get_child();
      if (child instanceof Gtk.Label) { child.set_wrap(true);child.set_wrap_mode(Pango.WrapMode.WORD_CHAR);child.set_max_width_chars(64);child.set_xalign(0); }
      open.set_halign(Gtk.Align.FILL);open.add_css_class("flat");body.append(open);
    } else text(raw.snippet);
    if (raw.chars !== undefined) chrome(text(`Исходный текст · ${raw.chars} символов`, "dim-label"), "label", "Original text · {count} characters", { count: raw.chars });
    if (raw.unresolved) chrome(text("Исходное сообщение было недоступно при сохранении ответа. Попробуйте открыть его сейчас.", "dim-label"), "label",
      "The original message was unavailable when this reply was saved. Try opening it now.");
  }
  for (const side of ["top", "bottom", "start", "end"]) body[`set_margin_${side}`](6);
  const frame = new Gtk.Frame({ child: body });
  frame.set_tooltip_text("Цитируемое сообщение");chrome(frame, "tooltip-text", "Quoted message");return frame;
}
