import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import Source from 'gi://GtkSource?version=5';
import {exit} from 'system';
const base=ARGV[0]??Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_child('dist-gjs').get_child('gjs').get_uri()+'/';
const {codeView}=await import(base+'code-view.js');
const {detectCodeLanguage}=await import(base+'vendor/code-detector.js');
const check=(ok,why)=>{if(!ok)throw new Error(why)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
function all(w,p){let out=p(w)?[w]:[];for(let c=w.get_first_child();c;c=c.get_next_sibling())out.push(...all(c,p));return out}
function bufferText(buffer){return buffer.get_text(buffer.get_start_iter(),buffer.get_end_iter(),false)}
function readClipboard(widget){return new Promise((resolve,reject)=>widget.get_clipboard().read_text_async(null,(clipboard,result)=>{try{resolve(clipboard.read_text_finish(result))}catch(error){reject(error)}}))}
const app=new Adw.Application({flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:850,default_height:600});const style=Adw.StyleManager.get_default(),originalScheme=style.get_color_scheme();
 const connect=style.connect.bind(style),disconnect=style.disconnect.bind(style),active=new Set();
 style.connect=(name,callback)=>{const id=connect(name,callback);if(name==='notify::dark')active.add(id);return id};
 style.disconnect=id=>{active.delete(id);disconnect(id)};
 (async()=>{
  const source='const greeting = "Привет <tag>&"; // comment';
  const box=codeView(source,'javascript','Пример');win.set_content(box);win.present();await wait(100);
  const view=all(box,w=>w instanceof Source.View)[0];check(view,'code fell back instead of using GtkSourceView');const buffer=view.get_buffer();
  check(buffer.get_language()?.get_id()==='js'&&buffer.highlight_syntax&&!view.editable,'native grammar or read-only mode missing');
  check(bufferText(buffer)===source&&!buffer.implicit_trailing_newline,'buffer changed exact source');
  buffer.ensure_highlight(buffer.get_start_iter(),buffer.get_end_iter());
  for(const [text,kind] of [['Привет','string'],['comment','comment']]){const offset=Array.from(source.slice(0,source.indexOf(text))).length;const iter=buffer.get_iter_at_offset(offset);check(buffer.get_context_classes_at_iter(iter).includes(kind),kind+' not highlighted');check(iter.get_tags().some(tag=>tag.foreground_set),kind+' has no color tag')}
  all(box,w=>w instanceof Gtk.Button&&w.label==='Скопировать код')[0].emit('clicked');check(await readClipboard(box)===source,'copy changed exact code');
  style.set_color_scheme(Adw.ColorScheme.FORCE_DARK);await wait(50);check(buffer.get_style_scheme()?.get_id()==='Adwaita-dark','dark scheme missing');
  style.set_color_scheme(Adw.ColorScheme.FORCE_LIGHT);await wait(50);check(buffer.get_style_scheme()?.get_id()==='Adwaita','light scheme missing');
  check(active.size===1,'theme signal missing or duplicated');
  win.set_content(new Gtk.Label({label:'Hidden'}));await wait(40);check(active.size===0,'unmapped code retained theme signal');
  win.set_content(box);await wait(40);check(active.size===1,'remapped code failed to reconnect exactly once');
  const cases=[['const view = <Panel title="hello" />;','tsx','typescript-jsx'],['const view = <Panel />;','javascriptreact','jsx'],['#!/bin/bash\nprintf "%s" "$HOME"\n',undefined,'sh'],['{"answer":42}','not-a-language','json'],['{"answer":42}','text',null],['x'.repeat(32769),'js',null]];
  for(const [text,hint,expected] of cases){const block=codeView(text,hint);win.set_content(block);await wait(40);const v=all(block,w=>w instanceof Source.View)[0];check(v,'native view missing');const b=v.get_buffer();check((b.get_language()?.get_id()??null)===expected,'wrong language for '+hint);check(bufferText(b)===text,'source truncated');check(b.highlight_syntax===Boolean(expected),'highlight bound or plain mode ignored');check(active.size===1,'theme subscriptions accumulated')}
  const fixtureFile=Gio.File.new_for_uri(import.meta.url).get_parent().get_child('fixtures').get_child('code-language-detection.json');
  const [,bytes]=fixtureFile.load_contents(null);const fixture=JSON.parse(new TextDecoder().decode(bytes));
  for(const sample of fixture.cases)check((detectCodeLanguage(sample.source)??null)===sample.language,'GJS detector differs from gateway: '+sample.source);
  win.set_content(new Gtk.Label());await wait(30);check(active.size===0,'closed code retained theme signal');
  if(GLib.getenv('CODE_SCREENSHOT')){win.set_content(box);await wait(100);Gio.Subprocess.new(['import','-window','root',GLib.getenv('CODE_SCREENSHOT')],Gio.SubprocessFlags.NONE).wait_check(null)}
  print('OK: GtkSourceView JS grammar and colored string/comment tags, read-only exact source/copy, auto Bash and JSON, plain/large source, theme switching and unmap/remap cleanup; '+fixture.cases.length+' detector cases match gateway in GJS');
 })().catch(error=>{failed=true;logError(error)}).finally(()=>{win.close();style.set_color_scheme(originalScheme);style.connect=connect;style.disconnect=disconnect;app.quit()});
});await app.runAsync([]);exit(failed?1:0);
