import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {ChatPage}=await import(ARGV[0]+'chat.js');
const {contactSource}=await import(ARGV[0]+'contact-source.js');
const {NativeI18n,useNativeI18n}=await import(ARGV[0]+'native-i18n.js');
const check=(value,message)=>{if(!value)throw new Error(message)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,message){for(let i=0;i<700;i++){if(await fn())return;await wait(20)}throw new Error(message)}
function all(widget,predicate){let result=predicate(widget)?[widget]:[];for(let child=widget.get_first_child?.();child;child=child.get_next_sibling())result.push(...all(child,predicate));return result}
const texts=root=>all(root,w=>w instanceof Gtk.Label).map(w=>w.label).join('\n');
const links=root=>all(root,w=>w instanceof Gtk.LinkButton);
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.ContactTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1000,default_height:900});win.present();const gateway=new Gateway(ARGV[1],'fixture-secret');let chat,catalog,stage='language';
 const facts=()=>gateway.json('GET','/fixture/facts');
 (async()=>{
  await gateway.json('POST','/api/ui/i18n/language',{language:'en'});catalog=new NativeI18n(gateway);useNativeI18n(catalog);await until(()=>catalog.language==='en','English not loaded');
  chat=new ChatPage(win,gateway,{chatId:1,name:'Main'},()=>{});win.set_content(chat.widget);await until(()=>chat.current.length>0,'initial history missing');
  stage='production bridge to native message/question';const name='Connector · Connector · private-source <&> Ω '+ 'x'.repeat(1024),url='https://example.invalid/source?q=%3C%26%3E';
  const {origin}=await gateway.json('POST','/fixture/contact',{label:name,url});const shown=name.replace('Connector · Connector · ','Connector · ');
  await until(()=>chat.current.filter(row=>row.presence_contact||row.quiz?.presence_contact).length===2,'contact rows not received');
  const sources=()=>all(chat.widget,w=>w instanceof Gtk.Label&&w.label==='Source · '+shown);
  await until(()=>sources().length===2,'native history lost message or nested quiz contact');
  for(const source of sources())check(!source.use_markup&&source.tooltip_text==='Source work: main-asker'&&source.measure(Gtk.Orientation.HORIZONTAL,-1)[0]<=640,'source label identity/markup/width wrong');
  check(links(chat.widget).filter(link=>link.uri===url).length===2,'source links not available');
  const row=sources().map(source=>source.get_parent().get_parent()).find(root=>all(root,w=>w instanceof Gtk.Button&&w.label==='Открыть вопрос').length);
  check(row,'question row missing');all(row,w=>w instanceof Gtk.Button&&w.label==='Открыть вопрос')[0].emit('clicked');
  await until(()=>chat.questions.entries.get('quiz:main-asker:contact')?.dialog,'question dialog not opened');
  const entry=chat.questions.entries.get('quiz:main-asker:contact'),form=entry.dialog;
  check(texts(form.content).includes('Source · '+shown)&&links(form.content).some(link=>link.uri===url),'question dialog lost provenance');
  check(form.comment.get_text?.()===''||form.comment.buffer?.text==='','source attribution entered owner answer');
  stage='canonical history replay';await chat.readHistory();check(sources().length===2,'canonical history replay dropped provenance');
  stage='strict display guards and safe external links';
  for(const bad of [null,[],{}, {...origin,task_id:2},{...origin,binding_id:''},{...origin,source_event_id:[]},{...origin,label:{}},{...origin,url:42}])check(!contactSource(bad),'malformed attribution rendered');
  for(const bad of ['javascript:alert(1)','file:///etc/passwd','mailto:x@example.invalid','/api/files/download?path=a','https://user:secret@example.invalid/x','not a URL']){
   const widget=contactSource({...origin,url:bad});check(widget&&texts(widget).includes(shown)&&!links(widget).length,'unsafe URL became link or hid valid source label: '+bad);
  }
  check(texts(contactSource({...origin,label:''})).includes('Source · Connected place'),'empty label fallback missing');
  const plain=chat.messageRow({role:'assistant',text:'ordinary',task_id:'main-asker'});check(!texts(plain).includes('Source · '),'ordinary message acquired attribution');
  stage='metadata update preserves answer draft';const draft='Owner private draft <&>';if(form.comment.buffer)form.comment.buffer.set_text(draft,-1);else form.comment.text=draft;
  chat.questions.observe('main-asker',{quiz_id:'contact',presence_contact:{...origin,label:'Updated place',url:'https://example.invalid/new'}});
  check(texts(form.content).includes('Source · Updated place')&&(form.comment.buffer?.text??form.comment.text)===draft,'source refresh lost draft or stayed stale');
  stage='live language and private translation parameters';const imported=await gateway.json('POST','/api/ui/i18n/import',{language:'qaa',entries:{'Source · {label}':{text:'QAA source · {label}'},'Open source':{text:'QAA open source'}}});
  await gateway.json('POST','/api/ui/i18n/language',{language:'qaa',profile:{direction:'rtl'}});catalog.frame({type:'ui_language_changed',language:'qaa'});catalog.frame({type:'ui_i18n_updated',language:'qaa',revision:imported.revision});
  await until(()=>texts(form.content).includes('QAA source · Updated place'),'live source translation missing');check(texts(chat.widget).includes('QAA source · '+shown)&&links(form.content).some(link=>link.label==='QAA open source'),'live chat/link caption missing');
  check(all(form.source,w=>w instanceof Gtk.Label&&w.label.includes('Updated place'))[0].get_direction()===Gtk.TextDirection.RTL&&(form.comment.buffer?.text??form.comment.text)===draft,'RTL/draft missing');
  await until(async()=>(await facts()).i18n_audit.length>0,'missing reports absent');const state=await facts();
  check(!JSON.stringify(state.i18n_audit).includes('private-source')&&!JSON.stringify(state.i18n_audit).includes('Owner private draft'),'private text became translation source');
  check(!state.audit.length,'source display sent an owner decision');
  print('OK: real bridge/history/WS private message and nested quiz provenance rendered in native ChatPage and question dialog; source task tooltip, duplicate connector label, full literal long label and safe HTTP links; malformed metadata guards, unsafe URL suppression, ordinary row isolation, draft-preserving metadata/live language/RTL updates and private translation parameter isolation; simulated host-held source metadata, no connector admission, external launch or owner decision');
 })().catch(error=>{failed=true;logError(error);print('Stage: '+stage)}).finally(async()=>{await chat?.close();catalog?.close();useNativeI18n();gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
