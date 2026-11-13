import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {ChatPage}=await import(ARGV[0]+'chat.js');
const {NativeI18n,useNativeI18n}=await import(ARGV[0]+'native-i18n.js');
const check=(value,message)=>{if(!value)throw new Error(message)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,message){for(let i=0;i<700;i++){if(await fn())return;await wait(20)}throw new Error(message)}
function all(widget,predicate){let result=predicate(widget)?[widget]:[];for(let child=widget.get_first_child?.();child;child=child.get_next_sibling())result.push(...all(child,predicate));return result}
const text=root=>all(root,w=>w instanceof Gtk.Label).map(w=>w.label).join('\n');
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.SenderTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1000,default_height:900});win.present();const gateway=new Gateway(ARGV[1],'fixture-secret');let chat,catalog,stage='initial connection';
 const facts=()=>gateway.json('GET','/fixture/facts'),emit=body=>gateway.json('POST','/fixture/emit',body);
 (async()=>{
  await gateway.json('POST','/api/ui/i18n/language',{language:'en'});catalog=new NativeI18n(gateway);useNativeI18n(catalog);await until(()=>catalog.language==='en','English not ready');
  chat=new ChatPage(win,gateway,{chatId:1,name:'Main'},()=>{});win.set_content(chat.widget);await until(async()=>(await facts()).peers>0,'chat socket not ready');
  stage='accepted external sender';const name='private-author <&> Ω '+ 'x'.repeat(1024);
  await emit({kind:'incoming',chat_id:701,text:'Named external sender',source:'telegram',sender_label:name,client_message_id:'sender-named'});
  await until(()=>text(chat.widget).includes(name+' · '),'real accepted sender not shown');
  await until(()=>chat.current.some(row=>row.client_message_id==='sender-named'),'canonical sender row missing');
  const named=all(chat.widget,w=>w instanceof Gtk.Label&&w.label.startsWith(name+' · '))[0];check(!named.use_markup&&named.measure(Gtk.Orientation.HORIZONTAL,-1)[0]<=640,'sender name parsed markup or broke geometry');
  const saved=chat.current.find(row=>row.client_message_id==='sender-named');check(saved?.role==='user'&&saved.sender_label===name&&saved.source==='telegram','canonical sender fields missing');
  stage='fallbacks and same-owner other client';await emit({kind:'incoming',chat_id:701,text:'Unnamed telegram sender',source:'telegram',client_message_id:'sender-unnamed'});
  await until(()=>text(chat.widget).includes('Telegram · '),'Telegram fallback absent');
  await emit({kind:'incoming',chat_id:1,user_id:1,text:'Owner another window',source:'web',client_message_id:'sender-owner'});
  await until(()=>text(chat.widget).includes('You · '),'web owner became another actor');
  stage='self initiated sender survives durable history';await emit({chat_id:1,text:'Consciousness source message',initiator:'consciousness',ts:'2026-11-13T06:00:00Z'});
  await until(()=>chat.current.some(row=>row.text==='Consciousness source message')&&text(chat.widget).includes('Ouroboros · Consciousness · '),'Consciousness signature absent');
  await chat.readHistory();check(text(chat.widget).includes(name+' · ')&&text(chat.widget).includes('Ouroboros · Consciousness · '),'history reread lost sender metadata');
  stage='system and progress sender captions';
  for(const [row,caption] of [[{role:'system',system_type:'skill_review'},'Skill Review'],[{role:'system',system_type:'task_summary'},'Task Summary'],[{role:'assistant',is_progress:true},'Thought']])
   check(text(chat.messageRow({...row,text:'Caption check',ts:'stamp'})).includes(caption+' · stamp'),'special sender caption missing: '+caption);
  stage='live media retains author and contact metadata';const contact={task_id:'media-work',binding_id:'binding',source_event_id:'source-event',label:'Media source place'};
  check(chat.liveMedia.frame({type:'document',role:'user',chat_id:1,ts:'2026-11-13T06:00:01Z',source:'telegram',sender_label:'Media author <&>',initiator:'consciousness',presence_contact:contact,filename:'sender.txt',mime:'text/plain',size_bytes:1,file_base64:'WA=='}),'live media frame rejected');
  const media=chat.liveMedia.frames.at(-1).row;check(media.sender_label==='Media author <&>'&&media.source==='telegram'&&media.initiator==='consciousness'&&media.presence_contact===contact,'media projection dropped metadata');
  const rendered=chat.messageRow(media);check(text(rendered).includes('Media author <&> · ')&&text(rendered).includes('Source · Media source place'),'live media source/sender not displayed');
  stage='live captions preserve private authors and drafts';chat.composer.text='Unsent owner draft';
  const imported=await gateway.json('POST','/api/ui/i18n/import',{language:'qaa',entries:{'You{details}':{text:'QAA owner{details}'},'Ouroboros · Consciousness{details}':{text:'QAA consciousness{details}'}}});
  await gateway.json('POST','/api/ui/i18n/language',{language:'qaa',profile:{direction:'rtl'}});catalog.frame({type:'ui_language_changed',language:'qaa'});catalog.frame({type:'ui_i18n_updated',language:'qaa',revision:imported.revision});
  await until(()=>text(chat.widget).includes('QAA owner · ')&&text(chat.widget).includes('QAA consciousness · '),'sender chrome did not change language');
  const currentNamed=all(chat.widget,w=>w instanceof Gtk.Label&&w.label.startsWith(name+' · '))[0];
  check(text(chat.widget).includes(name+' · ')&&chat.composer.text==='Unsent owner draft'&&currentNamed.get_direction()===Gtk.TextDirection.RTL,'locale altered raw author or draft/direction');
  check(!JSON.stringify([...catalog.reported,...catalog.missing.keys()]).includes('private-author'),'private author became translation source');
  const state=await facts();check(!state.pending.length&&!state.audit.some(row=>row.method==='POST'&&row.path==='/api/chat/send'),'sender display dispatched work or sent chat');
  print('OK: real accepted/dequeued inbound sender metadata over bridge/WS and canonical history in native ChatPage; Telegram/web owner fallbacks, Consciousness and system/progress captions, literal long author geometry, live media author/contact retention, language/RTL and draft preservation; inert inbox consumers, no worker/model execution or viewer chat POST');
 })().catch(error=>{failed=true;logError(error);print('Stage: '+stage);print(JSON.stringify(chat?.current.map(row=>({role:row.role,source:row.source,sender:row.sender_label?.slice(0,40),text:row.text,ts:row.ts}))));print(JSON.stringify(all(chat?.widget,w=>w instanceof Gtk.Label).map(w=>w.label.slice(0,100))))}).finally(async()=>{await chat?.close();catalog?.close();useNativeI18n();gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
