import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { selectCodeLanguage, codeHighlightLimit } from '../dist-gjs/gjs/code-language.js';
import { detectCodeLanguage, detectorLanguages } from '../dist-gjs/gjs/vendor/code-detector.js';
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/code-language-detection.json',import.meta.url),'utf8'));

test('automatic detection matches the pinned gateway common-language bundle',()=>{
  assert.deepEqual(detectorLanguages(),fixture.languages);
  for(const sample of fixture.cases) assert.equal(detectCodeLanguage(sample.source)??null,sample.language,sample.source);
});

test('fence language names map to native IDs before automatic detection',()=>{
  const ids=new Set(['js','typescript','typescript-jsx','jsx','python3','sh','cpp','c-sharp','yaml','markdown','docker','objc','rust','ruby','go']);
  const available=id=>ids.has(id);
  for(const [hint,id] of [['JavaScript','js'],['js','js'],['nodejs','js'],['TS','typescript'],['tsx','typescript-jsx'],['javascriptreact','jsx'],['typescriptreact','typescript-jsx'],['language-python','python3'],['Py','python3'],['bash','sh'],['shell-session','sh'],['C++','cpp'],['C#','c-sharp'],['yml','yaml'],['md','markdown'],['Dockerfile','docker'],['objectivec','objc'],['rs','rust'],['rb','ruby'],['golang','go']]) assert.equal(selectCodeLanguage('',hint,available),id,hint);
});

test('filename/MIME hints, unknown hints and plain text retain distinct meanings',()=>{
  const available=id=>['python3','json'].includes(id);
  const guess=hint=>['report.py','text/x-python'].includes(hint)?'python3':undefined;
  assert.equal(selectCodeLanguage('','report.py',available,guess),'python3');
  assert.equal(selectCodeLanguage('','text/x-python',available,guess),'python3');
  assert.equal(selectCodeLanguage('{"answer":42}','unknown-language',available),'json');
  for(const hint of ['plain','plaintext','text','txt','none']) assert.equal(selectCodeLanguage('{"answer":42}',hint,available),undefined,hint);
  assert.equal(selectCodeLanguage('{"answer":42}',undefined,()=>false),undefined);
});

test('highlighting bound matches the gateway and leaves source strings intact',()=>{
  const source='x'.repeat(codeHighlightLimit);
  assert.equal(selectCodeLanguage(source,'js',id=>id==='js'),'js');
  assert.equal(selectCodeLanguage(source+'x','js',()=>{throw Error('oversized source entered grammar resolution')}),undefined);
  assert.equal(source.length,32768);
});
