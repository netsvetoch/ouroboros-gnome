import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {WorkActions}=await import(ARGV[0]+'work-actions.js');
const {TasksPage}=await import(ARGV[0]+'tasks.js');
const {WorkState}=await import(ARGV[0]+'work-state.js');
const check=(value,message)=>{if(!value)throw new Error(message)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,message){for(let i=0;i<1000;i++){if(fn())return;await wait(20)}throw new Error(message)}
function all(widget,predicate){let result=predicate(widget)?[widget]:[];for(let child=widget.get_first_child?.();child;child=child.get_next_sibling())result.push(...all(child,predicate));return result}
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.ControlTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1000,default_height:850});win.present();
 const gateway=new Gateway(ARGV[1],'fixture-secret'),actions=new WorkActions(gateway),work=new WorkState(gateway);let tasks,stage='queue admission';
 const present=Adw.AlertDialog.prototype.present;let confirmResponse;
 Adw.AlertDialog.prototype.present=function(parent){present.call(this,parent);if(confirmResponse){const response=confirmResponse;confirmResponse=undefined;check(this.heading==='Остановить задачу?'&&parent===tasks.openDetails.get('ctl-native').dialog,'unexpected confirmation target');GLib.idle_add(0,()=>{this.emit('response',response);this.close();return GLib.SOURCE_REMOVE})}};
 const facts=()=>gateway.json('GET','/fixture/facts');
 const run=(id,action)=>actions.run(win,{target:id,action},'attempt-1',()=>true);
 (async()=>{
  for(const task_id of ['ctl-hurry-lost','ctl-pause-lost','ctl-native','ctl-stop','ctl-graceful']){
   const reply=await gateway.json('POST','/api/tasks',{task_id,description:'GNOME control '+task_id,chat_id:1,source:'web'});
   check(reply.ok===true,'fixture admission refused: '+JSON.stringify(reply));
  }
  stage='hurry acknowledgement loss';let reply=await run('ctl-hurry-lost','hurry');check(reply.failed&&reply.text.includes('неизвестен'),'lost hurry response became a definite result');
  let state=await facts();check(state.calls[0].status===200&&state.records['ctl-hurry-lost'].owner_hurry,'real hurry control was not persisted');
  reply=await run('ctl-hurry-lost','hurry');check(!reply.failed&&reply.text.includes('уже'),'retry did not recover hurry acknowledgement: '+reply.text);
  state=await facts();let calls=state.calls.filter(row=>row.task_id==='ctl-hurry-lost');check(calls.length===2&&calls[0].body.request_id===calls[1].body.request_id&&calls[1].reply.duplicate,'hurry retry changed identity');
  check(state.drained_mail['ctl-hurry-lost'].filter(row=>row.kind==='hurry').length===1,'hurry retry duplicated mailbox effect');
  stage='pause acknowledgement loss';reply=await run('ctl-pause-lost','pause');check(reply.failed,'lost pause response became definite success');
  reply=await run('ctl-pause-lost','pause');check(!reply.failed,'pause receipt retry failed: '+reply.text);state=await facts();calls=state.calls.filter(row=>row.task_id==='ctl-pause-lost');
  check(calls.length===2&&calls[0].body.request_id===calls[1].body.request_id&&calls[1].reply.duplicate,'pause retry changed stable request identity');
  const fence=state.fences['ctl-pause-lost'];
  check(['requested','paused'].includes(fence.state)&&typeof fence.fence_id==='string'&&fence.fence_id===calls[1].reply.fence_id,'real pause fence missing or belongs to another receipt');
  stage='resume parked work';reply=await run('ctl-pause-lost','resume');check(!reply.failed,'resume failed: '+reply.text);state=await facts();check(state.fences['ctl-pause-lost'].state==='released','resume did not release durable pause');
  stage='native current controls';work.setConnected(true);await work.refresh();
  tasks=new TasksPage(win,gateway,()=>({name:'Main',chatId:1}),()=>{},undefined,work);tasks.show('ctl-native');
  const detail=tasks.openDetails.get('ctl-native');await until(()=>detail.task&&!detail.readStatus.label,'native detail failed to load');
  const captions=()=>all(detail.controls,w=>w instanceof Gtk.Button).map(w=>w.label);
  check(captions().includes('Пауза')&&captions().includes('Остановить')&&!captions().includes('Ускорить')&&!captions().includes('Возобновить'),'native controls differ from queued-work authority: '+JSON.stringify(captions()));
  const press=caption=>{const button=all(detail.controls,w=>w instanceof Gtk.Button&&w.label===caption)[0];check(button?.sensitive,'native control disabled: '+caption);button.emit('clicked')};
  press('Пауза');await until(()=>!detail.actionPending,'native pause stalled');check(!detail.status.label.includes('неизвестен'),'native pause failed: '+detail.status.label);await work.refresh();await detail.refresh();
  check(captions().includes('Возобновить'),'native pause did not offer resume');press('Возобновить');await until(()=>!detail.actionPending,'native resume stalled');
  await work.refresh();await detail.refresh();stage='native stop confirmation';
  confirmResponse='cancel';press('Остановить');await until(()=>!detail.actionPending,'declined native stop stalled');state=await facts();
  check(!state.audit.some(row=>row.path==='/api/tasks/ctl-native/cancel'),'declined stop reached gateway');
  confirmResponse='ok';press('Остановить');await until(()=>!detail.actionPending,'native stop stalled');state=await facts();
  check(state.audit.filter(row=>row.path==='/api/tasks/ctl-native/cancel').length===1&&!state.pending.some(row=>row.id==='ctl-native')&&state.records['ctl-native'].status==='cancelled','native stop did not settle queued task exactly once');
  await work.refresh();await detail.refresh();
  check(!captions().some(caption=>['Пауза','Возобновить','Остановить'].includes(caption)),'settled task retained live controls');
  stage='stop queued task';reply=await run('ctl-stop','stop');check(!reply.failed,'hard stop failed: '+reply.text);state=await facts();check(!state.pending.some(row=>row.id==='ctl-stop')&&state.records['ctl-stop']?.status==='cancelled','hard stop did not settle actual queued task');
  reply=await run('ctl-stop','stop');check(!reply.failed&&reply.text.includes('cancelled'),'already settled stop not reconciled with task detail: '+reply.text);
  stage='graceful stop acknowledgement';reply=await run('ctl-graceful','wrap_up');check(!reply.failed,'graceful stop acknowledgement failed: '+reply.text);
  check(!all(detail.dialog.get_child(),w=>String(w.constructor.name).includes('WebView')).length,'browser mounted in task controls');
  print('OK: real queued task control and durable pause/hurry retry identity, mailbox deduplication, resume, native state-driven Pause/Resume/Stop controls and declined stop confirmation, hard and graceful stop ingress; no model execution');
 })().catch(error=>{failed=true;logError(error);print('Stage: '+stage)}).finally(()=>{tasks?.close();work.close();actions.close();gateway.close();Adw.AlertDialog.prototype.present=present;win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
