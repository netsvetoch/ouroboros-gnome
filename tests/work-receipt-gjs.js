import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {WorkActions}=await import(ARGV[0]+'work-actions.js');
const {WorkState}=await import(ARGV[0]+'work-state.js');
const {TasksPage}=await import(ARGV[0]+'tasks.js');
const check=(value,message)=>{if(!value)throw new Error(message)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,message){for(let i=0;i<800;i++){if(await fn())return;await wait(20)}throw new Error(message)}
function all(widget,predicate){let result=predicate(widget)?[widget]:[];for(let child=widget.get_first_child?.();child;child=child.get_next_sibling())result.push(...all(child,predicate));return result}
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.WorkReceiptTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1000,default_height:850});win.present();
 const gateway=new Gateway(ARGV[1],'fixture-secret'),actions=new WorkActions(gateway);let stage='admission',sequence=0,work,tasks,shown;
 const present=Adw.Dialog.prototype.present;Adw.Dialog.prototype.present=function(parent){present.call(this,parent);if(this.name==='work-pause-reason')shown=this};
 const facts=()=>gateway.json('GET','/fixture/facts');
 const rules=rules=>gateway.json('POST','/fixture/receipt',{rules});
 const admit=async()=>{const id='receipt-'+(++sequence);check((await gateway.json('POST','/api/tasks',{task_id:id,description:'Native receipt '+id,chat_id:1,source:'web'})).ok===true,'admission failed');return id};
 const run=(id,action='pause',scope)=>actions.run(win,{target:id,action,...(scope?{scope}:{})},'attempt-1',()=>true);
 const click=(root,text)=>{const item=all(root,w=>w instanceof Gtk.Button&&w.label===text)[0];check(item?.sensitive,'missing enabled '+text);item.emit('clicked')};
 const retry=async(id,action)=>{const first=(await facts()).responses.filter(row=>row.task_id===id&&row.action===(['stop','wrap_up'].includes(action)?'cancel':action))[0];const result=await run(id,action);check(!result.failed&&!actions.pending(id).length,'exact retry did not recover '+id+': '+result.text);const calls=(await facts()).responses.filter(row=>row.task_id===id&&row.action===first.action);check(calls.length===2&&JSON.stringify(calls[0].body)===JSON.stringify(calls[1].body),'receipt corruption changed retry body '+id)};
 (async()=>{
  const malformed=[
   ['pause',{patch:{task_id:'another-task'}}],['pause',{patch:{ok:'true'}}],['pause',{patch:{error:'contradictory success'}}],
   ['pause',{patch:{duplicate:1}}],['pause',{patch:{latch_pending:'false'}}],['pause',{patch:{state:'unknown-state'}}],
   ['pause',{patch:{state:'released',latch_pending:true}}],['pause',{patch:{membership_gaps:{count:1,rows:[null]}}}],
   ['pause',{patch:{blockers:[null]}}],['pause',{body:[]}],['pause',{body:null}],
   ['hurry',{patch:{request_id:'another-request'}}],['hurry',{patch:{attempt_key:1.5}}],['hurry',{patch:{attempt_key:0}}],
   ['hurry',{patch:{state:3}}],['hurry',{patch:{unconfirmed:true}}],
   ['stop',{patch:{task_id:'another-task'}}],['stop',{patch:{cancel_state:3}}],['stop',{patch:{stop_policy:'unknown-policy'}}],
   ['stop',{patch:{cascade:false}}],['stop',{patch:{stop_policy:'finalize_then_cancel'}}],
   ['stop',{patch:{membership_gaps:{count:'1',rows:[]}}}],['stop',{patch:{request_id:{invalid:true}}}],
  ];
  for(const [action,rule] of malformed){
   stage='malformed '+action+' '+JSON.stringify(rule);const id=await admit();await rules([{task_id:id,action:action==='stop'?'cancel':action,...rule}]);
   const result=await run(id,action);check(result.failed&&result.text.includes('неизвестен')&&actions.pending(id).length===1&&!result.successor,'malformed response cleared pending or navigated '+result.text);
   const state=await facts(),call=state.responses.find(row=>row.task_id===id);check(call.status<300,'fixture did not run actual handler first');
   if(action==='pause')check(state.fences[id]?.fence_id,'real pause absent');
   if(action==='hurry')check(state.records[id]?.owner_hurry,'real hurry absent');
   await retry(id,action);
  }
  stage='minimal and additive receipts';
  for(const action of ['pause','hurry','stop']){
   const id=await admit();await rules([{task_id:id,action:action==='stop'?'cancel':action,body:{ok:true,successor_task_id:'unsolicited-task',future:{v:1}}}]);
   const result=await run(id,action);check(!result.failed&&!result.successor&&!actions.pending(id).length,'optional echoes or additive data rejected');
  }
  const additive=await admit();await rules([{task_id:additive,action:'pause',patch:{blockers:[{}],membership_gaps:{count:1,rows:[{}, {task_id:'unreadable-task'}],future:true},snapshot_persisted:false,future:true}}]);
  check(!(await run(additive)).failed,'compatible optional nested data rejected');
  stage='effective Stop policy and custody ID';const hardened=await admit();await gateway.json('POST','/fixture/receipt',{hard_intent:hardened});
  let result=await run(hardened,'wrap_up','single');check(!result.failed,'already hard intent rejected graceful acknowledgement');
  check((await facts()).responses.find(row=>row.task_id===hardened)?.reply.stop_policy==='immediate','fixture did not produce real effective immediate policy');
  const custody=await admit();await rules([{task_id:custody,action:'cancel',patch:{cancel_state:'pending',stop_policy:'immediate',request_id:'custody-id-not-stop-action',cascade:true}}]);
  result=await run(custody,'stop','single');check(!result.failed&&!actions.pending(custody).length,'effective widened scope or custody ID confused with stop_action_id');
  stage='malformed refusals preserve exact request';
  for(const rule of [{status:409,body:{ok:true,error:'contradictory'}},{status:409,body:{error:'foreign',task_id:'another-task'}},
   {status:400,body:['not','an','object']},{status:409,body:{error:'unknown',unconfirmed:true}},{status:409,body:{error:3}}]){
   const id=await admit();await rules([{task_id:id,action:'pause',...rule}]);result=await run(id);check(result.failed&&result.text.includes('неизвестен')&&actions.pending(id).length===1,'malformed refusal erased request');await retry(id,'pause');
  }
  stage='foreign 404/detail cannot settle this Stop';const foreign=await admit();await rules([
   {task_id:foreign,action:'cancel',status:404,body:{error:'foreign 404',task_id:'another-task'}},
   {task_id:foreign,action:'detail',patch:{task_id:'another-task',status:'foreign-terminal',cancel_state:'pending'}},
  ]);result=await run(foreign,'stop');check(result.failed&&result.text.includes('неизвестен')&&!result.text.includes('foreign-terminal')&&!result.text.includes('остановка ещё выполняется')&&actions.pending(foreign).length===1,'alien detail became owner fact');await retry(foreign,'stop');
  const intent=await admit();await rules([{task_id:intent,action:'cancel',status:503,body:{error:'foreign failure',reason_code:'cancel_intent_write_failed',task_id:'another-task'}}]);
  result=await run(intent,'stop');check(result.failed&&result.text.includes('неизвестен')&&!result.text.includes('Остановка не записана')&&actions.pending(intent).length===1,'foreign reason code became definite refusal');await retry(intent,'stop');
  stage='genuine definite refusal';result=await run('receipt-does-not-exist');check(result.failed&&!result.text.includes('Результат действия неизвестен')&&!actions.pending('receipt-does-not-exist').length,'real pre-action refusal retained unknown request');
  stage='each latch acknowledgement checked';const latch=await admit();await rules([
   {task_id:latch,action:'pause',status:202,patch:{latch_pending:true}},
   ...Array.from({length:4},()=>({task_id:latch,action:'pause',patch:{task_id:'another-task',latch_pending:false}})),
  ]);result=await run(latch);check(!result.failed&&result.text.includes('Очередь ещё подтверждает')&&actions.pending(latch).length===1,'bad latch retry erased original pending acknowledgement');
  const latches=(await facts()).responses.filter(row=>row.task_id===latch);check(latches.length===5&&latches.every(row=>JSON.stringify(row.body)===JSON.stringify(latches[0].body)),'latch body changed');
  check(!(await run(latch)).failed&&!actions.pending(latch).length,'explicit latch receipt recovery failed');
  stage='Resume response cannot forget Pause or navigate';
  for(const patch of [{task_id:'another-task'},{held:'false'},{tree_only:1},{membership_gaps:{count:1,rows:[null]}},{late_phase:false}]){
   const id=await admit();await rules([{task_id:id,action:'pause',patch:{task_id:'another-task'}}]);check((await run(id)).failed,'Pause preparation not unknown');
   await rules([{task_id:id,action:'resume',patch}]);result=await run(id,'resume');const state=await facts();
   check(result.failed&&result.text.includes('неизвестен')&&!result.successor&&actions.pending(id).length===1&&state.fences[id].state==='released','bad Resume acknowledgement erased Pause or suppressed real release');
   check(state.responses.filter(row=>row.task_id===id&&row.action==='resume').length===1,'Resume automatically replayed');check(!(await run(id)).failed&&!actions.pending(id).length,'released old Pause receipt not recoverable');
  }
  stage='compatible Resume responses and late-phase wording';
  for(const [wire,word] of [[{body:{ok:true,successor_task_id:'unsolicited-task'}},'Возобновление принято'],
   [{patch:{late_phase:'settled',successor_task_id:'unsolicited-task'}},'не запускается повторно'],
   [{patch:{late_phase:'resumed'}},'Возобновлена работа после'],[{patch:{late_phase:'future-phase'}},'Состояние · future-phase']]){
   const id=await admit();check(!(await run(id)).failed,'Pause for compatible Resume failed');await rules([{task_id:id,action:'resume',...wire}]);
   result=await run(id,'resume');check(!result.failed&&!result.successor&&result.text.includes(word),'compatible Resume response or late phase misrepresented');
  }
  stage='native unknown receipt and exact retry';const native=await admit();work=new WorkState(gateway);work.setConnected(true);await work.refresh();
  tasks=new TasksPage(win,gateway,()=>({name:'Main',chatId:1}),()=>{},undefined,work);tasks.show(native);const detail=tasks.openDetails.get(native);await until(()=>detail.task&&!detail.readStatus.label,'native detail unavailable');
  await rules([{task_id:native,action:'pause',patch:{task_id:'another-task',successor_task_id:'unsolicited-task'}}]);click(detail.controls,'Пауза');await until(()=>!detail.actionPending,'native action stalled');
  check(detail.status.label.includes('неизвестен')&&tasks.openDetails.size===1,'native bad receipt reported success or opened alien task');
  await work.refresh();await detail.refresh();click(detail.controls,'Повторить запрос · Пауза');await until(()=>shown,'native pending form unavailable');const dialog=shown;shown=undefined;click(dialog.get_child(),'Повторить исходный запрос');await until(()=>!detail.actionPending,'native retry stalled');
  check(!work.actions.pending(native).length&&!detail.status.label.includes('неизвестен'),'native retry did not confirm original receipt');
  print('OK: real Pause/Hurry/Stop/Resume side effects survive malformed/foreign HTTP receipts without losing exact retries, compatible minimal/additive envelopes accepted, real monotonic Stop policy and custody-ID separation, foreign refusal/detail isolation, per-latch validation, no non-Continue navigation or automatic Resume replay; native TaskDetail unknown receipt and exact recovery. Latch/selected response projections synthetic; workers inert.');
 })().catch(error=>{failed=true;logError(error);print('Stage: '+stage)}).finally(()=>{tasks?.close();work?.close();actions.close();gateway.close();Adw.Dialog.prototype.present=present;win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
