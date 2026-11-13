import assert from 'node:assert/strict';
import test from 'node:test';
import { chatDocument, chatHref, chatDownloadRoute, chatPlainMarkup, chatUsesMarkdown } from '../dist-gjs/gjs/chat-text.js';
import { markdownText, markdownInline } from '../dist-gjs/gjs/markdown-document.js';
const all = nodes => nodes.flatMap(node => [node, ...all(node.children)]);
const base = 'https://gateway.example';

test('role and explicit system Markdown marker select the chat reading', () => {
  for (const row of [{role:'assistant'}, {role:'system',markdown:true}, {role:'system',system_type:'skill_review',markdown:true,narration:true}]) assert.equal(chatUsesMarkdown(row), true);
  for (const row of [{role:'user',markdown:true}, {role:'system'}, {role:'system',system_type:'skill_review',markdown:true}]) assert.equal(chatUsesMarkdown(row), false);
});

test('chat keeps line breaks and raw HTML literally without losing its text', () => {
  const doc = chatDocument('**bold**\nnext\n\n<b>literal</b> <script>never_run()</script> &copy;', base);
  assert.equal(markdownInline(doc[0].children), '<b>bold</b>\nnext');
  assert.ok(markdownText(doc).includes('<b>literal</b> <script>never_run()</script> ©'));
  assert.ok(!all(doc).some(node => ['b', 'script'].includes(node.tag)));
  assert.ok(markdownInline(doc).includes('&lt;script&gt;'));
});

test('literal code restores raw and escaped angle brackets without decoding author entities', () => {
  const source = '`<b>&lt;x&gt;&`\n\n```html\n<script>&lt;literal&gt;\\<tag>\n```';
  const tree = all(chatDocument(source, base));
  assert.deepEqual(tree.filter(node => node.tag === 'code').map(node => markdownText(node.children)), ['<b>&lt;x&gt;&', '<script>&lt;literal&gt;\\<tag>\n']);
  for (const source of ['&#60; &#060; <tag>', '&#060; &#60; <tag>']) assert.ok(markdownText(chatDocument(source)).includes('<tag>'));
});

test('chat protects math delimiters and literal code through the Markdown parser', () => {
  const source = String.raw`\(x_1\) and \[a<b\]`;
  assert.equal(markdownText(chatDocument(source)[0].children), source);
  const blocks = Array.from({length:12}, (_, i) => `$$x_${i} < ${i}$$`).join('\n\n');
  const shown = markdownText(chatDocument(blocks));
  for (let i=0;i<12;i++) assert.ok(shown.includes(`$$x_${i} < ${i}$$`));
  assert.equal(markdownText(all(chatDocument('`\\(x\\)`')).find(node=>node.tag==='code').children), '\\(x\\)');
});

test('images stay references with guarded links, including images inside authored links', () => {
  const tree = all(chatDocument('![**Chart**](https://e.example/a.png "image") [![inner](https://e.example/inner.png)](https://e.example/outer) ![bad](javascript:bad())', base));
  assert.ok(!tree.some(node => node.tag === 'img'));
  assert.ok(markdownText(tree.slice(0,1)).includes('Изображение: Chart'));
  assert.deepEqual(tree.filter(node => node.tag === 'a').map(node => node.attrs.href), ['https://e.example/a.png', 'https://e.example/outer']);
  assert.ok(markdownText(tree.slice(0,1)).includes('Изображение: bad'));
});

test('chat only accepts exact relative download routes and external HTTP(S)/mailto', () => {
  assert.equal(chatHref('/api/files/download?path=reports%2Ffinal%20copy.pdf', base), base+'/api/files/download?path=reports%2Ffinal+copy.pdf');
  assert.equal(chatDownloadRoute(base+'/api/files/download?path=reports%2Ffinal+copy.pdf', base), '/api/files/download?path=reports%2Ffinal+copy.pdf');
  assert.equal(chatDownloadRoute('https://other.example/api/files/download?path=a', base), undefined);
  for(const raw of ['/other', '//other.example/api/files/download?path=a', '/api/files/download?path=../secret', '/api/files/download?path=%2Fetc%2Fpasswd', '/api/files/download?path=a&extra=b', '/api/files/download?path=a#hash', '/api/files/download?path=a&path=b', '/api/files/download?path=a%5Cb', 'javascript:x', 'file:///etc/passwd', 'data:text/plain,x']) assert.equal(chatHref(raw,base), undefined, raw);
  assert.equal(chatHref('mailto:a@example.org',base),'mailto:a@example.org');
});

test('owner text remains byte-for-byte literal while explicit addresses become links', () => {
  const source='**literal** <script>x</script>\nhttps://e.example/Foo_(bar)). https://e.example/path?q=a&b=c!';
  const markup=chatPlainMarkup(source);
  assert.ok(markup.startsWith('**literal** &lt;script&gt;x&lt;/script&gt;\n'));
  assert.ok(markup.includes('href="https://e.example/Foo_(bar)"'));
  assert.ok(markup.endsWith('href="https://e.example/path?q=a&amp;b=c">https://e.example/path?q=a&amp;b=c</a>!'));
  assert.ok(!chatPlainMarkup('ahttps://e.example http://\\bad https://e.example\\path').includes('href="http://'));
});
