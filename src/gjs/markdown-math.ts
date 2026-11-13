import { markdownInline, markdownHref, type MarkdownNode } from "./markdown-document.js";

export type MathPart = { kind: "text"; text: string } | { kind: "math"; source: string; raw: string; display: boolean };
export type MathRun = { kind: "text"; markup: string; href?: string } | (Exclude<MathPart, { kind: "text" }> & { owner: MarkdownNode; offset: number });

/** Delimiters and brace/escape handling match the gateway's KaTeX auto-render. */
export function splitMath(text: string): MathPart[] {
  const parts: MathPart[] = [];
  const opening = /\$\$|\\\[|\\\(/gu;
  let from = 0, match: RegExpExecArray | null;
  while ((match = opening.exec(text))) {
    const left = match[0], right = left === "$$" ? "$$" : left === "\\[" ? "\\]" : "\\)";
    const start = match.index + left.length;
    let end = -1, braces = 0;
    for (let pos = start; pos < text.length; pos++) {
      if (braces <= 0 && text.startsWith(right, pos)) { end = pos; break; }
      const char = text[pos];
      if (char === "\\") pos++;
      else if (char === "{") braces++;
      else if (char === "}") braces--;
    }
    if (end < 0) break;
    if (match.index > from) parts.push({ kind: "text", text: text.slice(from, match.index) });
    from = end + right.length;
    parts.push({ kind: "math", source: text.slice(start, end), raw: text.slice(match.index, from), display: left !== "\\(" });
    opening.lastIndex = from;
  }
  if (from < text.length) parts.push({ kind: "text", text: text.slice(from) });
  return parts;
}

/** Never join across markup elements or treat code/attributes as mathematics. */
export function mathRuns(nodes: MarkdownNode[], base?: string): MathRun[] {
  const runs: MathRun[] = [];
  const wrap = (node: MarkdownNode, parents: MarkdownNode[]) => parents.reduceRight((child, parent) => ({ ...parent, children: [child] }), node);
  const append = (node: MarkdownNode, parents: MarkdownNode[], href?: string) => {
    const markup = markdownInline([wrap(node, parents)], base);
    if (markup) runs.push({ kind: "text", markup, href });
  };
  const walk = (nodes: MarkdownNode[], parents: MarkdownNode[], href?: string) => {
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index];
      if (node.tag === "text") {
        let text = node.text ?? "";
        while (nodes[index + 1]?.tag === "text") text += nodes[++index].text ?? "";
        let offset = 0;
        for (const part of splitMath(text)) {
          if (part.kind === "math") runs.push({ ...part, owner: node, offset });
          else append({ ...node, text: part.text }, parents, href);
          offset += part.kind === "math" ? part.raw.length : part.text.length;
        }
      } else if (["code", "kbd", "samp", "pre"].includes(node.tag) || !node.children.length) append(node, parents, href);
      else if (node.tag === "a") walk(node.children, parents, markdownHref(node.attrs.href, base) ?? href);
      else walk(node.children, [...parents, node], href);
    }
  };
  walk(nodes, []);
  return runs;
}
