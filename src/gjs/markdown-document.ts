import { markdownTree, type HtmlNode } from "./vendor/markdown-parser.js";
import { FieldURL } from "./vendor/field-url.js";

export interface MarkdownNode { tag: string; text?: string; attrs: Record<string, string>; children: MarkdownNode[] }

const hidden = new Set(["script", "style", "iframe", "object", "embed", "video", "audio", "source", "template", "svg", "math", "canvas", "noscript"]);
const attributes = new Set(["href", "title", "start", "align", "reversed", "value", "id", "class", "open"]);

function textNode(text: string): MarkdownNode { return { tag: "text", text, attrs: {}, children: [] }; }

function plainHtml(nodes: HtmlNode[]): string {
  const pending = [...nodes].reverse();
  let text = "";
  while (pending.length) {
    const node = pending.pop()!;
    if (hidden.has(node.tagName ?? "") || node.nodeName === "#comment") continue;
    if (node.nodeName === "#text") text += node.value ?? "";
    else pending.push(...[...(node.childNodes ?? [])].reverse());
  }
  return text;
}

export function cleanMarkdown(nodes: HtmlNode[], depth: number, chat = false): MarkdownNode[] {
  if (depth > 64) return [textNode(plainHtml(nodes))];
  return nodes.flatMap(node => {
    if (node.nodeName === "#text") return [textNode(node.value ?? "")];
    const tag = node.tagName;
    if (!tag || hidden.has(tag)) return [];
    const attrs = Object.fromEntries((node.attrs ?? []).map(item => [item.name, item.value]));
    if (tag === "input") return attrs.type === "checkbox" && Object.hasOwn(attrs, "disabled")
      ? [{ tag: "task", attrs: { checked: Object.hasOwn(attrs, "checked") ? "true" : "false" }, children: [] }] : [];
    if (tag === "img") return attrs.alt ? [{ tag: "image-alt", attrs: {}, children: [textNode(attrs.alt)] }] : [];
    const children = cleanMarkdown(node.childNodes ?? [], depth + 1, chat);
    if (chat && tag === "span" && attrs.class === "md-image-ref") return [{ tag: "image-reference",
      attrs: { href: attrs["data-md-image-href"] ?? "", title: attrs.title ?? "" }, children }];
    if (tag === "form") return children;
    return [{ tag, attrs: Object.fromEntries(Object.entries(attrs).filter(([name]) => attributes.has(name))), children }];
  });
}

export function markdownDocument(source: string): MarkdownNode[] {
  return cleanMarkdown(markdownTree(source).childNodes ?? [], 0);
}

export function markdownText(nodes: MarkdownNode[]): string {
  let text = "";
  const pending = [...nodes].reverse();
  while (pending.length) {
    const node = pending.pop()!;
    if (node.tag === "text") text += node.text ?? "";
    else if (node.tag === "br") text += "\n";
    else pending.push(...[...node.children].reverse());
  }
  return text;
}

export function markdownHref(raw: string | undefined, base?: string): string | undefined {
  if (!raw) return undefined;
  try {
    const uri = new FieldURL(raw, base ? new FieldURL(base).origin + "/" : undefined);
    if (!["http:", "https:", "ftp:", "mailto:", "tel:", "sms:", "xmpp:", "irc:", "ircs:", "news:", "nntp:"].includes(uri.protocol)
      || uri.username || uri.password) return undefined;
    return uri.href;
  } catch { return undefined; }
}

export function markdownEscape(value: string): string {
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/gu, "�")
    .replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
}

export function markdownInline(nodes: MarkdownNode[], base?: string): string {
  return nodes.map(node => {
    const inside = () => markdownInline(node.children, base);
    switch (node.tag) {
      case "text": return markdownEscape((node.text ?? "").replace(/[ \t\r\n\f]+/gu, " "));
      case "br": return "\n";
      case "b": case "strong": return `<b>${inside()}</b>`;
      case "i": case "em": case "var": return `<i>${inside()}</i>`;
      case "code": case "kbd": case "samp": return `<tt>${inside()}</tt>`;
      case "s": case "strike": case "del": return `<s>${inside()}</s>`;
      case "u": case "ins": return `<u>${inside()}</u>`;
      case "sub": return `<sub>${inside()}</sub>`;
      case "sup": return `<sup>${inside()}</sup>`;
      case "small": return `<small>${inside()}</small>`;
      case "a": {
        const href = markdownHref(node.attrs.href, base);
        return href ? `<a href="${markdownEscape(href)}"${node.attrs.title ? ` title="${markdownEscape(node.attrs.title)}"` : ""}>${inside()}</a>` : inside();
      }
      case "image-alt": return `[${inside()}]`;
      case "task": return node.attrs.checked === "true" ? "☑ " : "☐ ";
      default: return inside();
    }
  }).join("");
}
