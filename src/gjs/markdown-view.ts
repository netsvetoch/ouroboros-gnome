import { type DiagramImageLoader } from "./diagram-images.js";
import { markdownChartView } from "./markdown-chart-view.js";
import { mermaidView } from "./mermaid-view.js";
import { MathContext } from "./math-context.js";
import { mathTextView } from "./math-view.js";
import { codeView } from "./code-view.js";
import { chatDocument } from "./chat-text.js";
import { Gtk, Pango } from "./gi.js";
import { markdownDocument, markdownInline, markdownText, type MarkdownNode } from "./markdown-document.js";
import { button, column, label, row } from "./ui.js";

const inline = new Set(["text", "a", "b", "strong", "i", "em", "code", "kbd", "samp", "var", "s", "strike", "del", "u", "ins", "sub", "sup", "small", "br", "span", "abbr", "q", "mark", "image-alt", "task"]);

type LinkAction = (href: string) => boolean;

function rich(nodes: MarkdownNode[], base?: string, css?: string, onLink?: LinkAction, math?: MathContext): any {
  if (math) { const view = mathTextView(nodes, base, css, onLink, math); if (view) return view; }
  const view = label("", css);
  view.set_selectable(true);
  view.set_wrap_mode(Pango.WrapMode.WORD_CHAR);
  view.set_max_width_chars(100);
  view.set_markup(markdownInline(nodes, base).trim());
  if (onLink) view.connect("activate-link", (_view: unknown, href: string) => onLink(href));
  return view;
}

function table(node: MarkdownNode, base?: string, onLink?: LinkAction, math?: MathContext): any {
  const host = column(4), content = column();
  const rows: MarkdownNode[] = [];
  const headers: MarkdownNode[] = [];
  const collect = (nodes: MarkdownNode[], header = false) => {
    for (const item of nodes) {
      if (item.tag === "tr") (header ? headers : rows).push(item);
      else if (["thead", "tbody", "tfoot"].includes(item.tag)) collect(item.children, item.tag === "thead");
    }
  };
  collect(node.children);
  const width = Math.max(0, ...[...headers, ...rows].map(item => item.children.filter(cell => cell.tag === "td" || cell.tag === "th").length));
  let start = 0, col = 0;
  const position = label("", "dim-label");
  const controls = new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.NONE, row_spacing: 4, column_spacing: 6 });
  const previous = button("Предыдущие строки", () => { start = Math.max(0, start - 50); render(); });
  const next = button("Следующие строки", () => { if (start + 50 < rows.length) start += 50; render(); });
  const left = button("Предыдущие столбцы", () => { col = Math.max(0, col - 12); render(); });
  const right = button("Следующие столбцы", () => { if (col + 12 < width) col += 12; render(); });
  for (const item of [previous, next, left, right]) controls.append(item);
  previous.set_visible(rows.length > 50); next.set_visible(rows.length > 50);
  left.set_visible(width > 12); right.set_visible(width > 12);
  const paged = rows.length > 50 || width > 12;
  position.set_visible(paged); controls.set_visible(paged);
  function render(): void {
    let old;
    while ((old = content.get_first_child())) content.remove(old);
    const grid = new Gtk.Grid({ row_spacing: 5, column_spacing: 16 });
    [...headers, ...rows.slice(start, start + 50)].forEach((record, y) => record.children.filter(cell => cell.tag === "td" || cell.tag === "th").slice(col, col + 12)
      .forEach((cell, x) => {
        const view = rich(cell.children, base, cell.tag === "th" ? "heading" : undefined, onLink, math);
        // Keep row height independent of the scroller's unconstrained minimum width.
        if (view instanceof Gtk.Label) {
          view.set_wrap(false);
          view.set_xalign(cell.attrs.align === "right" ? 1 : cell.attrs.align === "center" ? .5 : 0);
        }
        grid.attach(view, x, y, 1, 1);
      }));
    content.append(grid);
    position.set_label(`Строки ${start + 1}–${Math.min(rows.length, start + 50)} из ${rows.length} · Столбцы ${col + 1}–${Math.min(width, col + 12)} из ${width}`);
    previous.set_sensitive(start > 0); next.set_sensitive(start + 50 < rows.length);
    left.set_sensitive(col > 0); right.set_sensitive(col + 12 < width);
  }
  host.append(position); host.append(controls);
  const caption = node.children.find(item => item.tag === "caption");
  if (caption) host.append(rich(caption.children, base, "heading", onLink, math));
  host.append(new Gtk.ScrolledWindow({ vexpand: false, child: content, hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
    vscrollbar_policy: Gtk.PolicyType.NEVER, propagate_natural_height: true }));
  render();
  return host;
}

