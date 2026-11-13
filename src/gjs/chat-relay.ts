import { Gtk, Pango } from "./gi.js";
import { chrome } from "./native-i18n.js";
import { button, column, label } from "./ui.js";

const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value: Record<string, any>, keys: string[]) => keys.every(key => value[key] === undefined || typeof value[key] === "string");

/** Host-retained quotations are context, never fresh owner messages or instructions to dispatch. */
export function relayContext(raw: unknown, jump: (address: string) => void, expanded: Set<string>, key: string): { widget: any; quoted: boolean } | undefined {
  if (raw == null) return undefined;
  const body = column(6);
  let unreadable = false, shown = false, quoted = false;
  const text = (target: any, value: string, css?: string) => {
    const item = label(value, css);item.set_selectable(true);item.set_wrap_mode(Pango.WrapMode.WORD_CHAR);item.set_max_width_chars(64);target.append(item);return item;
  };
  const fact = (english: string, russian: string, value: unknown) => {
    if (typeof value !== "string" || !value) return;
    chrome(text(body, `${russian} · ${value}`, "dim-label"), "label", english, { value });shown = true;
  };
  const expander = (target: any, caption: string, child: any, id: string) => {
    const widget = new Gtk.Expander({ label: caption, child, expanded: expanded.has(id) });
    widget.connect("notify::expanded", () => { if (widget.expanded) expanded.add(id);else expanded.delete(id); });target.append(widget);return widget;
  };
  if (!object(raw)) unreadable = true;
  else {
    if (!strings(raw, ["summary"])) unreadable = true;
    fact("Forwarding summary · {value}", "Сводка пересылки", raw.summary);
    for (const [field, title, fallback] of [["sender", "Source work · {value}", "Исходная работа"], ["target", "Receiving work · {value}", "Получающая работа"]]) {
      const value = raw[field];
      if (value === undefined) continue;
      if (!object(value) || !strings(value, ["name", "title", "task_id"])) { unreadable = true;continue; }
      fact(title!, fallback!, [value.name, value.title, value.task_id].filter(Boolean).join(" · "));
    }
    if (raw.quotes !== undefined && !Array.isArray(raw.quotes)) unreadable = true;
    const quotes = Array.isArray(raw.quotes) && raw.quotes.length ? raw.quotes : [raw];
    for (let index = 0;index < quotes.length;index++) {
      const quote = quotes[index];
      if (!object(quote) || !strings(quote, ["text"]) || quote.attachments !== undefined && !Array.isArray(quote.attachments)
        || quote.source !== undefined && (!object(quote.source) || !strings(quote.source, ["label", "ts", "address"]))) {
        unreadable = true;continue;
      }
      const files: string[] = [];
      for (const file of quote.attachments ?? []) {
        if (!object(file) || !strings(file, ["name", "display_name", "filename", "label"])) { unreadable = true;continue; }
        const name = file.name || file.display_name || file.filename || file.label;
        if (name) files.push(name);
      }
      const words = quote.text ?? "", source = quote.source ?? {};
      if (!words.trim() && !files.length) continue;
      const content = column(4);
      if (words.trim()) text(content, words);
      if (files.length) chrome(text(content, "Вложения · " + files.join(", ")), "label", "Attached · {names}", { names: files.join(", ") });
      if (source.ts) text(content, source.ts, "dim-label");
      if (source.address) content.append(chrome(button("Открыть исходное сообщение", () => jump(source.address)), "label", "Open original message"));
      const item = expander(body, source.label ? `Сообщение владельца · ${source.label}` : "Сообщение владельца", content,
        `${key}:quote:${index}:${source.address ?? ""}`);
      chrome(item, "label", source.label ? "Owner message · {place}" : "Owner message", source.label ? { place: source.label } : undefined);
      shown = true;
      quoted = true;
    }
  }
  if (unreadable) { chrome(text(body, "Часть переданного контекста недоступна. Показаны только читаемые сведения.", "warning"), "label",
    "Some forwarded context is unavailable. Only readable details are shown.");shown = true; }
  if (!shown) return undefined;
  const root = new Gtk.Expander({ label: "Переданный контекст", child: body, expanded: expanded.has(key) });
  root.connect("notify::expanded", () => { if (root.expanded) expanded.add(key);else expanded.delete(key); });
  chrome(root, "label", "Forwarded context");return { widget: root, quoted };
}
