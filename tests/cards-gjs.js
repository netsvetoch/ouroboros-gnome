import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {Cards}=await import(ARGV[0]+'cards.js');
const check=(value,message)=>{if(!value)throw new Error(message)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,message){for(let i=0;i<1000;i++){if(await fn())return;await wait(20)}throw new Error(message)}
function all(widget,predicate){let result=predicate(widget)?[widget]:[];for(let child=widget.get_first_child?.();child;child=child.get_next_sibling())result.push(...all(child,predicate));return result}
const words=root=>all(root,w=>w instanceof Gtk.Label||w instanceof Gtk.TextView).map(w=>w instanceof Gtk.Label?w.label:w.buffer.get_text(w.buffer.get_start_iter(),w.buffer.get_end_iter(),false)).join('\n');
const press=(root,caption)=>{const button=all(root,w=>w instanceof Gtk.Button&&w.label===caption)[0];check(button?.is_sensitive(),'button unavailable: '+caption);button.emit('clicked')};
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.CardTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1000,default_height:850});win.present();const gateway=new Gateway(ARGV[1],'fixture-secret'),cards=new Cards(win,gateway);let stage='full native submission history';
 const facts=()=>gateway.json('GET','/fixture/facts');
 (async()=>{
  let state=await facts();const id=state.card.card_id;cards.show(state.card,'');const live=cards.dialogs.get(id);await live.reload();await until(()=>live.card.submissions_summary?.length===200,'stored submission summary not loaded');
  const retries=root=>all(root,w=>w instanceof Gtk.Button&&w.label==='Повторить доставку');
  check(retries(live.content).length===200&&words(live.content).includes('Выбор 005'),'native card hid retained owed submissions');
  check(words(live.content).includes('Более ранних действий удалено шлюзом · 5'),'native card hid server-dropped count');
  stage='native pin';press(live.content,'Закрепить');await until(()=>!live.pinning,'pin stalled');state=await facts();check(state.pins.length===1&&state.pins[0].revision===1,'pin snapshot not persisted');
  cards.showPinned();await until(()=>all(cards.pinnedList.get_child(),w=>w instanceof Gtk.Button&&w.label==='Карточка <&>').length===1,'native pinned list did not load');press(cards.pinnedList.get_child(),'Карточка <&>');const frozen=cards.dialogs.get('pinned:'+id);await until(()=>frozen.card.submissions_summary?.length===200,'pinned summary not loaded');
  check(retries(frozen.content).length===200&&words(frozen.content).includes('Более ранних действий удалено шлюзом · 5'),'pinned copy lost submission access/count');
  stage='old owed delivery retry';retries(frozen.content)[0].emit('clicked');await until(()=>!frozen.busy.size,'old owed retry stalled');state=await facts();check(state.submissions.length===200&&state.submissions.find(row=>row.request_id==='request-005').delivered==='delivered','retry changed identity or failed delivery');
  check(state.mailbox.length===1&&state.mailbox[0].kind==='card_input'&&state.mailbox[0].msg_id==='card_input:'+id+':request-005'&&state.mailbox[0].text.includes('"index": 5'),'old retry lost stored values or duplicated mail');
  stage='snapshot revision fidelity';await gateway.json('POST','/fixture/replace',{});await live.reload();await frozen.reload();check(live.card.revision===2&&frozen.card.revision===1&&words(live.body).includes('Версия 2')&&words(frozen.body).includes('Версия 1'),'live replacement mutated frozen snapshot');
  press(frozen.body,'Действие');await until(()=>!frozen.busy.size,'stale pinned action stalled');check(frozen.status.label.includes('Закреплённая копия устарела'),'stale action not explained');state=await facts();check(state.submissions.length===200&&state.mailbox.length===1,'stale snapshot action reached author');
  stage='native unpin';press(frozen.content,'Открепить');await until(()=>!frozen.pinning,'unpin stalled');state=await facts();check(state.pins.length===0,'unpin did not persist');
  stage='inert app bytes';const bytes=await gateway.previewBytes(state.app.app.url,1024,new Gio.Cancellable());check(new TextDecoder().decode(bytes)==='<!doctype html><title>Fixture</title><p>Inert source</p>','app source bytes changed');
  let refused=false;try{await gateway.json('POST','/api/cards/'+state.app.card_id+'/pin')}catch(error){refused=error.status===409&&error.reason==='card_not_pinnable'}check(refused,'app pin was not refused');
  check(!all(live.content,w=>String(w.constructor.name).includes('WebView')).length,'browser mounted in native component card');
  print('OK: real card API/store and native component/pinned snapshots; all 200 retained submissions and dropped count, old owed delivery with exact stored ID/values, revision replacement/stale action refusal, pin/unpin, inert app bytes and app-pin refusal; no model execution');
 })().catch(error=>{failed=true;logError(error);print('Stage: '+stage)}).finally(()=>{cards.close();gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
