import { Gtk, Pango } from "./gi.js";
import { chatHref } from "./chat-text.js";
import { chrome } from "./native-i18n.js";
import { column, label } from "./ui.js";

/** Host-retained contact provenance is display context, never room or owner authority. */
export function contactSource(raw: unknown): any | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (!["task_id", "binding_id", "source_event_id"].every(key => typeof value[key] === "string" && Boolean((value[key] as string).trim()))
    || ["label", "url"].some(key => value[key] !== undefined && typeof value[key] !== "string")) return undefined;
  // Older connectors repeated their own name in the retained label.
  const name = typeof value.label === "string" ? value.label.split(" · ").filter((part, index, parts) => part !== parts[index - 1]).join(" · ") : "";
  const box = column(2);
  const source = name ? chrome(label(`Источник · ${name}`, "dim-label"), "label", "Source · {label}", { label: name })
    : chrome(label("Источник · Связанное место", "dim-label"), "label", "Source · Connected place");
  source.set_wrap_mode(Pango.WrapMode.WORD_CHAR);source.set_max_width_chars(64);source.set_selectable(true);
  source.set_tooltip_text(`Исходная задача · ${value.task_id}`);
  chrome(source, "tooltip-text", "Source work: {task_id}", { task_id: value.task_id as string });
  box.append(source);
  const href = typeof value.url === "string" ? chatHref(value.url) : undefined;
  if (href && /^https?:\/\//iu.test(href)) {
    const link = chrome(new Gtk.LinkButton({ uri: href, label: "Открыть источник", halign: Gtk.Align.START }), "label", "Open source");
    link.set_tooltip_text(href);box.append(link);
  }
  return box;
}
