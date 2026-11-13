import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {ChatPage}=await import(ARGV[0]+'chat.js');
const {replyQuote}=await import(ARGV[0]+'chat-reply-quote.js');
const {NativeI18n,useNativeI18n}=await import(ARGV[0]+'native-i18n.js');
const check=(value,message)=>{if(!value)throw new Error(message)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,message){for(let i=0;i<700;i++){if(await fn())return;await wait(20)}throw new Error(message)}
function all(widget,predicate){let result=predicate(widget)?[widget]:[];for(let child=widget.get_first_child?.();child;child=child.get_next_sibling())result.push(...all(child,predicate));return result}
const text=root=>all(root,w=>w instanceof Gtk.Label).map(w=>w.label).join('\n');
const buttons=root=>all(root,w=>w instanceof Gtk.Button);
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.ReplyQuoteTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1000,default_height:900});win.present();const gateway=new Gateway(ARGV[1],'fixture-secret');let chat,catalog,stage='source acceptance';
 const facts=()=>gateway.json('GET','/fixture/facts'),emit=body=>gateway.json('POST','/fixture/emit',body);
 (async()=>{
  await gateway.json('POST','/api/ui/i18n/language',{language:'en'});catalog=new NativeI18n(gateway);useNativeI18n(catalog);await until(()=>catalog.language==='en','English not ready');
  chat=new ChatPage(win,gateway,{chatId:1,name:'Main'},()=>{});win.set_content(chat.widget);await until(async()=>(await facts()).peers>0,'socket missing');
  const author='private-quote-author <&> Ω '+ 'a'.repeat(1024),words='Full quoted source 🐍 <&>\n'+ 'x'.repeat(300);
  await emit({kind:'incoming',chat_id:701,source:'telegram',sender_label:author,client_message_id:'quoted-original',text:words});
  stage='real saved reply reference';const {reference}=await emit({kind:'reply',source_id:'quoted-original',text:'Answer with saved quote'});
  await until(()=>chat.current.some(row=>row.text==='Answer with saved quote')&&buttons(chat.widget).some(button=>button.label===reference.snippet),'real quote snapshot absent');
  check(reference.chars===Array.from(words).length&&text(chat.widget).includes(`Original text · ${reference.chars} characters`)&&text(chat.widget).includes('Reply to · '+author)&&text(chat.widget).includes(reference.ts),'author/time/full code-point length not visible');
  const frame=all(chat.widget,w=>w instanceof Gtk.Frame&&buttons(w).some(button=>button.label===reference.snippet))[0];
  check(frame&&all(frame,w=>w instanceof Gtk.Label&&w.label.includes('<&>')).every(w=>!w.use_markup&&w.measure(Gtk.Orientation.HORIZONTAL,-1)[0]<=640),'literal quote/author broke geometry or markup');
  stage='unresolved snapshot is retryable';const missing=await emit({kind:'reply',address:'missing-quoted-source',text:'Answer to unresolved source'});
  check(missing.reference.unresolved===true,'fixture did not resolve to unavailable');
  await until(()=>text(chat.widget).includes('The original message was unavailable when this reply was saved.'),'unresolved reference not disclosed');
  const retry=buttons(chat.widget).find(button=>button.label==='Open original message');check(retry,'unresolved retry missing');chat.composer.text='Unsent quote draft';retry.emit('clicked');
  await until(()=>!chat.jump&&chat.historyNotice.label.length>0,'failed source retry did not report lookup failure');
  check(chat.current.some(row=>row.text==='Answer with saved quote')&&chat.composer.text==='Unsent quote draft','failed jump erased history/draft');
  stage='malformed metadata does not create navigation';
  for(const bad of [[],true,{address:{}},{snippet:[]},{address:'x',author_label:{}},{address:'x',ts:42},{address:'x',unresolved:'true'},{address:'x',chars:-1},{address:'x',chars:1.5}]){
   const view=replyQuote(bad,()=>{throw new Error('bad quote navigated')});check(view&&text(view).includes('Quoted message details are unavailable.')&&!buttons(view).length,'malformed quote yielded action or invented facts');
  }
  check(!replyQuote({},()=>{})&&!replyQuote(null,()=>{}),'empty reference became a phantom quote');
  const plain=replyQuote({snippet:'Legacy readonly <&>',future:{key:true}},()=>{});check(text(plain).includes('Legacy readonly <&>')&&!buttons(plain).length,'snippet-only legacy reference broken');
  for(const [role,caption] of [['user','Reply to You'],['assistant','Reply to Ouroboros'],['system','Reply to System'],['future','Quoted message'],['__proto__','Quoted message'],['constructor','Quoted message'],['toString','Quoted message']])check(text(replyQuote({address:'opaque',role},()=>{})).includes(caption),'role fallback missing: '+role);
  stage='bad relay does not hide known reply';const damaged=chat.messageRow({role:'assistant',text:'Body still readable',relay:[],reply_to:reference});
  check(buttons(damaged).some(button=>button.label===reference.snippet),'malformed relay suppressed a valid reply quote');
  stage='live media keeps reference';check(chat.liveMedia.frame({type:'document',role:'assistant',chat_id:1,ts:'2026-11-13T06:30:00Z',filename:'quoted.txt',mime:'text/plain',size_bytes:1,file_base64:'WA==',reply_to:reference}),'media rejected');
  const media=chat.liveMedia.frames.at(-1).row;check(media.reply_to===reference&&buttons(chat.messageRow(media)).some(button=>button.label===reference.snippet),'live media dropped its reply reference');
  stage='live locale keeps quote and draft';const imported=await gateway.json('POST','/api/ui/i18n/import',{language:'qaa',entries:{'Reply to · {author}':{text:'QAA quote · {author}'},'Original text · {count} characters':{text:'QAA total · {count}'}}});
  await gateway.json('POST','/api/ui/i18n/language',{language:'qaa',profile:{direction:'rtl'}});catalog.frame({type:'ui_language_changed',language:'qaa'});catalog.frame({type:'ui_i18n_updated',language:'qaa',revision:imported.revision});
  await until(()=>text(chat.widget).includes('QAA quote · '+author)&&text(chat.widget).includes('QAA total · '+reference.chars),'quote captions not live');
  const currentFrame=all(chat.widget,w=>w instanceof Gtk.Frame&&buttons(w).some(button=>button.label===reference.snippet))[0];
  check(currentFrame.get_direction()===Gtk.TextDirection.RTL&&chat.composer.text==='Unsent quote draft'&&!JSON.stringify([...catalog.reported,...catalog.missing.keys()]).includes('private-quote-author'),'RTL/draft/private key isolation failed');
  stage='current exact source lookup';const source=buttons(chat.widget).find(button=>button.label===reference.snippet);source.emit('clicked');
  await until(()=>chat.anchored&&chat.current.some(row=>row.row_address===reference.address),'exact source anchor missing');
  check(chat.composer.text==='Unsent quote draft'&&!chat.draft.reply,'jump staged a reply or changed draft');
  stage='work-card address uses task anchor';const work=await emit({kind:'reply',seed_task:'quoted-work',address:'task:quoted-work',text:'Answer to work card'});chat.showLatest();
  await until(()=>buttons(chat.widget).some(button=>button.label===work.reference.snippet),'work-card quote missing');
  const workJump=buttons(chat.widget).find(button=>button.label===work.reference.snippet);workJump.emit('clicked');
  await until(()=>chat.anchored&&chat.current.some(row=>row.task_id==='quoted-work'),'work-card task anchor failed');
  stage='closed view suppresses stale source click';await chat.close();const before=(await facts()).audit.filter(row=>row.path==='/api/chat/history').length;source.emit('clicked');await wait(80);
  const state=await facts();check(state.audit.filter(row=>row.path==='/api/chat/history').length===before&&!state.pending.length&&!state.audit.some(row=>row.method==='POST'&&row.path==='/api/chat/send'),'closed source click read history or quote viewer submitted work');
  print('OK: native reply quotes from real reference_from_row/resolve_reply, canonical publication/history/WS: literal author/time, truncated snippet and full Unicode length, unresolved retry without history/draft loss, exact row and work-card task anchors; nine malformed cases no navigation, minimal/future/readonly compatibility, bad-relay fallback, live-media reference retention, i18n/RTL/private key isolation and closed-view guard; no worker/model');
 })().catch(error=>{failed=true;logError(error);print('Stage: '+stage)}).finally(async()=>{await chat?.close();catalog?.close();useNativeI18n();gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
