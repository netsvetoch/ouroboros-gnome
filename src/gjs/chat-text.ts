import { chatMarkdownTree } from "./vendor/markdown-parser.js";
import { FieldURL } from "./vendor/field-url.js";
import { cleanMarkdown, markdownEscape, type MarkdownNode } from "./markdown-document.js";

export interface ChatTextFields { role?: string; markdown?: boolean; system_type?: string; narration?: boolean }

export function chatUsesMarkdown(row: ChatTextFields): boolean {
  return row.role !== "user" && !(row.role === "system" && row.system_type === "skill_review" && row.narration !== true)
    && (row.role !== "system" || row.markdown === true);
}

function downloadRoute(uri: FieldURL): string | undefined {
  const params = [...uri.searchParams.entries()];
  if (uri.pathname !== "/api/files/download" || uri.hash || params.length !== 1 || params[0][0] !== "path") return undefined;
  const path = params[0][1];
  if (!path || path.length > 4096 || /[\\\x00-\x1f\x7f]/u.test(path)
    || !path.split("/").every(part => part && part !== "." && part !== "..")) return undefined;
  const encoded = encodeURIComponent(path).replace(/[!'()~]/gu, char => "%" + char.charCodeAt(0).toString(16).toUpperCase()).replace(/%20/gu, "+");
  return "/api/files/download?path=" + encoded;
}

export function chatHref(raw: string | undefined, base?: string): string | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  try {
    if (text.startsWith("/")) {
      if (!base) return undefined;
      const origin = new FieldURL(base).origin;
      const uri = new FieldURL(text, origin);
      const route = uri.origin === origin ? downloadRoute(uri) : undefined;
      return route ? origin + route : undefined;
    }
    const uri = new FieldURL(text);
    return ["http:", "https:", "mailto:"].includes(uri.protocol) && !uri.username && !uri.password ? uri.href : undefined;
  } catch { return undefined; }
}

export function chatDownloadRoute(href: string, base: string): string | undefined {
  try {
    const uri = new FieldURL(href, new FieldURL(base).origin);
    return uri.origin === new FieldURL(base).origin && !uri.username && !uri.password ? downloadRoute(uri) : undefined;
  } catch { return undefined; }
}

export function chatDocument(source: string, base?: string): MarkdownNode[] {
  const nodes = cleanMarkdown(chatMarkdownTree(source).childNodes ?? [], 0, true);
  const pending: [MarkdownNode, boolean][] = nodes.map(node => [node, false]);
  while (pending.length) {
    const [node, linked] = pending.pop()!;
    const image = node.tag === "image-reference";
    if (image) {
      const descendants = [...node.children];
      let containsLink = false;
      while (descendants.length) { const child = descendants.pop()!; containsLink ||= child.tag === "a"; descendants.push(...child.children); }
      const href = !linked && !containsLink ? chatHref(node.attrs.href, base) : undefined;
      node.tag = href ? "a" : "span";
      node.attrs = href ? { href, title: node.attrs.title ?? "" } : {};
      const first = node.children[0];
      if (first?.tag === "text") first.text = first.text?.replace(/^Image(?=: |$)/u, "Изображение");
    } else if (node.tag === "a") {
      const href = !linked ? chatHref(node.attrs.href, base) : undefined;
      if (href) node.attrs.href = href;
      else delete node.attrs.href;
    }
    for (const child of node.children) pending.push([child, linked || node.tag === "a"]);
  }
  return nodes;
}

const addressPattern = /(?<![\p{L}\p{N}_])https?:\/\/(?![/\\])[^\s<>"`\\\p{Cc}\p{Cf}]+/giu;
const trailing = new Set([...".,:;!?…'’”»›。、，；：！？"]);
const closers: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

function addressEnd(text: string): number {
  const count: Record<string, number> = { "(": 0, "[": 0, "{": 0, ")": 0, "]": 0, "}": 0 };
  for (const char of text) if (Object.hasOwn(count, char)) count[char]++;
  let end = text.length;
  while (end) {
    const char = text[end - 1], opener = closers[char];
    if (opener && count[char] > count[opener]) count[char]--;
    else if (!trailing.has(char)) break;
    end--;
  }
  return end;
}

export function chatPlainMarkup(source: string): string {
  let markup = "", from = 0;
  for (const match of source.matchAll(addressPattern)) {
    const address = match[0].slice(0, addressEnd(match[0]));
    const href = chatHref(address);
    if (!href) continue;
    markup += markdownEscape(source.slice(from, match.index)) + `<a href="${markdownEscape(href)}">${markdownEscape(address)}</a>`;
    from = match.index + address.length;
  }
  return markup + markdownEscape(source.slice(from));
}
