export interface HtmlNode {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: HtmlNode[];
}
export declare function markdownTree(text: string): HtmlNode;
export declare function chatMarkdownTree(text: string): HtmlNode;
