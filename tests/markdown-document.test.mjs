import assert from 'node:assert/strict';
import test from 'node:test';
import { markdownDocument, markdownText, markdownInline, markdownHref } from '../dist-gjs/gjs/markdown-document.js';

const all = nodes => nodes.flatMap(node => [node, ...all(node.children)]);

test('GFM headings, emphasis, lists, code, tasks and tables remain structural', () => {
  const nodes = markdownDocument('# Heading\n\n**bold** *italic* ~~gone~~ `a < b`\n\n0. zero\n1. one\n\n- [x] done\n- [ ] waiting\n\n| A | B |\n| - | -: |\n| one | two |');
  const tree = all(nodes);
  assert.ok(tree.some(node => node.tag === 'h1'));
  assert.ok(tree.some(node => node.tag === 'ol' && node.attrs.start === '0'));
  assert.equal(tree.filter(node => node.tag === 'task').length, 2);
  assert.deepEqual(tree.filter(node => node.tag === 'task').map(node => node.attrs.checked), ['true', 'false']);
  assert.ok(tree.some(node => node.tag === 'table'));
  assert.ok(tree.some(node => node.tag === 'td' && node.attrs.align === 'right'));
  const paragraph = nodes.find(node => node.tag === 'p');
  assert.equal(markdownInline(paragraph.children), '<b>bold</b> <i>italic</i> <s>gone</s> <tt>a &lt; b</tt>');
});

test('HTML is parsed as data and active content never becomes markup', () => {
  const nodes = markdownDocument('<script>do_not_run()</script><style>hidden-style</style><iframe>hidden-frame</iframe>\n\n<p onclick="bad()" style="color:red"><b>Visible &amp; safe</b> <a href="javascript:bad()">bad-link</a></p>\n\n![Alternative](https://example.invalid/remote.png)');
  const tree = all(nodes);
  assert.ok(!tree.some(node => ['script', 'style', 'iframe', 'img', 'input'].includes(node.tag)));
  assert.ok(!tree.some(node => Object.keys(node.attrs).some(key => key.startsWith('on') || key === 'style' || key === 'src')));
  const text = markdownText(nodes);
  assert.ok(text.includes('Visible & safe'));
  assert.ok(text.includes('Alternative'));
  assert.ok(!text.includes('do_not_run') && !text.includes('hidden-style') && !text.includes('hidden-frame'));
  const markup = markdownInline(nodes, 'https://gateway.example');
  assert.ok(!markup.includes('javascript:') && !markup.includes('<script'));
});

test('links resolve from the gateway origin and unsafe protocols stay plain', () => {
  assert.equal(markdownHref('/report?a=1&b=2', 'https://gateway.example/mounted'), 'https://gateway.example/report?a=1&b=2');
  assert.equal(markdownHref('report', 'https://gateway.example/mounted'), 'https://gateway.example/report');
  assert.equal(markdownHref('mailto:a@example.org'), 'mailto:a@example.org');
  for (const href of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'https://user:secret@example.org/']) {
    assert.equal(markdownHref(href, 'https://gateway.example'), undefined);
  }
  const doc = markdownDocument('[safe](/report?a=1&b=2 "A & B") [bad](javascript:alert(1))');
  const markup = markdownInline(doc, 'https://gateway.example');
  assert.ok(markup.includes('href="https://gateway.example/report?a=1&amp;b=2"'));
  assert.ok(markup.includes('title="A &amp; B"'));
  assert.ok(!markup.includes('href="javascript:'));
});

test('HTML entities, literal fenced code, details and deep text survive', () => {
  const doc = markdownDocument('Text &copy; &#x1f98a;\n\n```html\n<script>&literal</script>\n```\n\n<details open><summary>More</summary><p>Body</p></details>');
  const tree = all(doc);
  assert.ok(markdownText(doc).includes('Text © 🦊'));
  const pre = tree.find(node => node.tag === 'pre');
  assert.equal(markdownText(pre.children), '<script>&literal</script>\n');
  assert.ok(tree.some(node => node.tag === 'details' && Object.hasOwn(node.attrs, 'open')));
  const deep = markdownDocument('<div>'.repeat(100) + 'Deep text' + '</div>'.repeat(100));
  assert.ok(markdownText(deep).includes('Deep text'));
});
