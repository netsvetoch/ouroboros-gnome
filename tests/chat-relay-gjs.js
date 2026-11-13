import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {ChatPage}=await import(ARGV[0]+'chat.js');
const {relayContext:relayView}=await import(ARGV[0]+'chat-relay.js');
const relayContext=(...args)=>relayView(...args)?.widget;
const {NativeI18n,useNativeI18n}=await import(ARGV[0]+'native-i18n.js');
const check=(value,message)=>{if(!value)throw new Error(message)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,message){for(let i=0;i<700;i++){if(await fn())return;await wait(20)}throw new Error(message)}
function all(widget,predicate){let result=predicate(widget)?[widget]:[];for(let child=widget.get_first_child?.();child;child=child.get_next_sibling())result.push(...all(child,predicate));return result}
const text=root=>all(root,w=>w instanceof Gtk.Label).map(w=>w.label).join('\n');
const expand=root=>{root.expanded=true;for(const item of all(root,w=>w instanceof Gtk.Expander))item.expanded=true};
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.RelayTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1000,default_height:900});win.present();const gateway=new Gateway(ARGV[1],'fixture-secret');let chat,catalog,stage='source messages';
 const facts=()=>gateway.json('GET','/fixture/facts'),emit=body=>gateway.json('POST','/fixture/emit',body);
 const context=()=>all(chat.widget,w=>w instanceof Gtk.Expander&&['Forwarded context','QAA context'].includes(w.label))[0];
 (async()=>{
  await gateway.json('POST','/api/ui/i18n/language',{language:'en'});catalog=new NativeI18n(gateway);useNativeI18n(catalog);await until(()=>catalog.language==='en','English not ready');
  chat=new ChatPage(win,gateway,{chatId:1,name:'Main'},()=>{});win.set_content(chat.widget);await until(async()=>(await facts()).peers>0,'socket not ready');
  const first='  private-relay-owner <&> Ω\n'+ 'x'.repeat(2048)+'  ',second='Second separate owner message',file='private-attachment <&> 🐍.txt';
  await emit({kind:'incoming',source:'web',chat_id:1,client_message_id:'relay-first',text:first});
  await emit({kind:'incoming',source:'web',chat_id:1,client_message_id:'relay-second',text:second});
  await emit({kind:'file-source',client_message_id:'relay-file',filename:file});
  stage='actual relay publication';const result=await emit({kind:'relay',sources:['relay-first','relay-second','relay-file'],note:'Forwarding note <&>',relay_id:'private-relay-id'});
  const retainedFirst=result.relay.quotes[0].text;
  await until(()=>context()&&chat.current.some(row=>row.relay?.relay_id==='private-relay-id'),'real relay context not shown');
  let view=context();expand(view);const panels=all(view,w=>w instanceof Gtk.Expander&&w!==view);
  check(panels.length===3&&all(view,w=>w instanceof Gtk.Label&&w.label===retainedFirst).length&&text(view).includes(second)&&text(view).includes(file),'owner quotes merged, trimmed or omitted attachment-only source: '+JSON.stringify({panels:panels.length,retained:retainedFirst.length,labels:all(view,w=>w instanceof Gtk.Label).map(w=>w.label.slice(0,80))}));
  check(!text(panels[2]).includes('Host attachment placeholder'),'file-only quote invented owner speech');
  check(all(view,w=>w instanceof Gtk.Label&&w.label.includes('<&>')).every(w=>!w.use_markup&&w.measure(Gtk.Orientation.HORIZONTAL,-1)[0]<=640),'quoted words/files broke literal geometry');
  check(all(view,w=>w instanceof Gtk.Button&&w.label==='Open original message').length===3&&text(view).includes('Receiving work · Receiver work · relay-receiver'),'source links or receiver facts missing');
  stage='repaint preserves independent expansion';panels[1].expanded=false;await chat.readHistory();view=context();
  check(view.expanded,'root expansion lost');let repainted=all(view,w=>w instanceof Gtk.Expander&&w!==view);check(repainted[0].expanded&&!repainted[1].expanded&&repainted[2].expanded,'individual expansion lost');
  stage='partial malformed and legacy context';
  for(const bad of [[],true,{quotes:{}},{quotes:[null]},{quotes:[{text:{}}]},{quotes:[{text:'x',source:[]}]},{quotes:[{text:'x',attachments:{}}]}]){
   const rendered=relayContext(bad,()=>{throw new Error('unexpected navigation')},new Set(),'bad');expand(rendered);check(text(rendered).includes('Some forwarded context is unavailable.'),'malformed context became confirmed empty');
  }
  const partial=relayContext({quotes:[result.relay.quotes[0],null,result.relay.quotes[2]]},()=>{},new Set(),'partial');expand(partial);
  check(text(partial).includes(retainedFirst)&&text(partial).includes(file)&&text(partial).includes('Only readable details'),'partial failure hid healthy quotes');
  const legacy=relayContext({...result.relay,quotes:[],future:{value:true}},()=>{},new Set(),'legacy');expand(legacy);check(text(legacy).includes(retainedFirst)&&!text(legacy).includes(second),'legacy singular fallback missing or merged quotes');
  const literal=relayContext({text:first},()=>{},new Set(),'literal');expand(literal);check(all(literal,w=>w instanceof Gtk.Label&&w.label===first).length,'renderer stripped literal whitespace');
  const many=relayContext({quotes:Array.from({length:19},(_,index)=>({text:'Retained quote '+index,source:{address:'opaque-'+index}}))},()=>{},new Set(),'many');expand(many);check(all(many,w=>w instanceof Gtk.Expander&&w!==many).length===19,'renderer imposed a quote cap');
  check(!text(chat.messageRow({role:'user',text:'Owner own text',relay:result.relay})).includes('Forwarded context'),'relay metadata turned a user row into a forwarded assistant note');
  stage='live locale preserves quote data and expansions';chat.composer.text='Unsent relay draft';
  const imported=await gateway.json('POST','/api/ui/i18n/import',{language:'qaa',entries:{'Forwarded context':{text:'QAA context'},'Owner message · {place}':{text:'QAA owner · {place}'}}});
  await gateway.json('POST','/api/ui/i18n/language',{language:'qaa',profile:{direction:'rtl'}});catalog.frame({type:'ui_language_changed',language:'qaa'});catalog.frame({type:'ui_i18n_updated',language:'qaa',revision:imported.revision});
  await until(()=>context()?.label==='QAA context','live context caption absent');view=context();repainted=all(view,w=>w instanceof Gtk.Expander&&w!==view);
  check(text(view).includes(retainedFirst)&&view.expanded&&repainted[0].expanded&&!repainted[1].expanded&&view.get_direction()===Gtk.TextDirection.RTL&&chat.composer.text==='Unsent relay draft','locale lost quote state/draft/direction');
  check(!JSON.stringify([...catalog.reported,...catalog.missing.keys()]).includes('private-relay'),'private quote/ID became translation source');
  stage='source navigation uses exact retained address';const address=result.relay.quotes[0].source.address;
  const jump=all(repainted[0],w=>w instanceof Gtk.Button&&w.label==='Open original message')[0];check(jump,'source jump missing');jump.emit('clicked');
  await until(()=>chat.anchored&&chat.current.some(row=>row.row_address===address),'exact source anchor not opened');
  check(chat.composer.text==='Unsent relay draft'&&!chat.draft.reply,'source navigation changed draft/reply selection');
  const state=await facts();check(!state.pending.length&&!state.audit.some(row=>row.method==='POST'&&['/api/chat/send','/api/decisions','/api/command'].includes(row.path)),'relay viewer sent work or an owner message');
  print('OK: native relay context from actual owner_quote/write_relay/publish_relay and stored owner rows, real history/WS, three separate quotes including attachment-only source, verbatim long text/files, receiver facts and exact source anchor; malformed partial/legacy/future and all 19 quotes, independent expansion across reread/live locale/RTL, private translation isolation and draft preservation; no worker/model or file transfer');
 })().catch(error=>{failed=true;logError(error);print('Stage: '+stage)}).finally(async()=>{await chat?.close();catalog?.close();useNativeI18n();gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