function blocks(nodes: MarkdownNode[], base?: string, depth = 0, onLink?: LinkAction, math?: MathContext, image?: DiagramImageLoader): any {
  const host = column(8);
  if (depth > 32) { host.append(rich(nodes, base, undefined, onLink, math)); return host; }
  let position = 0;
  const more = button("Показать ещё", () => append());
  const append = () => {
    if (more.get_parent()) host.remove(more);
    const limit = Math.min(nodes.length, position + 50);
    while (position < limit) {
      const node = nodes[position++];
      if (inline.has(node.tag)) {
        const group = [node];
        while (position < nodes.length && inline.has(nodes[position].tag)) group.push(nodes[position++]);
        if (markdownText(group).trim() || group.some(item => item.tag === "task")) host.append(rich(group, base, undefined, onLink, math));
        continue;
      }
      switch (node.tag) {
        case "p": host.append(rich(node.children, base, undefined, onLink, math)); break;
        case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
          host.append(rich(node.children, base, Number(node.tag[1]) <= 3 ? `title-${node.tag[1]}` : "heading", onLink, math)); break;
        case "hr": host.append(new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL })); break;
        case "pre": {
          const code = node.children.find(item => item.tag === "code");
          const language = code?.attrs.class?.match(/(?:^|\s)language-([^\s]+)/u)?.[1];
          host.append(language?.toLowerCase() === "chart" ? markdownChartView(markdownText(node.children))
            : math && language?.toLowerCase() === "mermaid" ? mermaidView(markdownText(node.children), base, onLink, image)
            : codeView(markdownText(node.children), language));
          break;
        }
        case "blockquote": {
          const quote = row();
          quote.append(new Gtk.Separator({ orientation: Gtk.Orientation.VERTICAL }));
          quote.append(blocks(node.children, base, depth + 1, onLink, math, image));
          host.append(quote); break;
        }
        case "ul": case "ol": {
          const items = node.children.filter(item => item.tag === "li");
          const direction = Object.hasOwn(node.attrs, "reversed") ? -1 : 1;
          let index = /^[-+]?\d+$/u.test(node.attrs.start ?? "") && Number.isSafeInteger(Number(node.attrs.start))
            ? Number(node.attrs.start) : direction < 0 ? items.length : 1;
          const list = column(4);
          for (const item of items) {
            if (item.attrs.value && Number.isSafeInteger(Number(item.attrs.value))) index = Number(item.attrs.value);
            const line = row();
            const marker = label(node.tag === "ol" ? `${index}.` : "•", "dim-label");
            marker.set_valign(Gtk.Align.START);
            line.append(marker); line.append(blocks(item.children, base, depth + 1, onLink, math, image)); list.append(line);
            index += direction;
          }
          host.append(list); break;
        }
        case "table": host.append(table(node, base, onLink, math)); break;
        case "details": {
          const summary = node.children.find(item => item.tag === "summary");
          host.append(new Gtk.Expander({ label: summary ? markdownText(summary.children) : "Подробнее",
            expanded: Object.hasOwn(node.attrs, "open"), child: blocks(node.children.filter(item => item !== summary), base, depth + 1, onLink, math, image) }));
          break;
        }
        default: host.append(blocks(node.children, base, depth + 1, onLink, math, image));
      }
    }
    if (position < nodes.length) host.append(more);
  };
  append();
  return host;
}

export interface MarkdownViewOptions { chat?: boolean; controls?: boolean; onLink?: LinkAction; diagramImages?: DiagramImageLoader }

export function markdownView(source: string, base?: string, options: MarkdownViewOptions = {}): any {
  const host = column(8);
  const actions = row();
  actions.append(button(options.chat ? "Скопировать сообщение" : "Скопировать Markdown", () => host.get_clipboard().set(source)));
  if (!options.chat && options.controls !== false) host.append(actions);
  try {
    const nodes = options.chat ? chatDocument(source, base) : markdownDocument(source);
    host.append(blocks(nodes, base, 0, options.onLink, options.chat ? new MathContext(nodes) : undefined, options.diagramImages));
  }
  catch { const fallback = label(source); fallback.set_selectable(true); host.append(fallback); }
  if (options.controls === false) return host;
  if (options.chat) host.append(actions);
  const original = new Gtk.Expander({ label: "Исходный Markdown" });
  original.connect("notify::expanded", () => {
    if (!original.get_expanded() || original.get_child()) return;
    const text = new Gtk.TextView({ editable: false, cursor_visible: false, monospace: true, wrap_mode: Gtk.WrapMode.WORD_CHAR });
    text.get_buffer().set_text(source, -1);
    original.set_child(new Gtk.ScrolledWindow({ vexpand: false, child: text, min_content_height: 100, max_content_height: 260,
      propagate_natural_height: true, hscrollbar_policy: Gtk.PolicyType.NEVER }));
  });
  host.append(original);
  return host;
}
