// Extracted verbatim from razzant/ouroboros 15cacd32310868934da44d3c5c6b68ccb6cf458a
// web/modules/chat_markdown.js. Copyright (c) 2026 Anton Razzhigaev, MIT.
// See ouroboros.LICENSE and README.md.
export function prepareMarkdownSource(text) {
    const raw = String(text ?? '');
    const unused = (reference) => {
        while (raw.includes(reference)) reference = reference.replace('&#', '&#0');
        return reference;
    };
    const lessThan = unused('&#60;');
    const escapedLessThan = unused(lessThan.replace('&#', '&#0'));
    const source = raw.replace(/(\\?<)(?!(?:https?|mailto):[^\s<>]*>)|\\[\s\S]/gi, (match, opener) => (
        opener === '<' ? lessThan : opener ? escapedLessThan : match));
    return { source, lessThan, escapedLessThan };
}

// Attribute text in marked's own manner: an entity (including `lessThan`) stays
// an entity for the browser to read, everything else that could end the value is
// escaped.
function attributeText(value) {
    return String(value ?? '').replace(/&(?!#?\w+;)/g, '&amp;').replace(/"/g, '&quot;').replace(/>/g, '&gt;');
}

// A forbidden image keeps its words and its address (#1368). Nothing loads: the
// renderer writes an inert placeholder (a link would nest inside a linked image
// and break it), and the link pass decides what it becomes. The address is
// encoded exactly as marked encodes a link's.
export function renderImageReference({ href, title, tokens, text }) {
    const alt = tokens ? this.parser.parseInline(tokens) : attributeText(text);
    let address = '';
    try { address = encodeURI(String(href ?? '')).replace(/%25/g, '%'); } catch { address = ''; }
    const titleAttr = title ? ` title="${attributeText(title)}"` : '';
    return `<span class="md-image-ref" data-md-image-href="${attributeText(address)}"${titleAttr}>`
        + `Image${alt ? `: ${alt}` : ''}</span>`;
}

const INLINE_CODE = /(?<!(?<!\\)(?:\\\\)*[\\`])(`+)(?!`)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)/g;
// A line whose ``` could still open a fence: the run leads it, after only a quote's or
// list item's marks (marked reads a task box's text as inline), and no backtick follows.
const FENCE_LEAD = /^(?:[ \t]*(?:>|(?:[-+*]|\d{1,9}[.)])[ \t]))*[ \t]*`{3,}[^`]*$/;
// The code elements marked writes; their text holds no raw `<`.
const RENDERED_CODE = /(<code\b[^>]*>[\s\S]*?<\/code>)/;
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Code marked read inside a quote or list item, as [first line, its lines] of the
// top-level block's raw; every other block in it, and each table row, as [first
// line], since a code span never leaves one. marked strips a container's marks
// line by line and lexes what is left, so the children spell that text and its
// line N is raw line N. false when a child cannot be placed so: the caller then
// keeps the whole block literal.
// A task item's text has lost its `[ ] ` box, which marked keeps as the first child
// (a loose item's first paragraph starts with it): the children spell box + text.
function nestedCode(token, line, found) {
    const children = token.type === 'list' ? token.items
        : token.type === 'blockquote' || token.type === 'list_item' ? token.tokens : [];
    const box = token.type === 'list_item' && token.task
        ? [children?.[0], children?.[0]?.tokens?.[0]].find((child) => child?.type === 'checkbox') : null;
    const text = String(box?.raw ?? '') + String((token.type === 'list' ? token.raw : token.text) ?? '');
    if (token.type === 'table') token.raw.split('\n').forEach((_, row) => found.push([line + row]));
    let offset = 0;
    for (const child of children || []) {
        if (typeof child?.raw !== 'string' || !text.startsWith(child.raw, offset)) return false;
        if (child.type === 'code') {
            found.push([line, child.raw.replace(/\n+$/, '').split('\n')]);
        } else {
            found.push([line]);
            if (!nestedCode(child, line, found)) return false;
        }
        offset += child.raw.length;
        line += child.raw.split('\n').length - 1;
    }
    return true;
}

// The author's text split into [text, isCode] runs: every code block (fenced or
// indented, top-level or nested in a quote or list item) as marked's own lexer
// reads it, then the code spans inside the rest, each within its own block. Adjacent
// prose runs join, so math may still span them, but never across a code block.
function splitAuthorCode(source, parser) {
    const blocks = typeof parser?.lexer === 'function' ? parser.lexer(source) : [{ raw: source }];
    const runs = [];
    const push = (text, code) => {
        if (!code && runs.length && !runs.at(-1)[1]) runs.at(-1)[0] += text;
        else runs.push([text, code]);
    };
    const pushProse = (text) => {
        let last = 0;
        for (const match of text.matchAll(INLINE_CODE)) {
            push(text.slice(last, match.index), false);
            push(match[0], true);
            last = match.index + match[0].length;
        }
        push(text.slice(last), false);
    };
    for (const block of blocks) {
        if (block.type === 'code') { push(block.raw, true); continue; }
        const found = [];
        const lines = block.raw.split('\n');
        // Each nested code line must end its raw line (after the container's marks).
        if (!nestedCode(block, 0, found)
            || found.some(([at, code = []]) => code.some((text, k) => !lines[at + k]?.endsWith(text)))) {
            push(block.raw, true);
            continue;
        }
        const starts = [0];
        for (const text of lines) starts.push(starts.at(-1) + text.length + 1);
        let last = 0;
        for (const [at, code = []] of found) {
            if (starts[at] < last) continue; // it opens on the last line of the code before it
            pushProse(block.raw.slice(last, starts[at]));
            last = code.length ? starts[at + code.length] - 1 : starts[at];
            if (code.length) push(block.raw.slice(starts[at], last), true);
        }
        pushProse(block.raw.slice(last));
    }
    return runs;
}

// Math is parked only outside the author's code, and each block comes back as
// marked would write that same text where it landed: code encodes every `&`,
// prose keeps an entity an entity (the one layer it reads). No `<` returns raw.
// Parked math skips marked's escapes, so `authorText` gives it back its `\<`.
export function protectLatexDelimiters(source, parser, authorText = (text) => text) {
    const rawSource = String(source).replace(/\r\n?/g, '\n'); // marked's own first step
    let tokenStem = 'OUROBOROSLATEX';
    while (rawSource.includes(tokenStem)) tokenStem += 'X';
    const replacements = [
        ['\\(', `${tokenStem}OPENINLINE`],
        ['\\)', `${tokenStem}CLOSEINLINE`],
        ['\\[', `${tokenStem}OPENBLOCK`],
        ['\\]', `${tokenStem}CLOSEBLOCK`],
    ];
    const displayBlocks = [];
    // Without a math delimiter there is nothing to park and no second lex to pay.
    const runs = /\$\$|\\[()[\]]/.test(rawSource) ? splitAuthorCode(rawSource, parser) : [[rawSource, true]];
    // What marked will read of the line being written: the code before it and the
    // math already parked on it count, since a code span or math may cross lines.
    let line = '';
    const write = (text) => {
        const end = text.lastIndexOf('\n');
        line = end < 0 ? line + text : text.slice(end + 1);
        return text;
    };
    const protectedSource = runs
        .map(([part, code]) => {
            if (code) return write(part);
            let last = 0;
            const withProtectedBlocks = part.replace(/\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]/g, (block, at) => {
                write(part.slice(last, at));
                last = at + block.length;
                // After a ``` that could open a fence, math keeps that line's backticks in view:
                // marked read the line as text for one of them, and parking it would open a fence.
                if (/^[^\n]*`/.test(block) && FENCE_LEAD.test(line)) return write(block);
                const token = `${tokenStem}DISPLAY${displayBlocks.length}`;
                displayBlocks.push([token, authorText(block)]);
                return write(token);
            });
            write(part.slice(last));
            return replacements.reduce(
                (value, [delimiter, token]) => value.split(delimiter).join(token),
                withProtectedBlocks,
            );
        })
        .join('');
    return {
        protectedSource,
        restore: (html) => String(html).split(RENDERED_CODE).map((part, index) => {
            const escape = index % 2 === 1 ? /[&<>"']/g : /[<>"']|&(?!#?\w+;)/g;
            return displayBlocks.reduceRight(
                (value, [token, block]) => value.split(token).join(block.replace(escape, (char) => HTML_ESCAPES[char])),
                replacements.reduce((value, [delimiter, token]) => value.split(token).join(delimiter), part),
            );
        }).join(''),
    };
}

