import assert from 'node:assert/strict';
import test from 'node:test';
import {splitMath,mathRuns} from '../dist-gjs/gjs/markdown-math.js';
import {renderMathSvg} from '../dist-gjs/gjs/math-svg.js';
import {chatDocument} from '../dist-gjs/gjs/chat-text.js';
import fs from 'node:fs';
import {MathContext} from '../dist-gjs/gjs/math-context.js';
import {texMathML,mathParserVersion} from '../dist-gjs/gjs/vendor/math-engine.js';

test('only the three gateway delimiters produce math, preserving raw source',()=>{
 const parts=splitMath(String.raw`Price $5; \(a^2\), $$\frac{x}{y}$$ and \[z\].`);
 assert.deepEqual(parts.filter(x=>x.kind==='math').map(({source,raw,display})=>({source,raw,display})),[
  {source:'a^2',raw:String.raw`\(a^2\)`,display:false},
  {source:String.raw`\frac{x}{y}`,raw:String.raw`$$\frac{x}{y}$$`,display:true},
  {source:'z',raw:String.raw`\[z\]`,display:true}]);
 assert.equal(parts.filter(x=>x.kind==='text').map(x=>x.text).join(''),'Price $5; ,  and .');
});
test('closing delimiters respect escaped characters and nested braces; unmatched input stays literal',()=>{
 const source=String.raw`before \(\text{a \) b} + \{x\}\) after`;
 assert.equal(splitMath(source)[1].source,String.raw`\text{a \) b} + \{x\}`);
 for(const source of [String.raw`\(x`,String.raw`$$a{b$$`,String.raw`\[a\] trailing \(b`]){
  const parts=splitMath(source);assert.equal(parts.map(p=>p.kind==='text'?p.text:p.raw).join(''),source);
 }
});
test('rich prose keeps formatting and links, while code and attributes never become formulas',()=>{
 const nodes=chatDocument(String.raw`**Bold \(x\)** [link](https://example.org) and \(y\), code \`\(z\)\`.

\`\`\`tex
\(w\)
\`\`\``.replaceAll('\\`','`'));
 const p=nodes.find(n=>n.tag==='p'),runs=mathRuns(p.children);
 assert.deepEqual(runs.filter(r=>r.kind==='math').map(r=>r.source),['x','y']);
 assert.ok(runs.some(r=>r.kind==='text'&&r.markup.includes('<b>Bold ')));
 assert.ok(runs.some(r=>r.kind==='text'&&r.href==='https://example.org/'&&r.markup==='link'));
 assert.ok(runs.some(r=>r.kind==='text'&&r.markup.includes('<tt>')));
 const adjacent=mathRuns([{tag:'text',text:'\\(',attrs:{},children:[]},{tag:'text',text:'x\\)',attrs:{},children:[]}]);
 assert.equal(adjacent[0].source,'x');
 assert.equal(mathRuns([{tag:'b',attrs:{},children:[{tag:'text',text:'\\(',attrs:{},children:[]}]},{tag:'text',text:'x\\)',attrs:{},children:[]}]).filter(r=>r.kind==='math').length,0);
});
test('local SVG supports fractions, sums, matrices, aligned cases, accents, color, chemistry and macros',()=>{
 for(const source of [String.raw`\frac{a}{b}`,String.raw`\sum_{n=1}^{\infty}\frac{1}{n^2}=\frac{\pi^2}{6}`,String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`,String.raw`\begin{aligned}f(x)&=x^2\\f'(x)&=2x\end{aligned}`,String.raw`\begin{cases}x^2&x>0\\-x&x\le 0\end{cases}`,String.raw`\widehat{ABC}+\sqrt[3]{x}`,String.raw`\textcolor{red}{x}`,String.raw`\mathrm{2H_2+O_2\to2H_2O}`,String.raw`\newcommand{\foo}{x^2}\foo`]){
  const result=renderMathSvg(source,true);assert.ok(result.svg.startsWith('<svg '));assert.ok(result.svg.includes('<path '),source);assert.ok(result.width>0&&result.height>0&&result.baseline<=result.height);assert.ok(!/href=|<image\b|<foreignObject\b/.test(result.svg));
 }
 const inline=renderMathSvg(String.raw`\frac{a}{b}`,false),display=renderMathSvg(String.raw`\frac{a}{b}`,true);
 assert.ok(display.height>inline.height);assert.ok(Math.abs(renderMathSvg('x',false,32).width-2*renderMathSvg('x',false,16).width)<=1);
});
test('errors, recursive/oversized input and external resources do not become a renderable SVG',()=>{
 for(const source of [String.raw`\doesNotExist`,String.raw`\frac{a}`,String.raw`\def\foo{\foo}\foo`,String.raw`\color{url(https://example.org/p)}x`,'x'.repeat(32769),String.raw`\rule{100000px}{100000px}`])assert.throws(()=>renderMathSvg(source,true),source.slice(0,100));
 renderMathSvg(String.raw`\def\testmacro{x}\testmacro`,false);
 assert.throws(()=>renderMathSvg(String.raw`\testmacro`,false),'macro leaked between separate expressions');
 assert.ok(renderMathSvg('x',false,16,'#102030').svg.startsWith('<svg color="#102030"'));
});

test('KaTeX MathML and parse errors match 54 cases from the pinned gateway bundle',()=>{
 const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/katex-gateway-0.17.json',import.meta.url),'utf8'));
 assert.equal(mathParserVersion,fixture.version);
 for(const group of fixture.groups){let macros={};for(const item of group.expressions){
  if(group.reset)macros={};
  if(item.error)assert.throws(()=>texMathML(item.source,item.display,macros),error=>error.rawMessage===item.error,item.source);
  else {assert.equal(texMathML(item.source,item.display,macros),item.mathml,item.source);const svg=renderMathSvg(item.source,item.display,16,'#242424',macros).svg;assert.ok(!/data-mml-node="merror"|(?:href|src)=|<image\b|<foreignObject\b/u.test(svg),item.source)}
 }}
});

test('document macros are evaluated once in source order, independent of lazy display order',()=>{
 const nodes=chatDocument(String.raw`\(\gdef\shared{x}\shared\)

\(\shared\)

\(\gdef\shared{y}\shared\)

\(\shared\)`);
 const context=new MathContext(nodes),runs=mathRuns(nodes).filter(r=>r.kind==='math');
 assert.equal(context.formula(runs[3]).svg,renderMathSvg('y',false).svg);
 assert.equal(context.formula(runs[1]).svg,renderMathSvg('x',false).svg);
 assert.equal(context.formula(runs[1]).svg,context.formula(runs[1]).svg);
 const other=chatDocument(String.raw`\(\shared\)`),isolated=new MathContext(other);
 assert.throws(()=>isolated.formula(mathRuns(other)[0]),/Undefined control sequence/);
 const table=chatDocument('| Formula |\n| --- |\n'+Array.from({length:51},(_,i)=>'| '+(i===50?String.raw`\(\gdef\fromtable{z}\fromtable\)`:'row'+i)+' |').join('\n')+'\n\n'+String.raw`\(\fromtable\)`);
 const tableContext=new MathContext(table),afterTable=mathRuns(table).filter(r=>r.kind==='math').at(-1);
 assert.equal(tableContext.formula(afterTable).svg,renderMathSvg('z',false).svg);
});
