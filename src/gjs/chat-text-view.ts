import { type DiagramImageLoader } from "./diagram-images.js";
import { Gtk, Pango } from "./gi.js";
import { chatPlainMarkup, chatUsesMarkdown, type ChatTextFields } from "./chat-text.js";
import { markdownView } from "./markdown-view.js";
import { button, column, label } from "./ui.js";

export function chatTextView(source: string, message: ChatTextFields & { is_progress?: boolean }, base: string,
  onLink: (href: string) => boolean, diagramImages?: DiagramImageLoader): any {
  let host: any;
  if (chatUsesMarkdown(message)) host = markdownView(source, base, { chat: true, controls: !message.is_progress, onLink, diagramImages });
  else {
    host = column(4);
    const text = label("");
    text.set_selectable(true);
    text.set_wrap_mode(Pango.WrapMode.WORD_CHAR);
    if (message.role === "user") {
      text.set_markup(chatPlainMarkup(source));
      text.connect("activate-link", (_text: unknown, href: string) => onLink(href));
    } else text.set_label(source);
    host.append(text);
    if (!message.is_progress) {
      const copy = button("Скопировать сообщение", () => host.get_clipboard().set(source));
      copy.set_halign(Gtk.Align.START);
      host.append(copy);
    }
  }
  if (message.is_progress) host.add_css_class("dim-label");
  return host;
}
