import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {WorkActions}=await import(ARGV[0]+'work-actions.js');
const {WorkJournal}=await import(ARGV[0]+'work-journal.js');
const {WorkState}=await import(ARGV[0]+'work-state.js');
const {TasksPage}=await import(ARGV[0]+'tasks.js');
const {gatewayStatePath}=await import(ARGV[0]+'gateway-state.js');
const check=(value,message)=>{if(!value)throw new Error(message)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,message){for(let i=0;i<700;i++){if(await fn())return;await wait(20)}throw new Error(message)}
function all(widget,predicate){let result=predicate(widget)?[widget]:[];for(let child=widget.get_first_child?.();child;child=child.get_next_sibling())result.push(...all(child,predicate));return result}
const phase=ARGV[3],app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.WorkJournalTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1000,default_height:850});win.present();
 const gateway=new Gateway(ARGV[1],'fixture-secret'),controllers=[],journal=new WorkJournal(gateway.base),path=gatewayStatePath(gateway.base,'work-actions');let stage=phase+' initial state',shown,checksBeforePost=0,work,tasks;
 const bytes=()=>new TextDecoder().decode(GLib.file_get_contents(path)[1]);
 const saved=()=>JSON.parse(bytes());
 const facts=()=>gateway.json('GET','/fixture/facts');
 const service=()=>{const actions=new WorkActions(gateway);controllers.push(actions);return actions};
 const run=(actions,id,action='pause',options,attempt='attempt-1',scope)=>actions.run(win,{target:id,action,...(scope?{scope}:{})},attempt,()=>true,options);
 const present=Adw.Dialog.prototype.present;
 Adw.Dialog.prototype.present=function(parent){present.call(this,parent);if(this.name==='work-pause-reason')shown=this};
 const form=async promise=>{await until(()=>shown,'pause form missing');const dialog=shown;shown=undefined;return {promise,dialog,text:all(dialog.get_child(),w=>w instanceof Gtk.TextView)[0]}};
 const click=(dialog,caption)=>{const item=all(dialog.get_child(),w=>w instanceof Gtk.Button&&w.label===caption)[0];check(item?.sensitive,'missing button '+caption);item.emit('clicked')};
 const json=gateway.json.bind(gateway);
 gateway.json=(...args)=>{
  if(args[0]==='POST'&&/^\/api\/tasks\/[^/]+\/(pause|hurry|cancel)$/.test(args[1])){
   const target=args[1].split('/')[3],body=args[2],entries=saved().entries;
   check(entries.some(item=>JSON.parse(item.key)[0]===target&&JSON.stringify(item.body)===JSON.stringify(body)),'HTTP started before exact body persisted');checksBeforePost++;
  }
  return json(...args);
 };
 (async()=>{
  const ids=['jr-pause-lost','jr-quick-lost','jr-hurry-lost','jr-stop-lost','jr-wrap-lost','jr-resume-lost'];
  const reason='  Почему: проверить <данные> & цену\nТочный текст 🐍\n  ';
  if(phase==='prepare'){
   for(const task_id of [...ids,'jr-native-lost','jr-blocked','jr-cleanup'])check((await gateway.json('POST','/api/tasks',{task_id,description:'Journal '+task_id,chat_id:1,source:'web'})).ok===true,'admission failed');
   for(const id of ['jr-pause-lost','jr-resume-lost']){
    stage='save reason '+id;const actions=service(),r=await form(run(actions,id,'pause',{editPauseReason:true}));r.text.get_buffer().set_text(reason,-1);click(r.dialog,'Поставить на паузу');
    check((await r.promise).failed,'lost reply became success');actions.close();
   }
   for(const [id,action,scope] of [['jr-quick-lost','pause'],['jr-hurry-lost','hurry'],['jr-stop-lost','stop','cascade'],['jr-wrap-lost','wrap_up','single']]){
    stage='save '+action;const actions=service();check((await run(actions,id,action,undefined,'attempt-1',scope)).failed,'lost reply became success');actions.close();
   }
   work=new WorkState(gateway);work.setConnected(true);await work.refresh();
   check((await run(service(),'jr-native-lost','pause',undefined,work.attempt({target:'jr-native-lost',action:'pause'}))).failed,'native preparation acknowledgement not lost');
   const data=saved(),state=await facts();check(data.entries.length===7&&state.calls.length===7&&checksBeforePost===7,'independent controllers overwrote entries');
   check(state.fences['jr-pause-lost'].by.text===reason.trim()&&state.records['jr-hurry-lost'].owner_hurry&&state.records['jr-stop-lost'].status==='cancelled','real controls not durable');
   const mode=Gio.File.new_for_path(path).query_info('unix::mode',0,null).get_attribute_uint32('unix::mode');check((mode&0o777)===0o600,'journal not mode0600');
   const original=bytes(),item=data.entries[0];for(const body of [{...item.body,request_id:GLib.uuid_string_random()},{...item.body,reason:'changed'}]){
    let refused=false;try{new WorkJournal(gateway.base).put(item.key,body)}catch{refused=true}check(refused&&bytes()===original,'another writer replaced pending body');
   }
   check(new WorkJournal(gateway.base+'/other').pending(item.key)===undefined&&new WorkJournal(gateway.base).pending(JSON.stringify(['jr-pause-lost','pause',null,'attempt-2']))===undefined,'gateway/attempt scopes crossed');
   await wait(150);check((await facts()).calls.length===7,'automatic retry before exit');
   print('OK: prepare process persisted seven exact Pause/Hurry/hard-stop/graceful-stop requests in mode0600 before HTTP; real primary effects with lost acknowledgements, controller close preserves journal and separate controllers merge without overwrite; no automatic replay');return;
  }
  const before=await facts(),initial=saved();check(initial.entries.length===7,'prepare journal missing in second process');
  stage='restart without replay';const actions=service();await wait(150);check((await facts()).calls.length===before.calls.length,'constructor replayed saved controls');
  stage='restored custom Pause';let r=await form(run(actions,'jr-pause-lost','pause',{editPauseReason:true}));
  check(!r.text.editable&&r.text.get_buffer().text===reason,'restored reason editable or changed');click(r.dialog,'Повторить исходный запрос');check(!(await r.promise).failed,'restored pause failed');
  stage='native settled Stop receipt after restart';work=new WorkState(gateway);work.setConnected(true);await work.refresh();
  tasks=new TasksPage(win,gateway,()=>({name:'Main',chatId:1}),()=>{},undefined,work);tasks.show('jr-stop-lost');
  const stopped=tasks.openDetails.get('jr-stop-lost');await until(()=>stopped.task&&!stopped.readStatus.label,'settled detail unavailable');
  const stopRetry=all(stopped.controls,w=>w instanceof Gtk.Button&&w.label==='Повторить запрос · Остановить')[0];check(stopRetry?.sensitive,'settled Stop receipt retry missing');stopRetry.emit('clicked');
  await until(()=>!stopped.actionPending,'settled Stop receipt stalled');check(!stopped.status.label.includes('неизвестен')&&!work.actions.pending('jr-stop-lost').length,'settled Stop receipt not reconciled');stopped.close();
  for(const [id,action,scope] of [['jr-quick-lost','pause'],['jr-hurry-lost','hurry'],['jr-wrap-lost','wrap_up','single']]){
   stage='explicit retry '+id;check(!(await run(actions,id,action,undefined,'attempt-1',scope)).failed,'restored '+action+' failed');
  }
  let state=await facts();for(const id of ids.filter(id=>id!=='jr-resume-lost')){
   const calls=state.calls.filter(item=>item.task_id===id);check(calls.length===2&&JSON.stringify(calls[0].body)===JSON.stringify(calls[1].body),'retry body changed '+id);
  }
  check(state.drained_mail['jr-hurry-lost'].filter(item=>item.kind==='hurry').length===1,'restart duplicated hurry effect');
  check(!Object.hasOwn(state.calls.find(item=>item.task_id==='jr-quick-lost').body,'reason'),'quick pause acquired reason');
  check(saved().entries.length===2,'acknowledgement did not preserve unrelated entries');
  stage='Resume retires only its captured Pause requests';
  const transport=gateway.json.bind(gateway),late={key:JSON.stringify(['jr-resume-lost','pause',null,'future-attempt']),body:{request_id:GLib.uuid_string_random(),actor:'owner',reason:'later local request'}};
  gateway.json=async(...args)=>{const reply=await transport(...args);if(args[1]==='/api/tasks/jr-resume-lost/resume')journal.put(late.key,late.body);return reply};
  check(!(await run(actions,'jr-resume-lost','resume')).failed,'Resume failed');gateway.json=transport;
  check(saved().entries.length===2&&journal.pauses('jr-resume-lost').length===1&&journal.pending(late.key)?.request_id===late.body.request_id,'Resume erased a later pending request or retained its old Pause');
  journal.forget([late]);check(saved().entries.length===1,'local overlap fixture cleanup failed');
  check(!(await run(actions,'jr-resume-lost')).failed,'fresh Pause failed');state=await facts();const calls=state.calls.filter(item=>item.task_id==='jr-resume-lost');
  check(calls.length===2&&calls[0].body.request_id!==calls[1].body.request_id&&!Object.hasOwn(calls[1].body,'reason'),'fresh Pause reused old ID/reason');
  stage='native pending receipt after restart';await work.refresh();tasks.show('jr-native-lost');
  const detail=tasks.openDetails.get('jr-native-lost');await until(()=>detail.task&&!detail.readStatus.label,'native detail unavailable');
  check(!all(detail.controls,w=>w instanceof Gtk.Button&&w.label==='Пауза').length,'paused task unexpectedly has ordinary Pause');
  const retry=all(detail.controls,w=>w instanceof Gtk.Button&&w.label==='Повторить запрос · Пауза')[0];check(retry?.sensitive,'native pending retry missing '+JSON.stringify({pending:work.actions.pending('jr-native-lost'),complete:work.complete,attempt:work.attempt({target:'jr-native-lost',action:'pause'}),buttons:all(detail.controls,w=>w instanceof Gtk.Button).map(w=>[w.label,w.sensitive])}));
  const retained=work.actions.pending('jr-native-lost')[0];retry.emit('clicked');await until(()=>shown,'native retry form missing');let dialog=shown;shown=undefined;
  check(!all(dialog.get_child(),w=>w instanceof Gtk.TextView)[0].editable,'restored native request became editable');click(dialog,'Повторить исходный запрос');
  await until(()=>!detail.actionPending,'native retry stalled');state=await facts();let native=state.calls.filter(item=>item.task_id==='jr-native-lost');
  check(native.length===2&&JSON.stringify(native[0].body)===JSON.stringify(native[1].body)&&saved().entries.length===0,'native retry did not confirm exact saved request');
  retry.emit('clicked');await until(()=>!detail.actionPending,'stale native button stalled');
  check((await facts()).calls.filter(item=>item.task_id==='jr-native-lost').length===2&&(await work.actions.retry(win,retained,()=>true)).failed,'old native retry sent new request');
  stage='corrupt journal blocks sends';const clean=bytes(),key=JSON.stringify(['jr-blocked','pause',null,'attempt-1']);
  const good={key,body:{request_id:'valid-request',actor:'owner'}};
  const invalid=['{bad',JSON.stringify({version:2,entries:[]}),JSON.stringify({version:1,entries:[good,good]}),
   ...[{...good,key:JSON.stringify(['active','pause',null,'attempt-1'])},{...good,key:JSON.stringify(['jr-blocked','resume',null,'attempt-1'])},
    {...good,body:{...good.body,actor:'ouroboros'}},{...good,body:{...good.body,reason:3}},{...good,body:{...good.body,request_id:''}},
    {...good,body:{...good.body,extra:true}},{...good,key:JSON.stringify(['jr-blocked','hurry',null,'attempt-1'])},
    {key:JSON.stringify(['jr-blocked','immediate',false,'attempt-1']),body:{stop_action_id:'valid',stop_policy:'immediate',cascade:true}}].map(item=>JSON.stringify({version:1,entries:[item]}))];
  const count=(await facts()).calls.length;
  for(const bad of invalid){GLib.file_set_contents(path,bad);const reply=await run(service(),'jr-blocked');check(reply.failed&&reply.text.includes('не отправлен')&&bytes()===bad,'corrupt journal replaced or send attempted');}
  check((await facts()).calls.length===count,'corrupt journal reached primary');
  stage='write failure preserves readable journal';GLib.file_set_contents(path,clean);
  const directory=Gio.File.new_for_path(GLib.path_get_dirname(path));directory.set_attribute_uint32('unix::mode',0o500,0,null);
  try {const reply=await run(service(),'jr-blocked','hurry');check(reply.failed&&reply.text.includes('не отправлен')&&bytes()===clean&&(await facts()).calls.length===count,'failed durable write still sent action or damaged journal');}
  finally {directory.set_attribute_uint32('unix::mode',0o700,0,null);}
  stage='unwritable destination and explicit repair';Gio.File.new_for_path(path).delete(null);GLib.mkdir_with_parents(path,0o700);
  let reply=await run(service(),'jr-blocked','hurry');check(reply.failed&&reply.text.includes('не отправлен')&&GLib.file_test(path,GLib.FileTest.IS_DIR),'journal directory still sent action');
  Gio.File.new_for_path(path).delete(null);GLib.file_set_contents(path,clean);check(!(await run(service(),'jr-blocked','hurry')).failed,'explicit repaired request failed');
  stage='confirmed receipt with cleanup failure';
  const dispatch=gateway.json.bind(gateway);let repair;
  gateway.json=async(...args)=>{const result=await dispatch(...args);if(args[1]==='/api/tasks/jr-cleanup/hurry'){repair=bytes();GLib.file_set_contents(path,'{cleanup failed');}return result};
  reply=await run(service(),'jr-cleanup','hurry');check(reply.failed&&reply.text.includes('Ускорение принято.')&&reply.text.includes('журнал')&&!reply.text.includes('Результат действия неизвестен'),'confirmed effect became unknown after cleanup failure');
  gateway.json=dispatch;GLib.file_set_contents(path,repair);check(!(await run(service(),'jr-cleanup','hurry')).failed,'cleanup repair retry failed');
  state=await facts();check(state.drained_mail['jr-cleanup'].filter(item=>item.kind==='hurry').length===1&&saved().entries.length===0,'cleanup recovery duplicated effect or retained request');
  print('OK: separate GJS process restored exact owner Pause reason, absent reason, Hurry and both Stop policies/scopes only on explicit retry; real primary receipts/mailbox dedup, Resume retires old Pause and fresh Pause ID; corrupt/unwritable journal blocks HTTP without overwrite, explicit repair and confirmed-receipt cleanup failure recover');
 })().catch(error=>{failed=true;logError(error);print('Stage: '+stage)}).finally(()=>{tasks?.close();work?.close();for(const actions of controllers)actions.close();gateway.close();Adw.Dialog.prototype.present=present;win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
