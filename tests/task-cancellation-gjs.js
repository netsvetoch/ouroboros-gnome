import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {TasksPage}=await import(ARGV[0]+'tasks.js');
const {NativeI18n,useNativeI18n}=await import(ARGV[0]+'native-i18n.js');
const check=(v,m)=>{if(!v)throw new Error(m)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,m){for(let i=0;i<1000;i++){if(await fn())return;await wait(20)}throw new Error(m)}
function all(w,p){let out=p(w)?[w]:[];for(let c=w.get_first_child?.();c;c=c.get_next_sibling())out.push(...all(c,p));return out}
const text=w=>all(w,w=>w instanceof Gtk.Label).map(w=>w.label).join('\n');
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.CancellationTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1000,default_height:1000});win.present();const gateway=new Gateway(ARGV[1],'fixture-secret');let tasks,catalog,stage='real pending intent';
 const task_id='cancellation-detail',control=(action,extra={})=>gateway.json('POST','/fixture/cancellation',{task_id,action,...extra}),facts=()=>gateway.json('GET','/fixture/facts');
 const patch=values=>gateway.json('POST','/fixture/receipt',{rules:[{task_id,action:'detail',patch:values}]});
 (async()=>{
  await control('seed');const reason='Owner saved stop reason <&> Ω '+ 'x'.repeat(2048);await control('request',{policy:'finalize_then_cancel',reason});
  await gateway.json('POST','/api/ui/i18n/language',{language:'en'});catalog=new NativeI18n(gateway);useNativeI18n(catalog);await until(()=>catalog.language==='en','English unavailable');
  tasks=new TasksPage(win,gateway,()=>({name:'Main',chatId:1}),()=>{});win.set_content(tasks.widget);tasks.show(task_id);const detail=tasks.openDetails.get(task_id),view=detail.cancellation;
  await until(()=>detail.task?.cancel_state==='pending','actual cancel projection missing');await tasks.refresh();
  check(detail.task.status==='running'&&view.waiting()&&detail.deliveryPoll&&text(view.widget).includes('Finalizing before stop')&&text(view.widget).includes(reason),'graceful stop reason, nonterminal status or polling missing');
  check(!text(detail.summary).includes('Идёт остановка')&&tasks.inventory.subtitle(tasks.inventory.snapshot.items.get(task_id)).includes('Finalizing before stop'),'generic badge duplicate or missing list status');
  check(view.widget.measure(Gtk.Orientation.HORIZONTAL,-1)[0]<=640&&all(view.widget,w=>w instanceof Gtk.Label).every(w=>!w.use_markup),'reason broke layout or markup');
  stage='actual hard escalation';await control('request',{policy:'immediate',reason:'Immediate stop <&>'});
  await until(()=>text(view.widget).includes('Stop in progress')&&!text(view.widget).includes('Finalizing before stop'),'periodic detail read did not discover escalation');
  check(detail.task.status==='running'&&detail.deliveryPoll,'pending escalation became cancelled');
  stage='bad and additive read projections';
  for(const values of [{cancel_state:[]},{cancel_state:true},{cancel_state:'pending',stop_policy:{}},{cancel_state:'pending',cancel_reason:42}]){
   await patch(values);await detail.refresh();check(text(view.widget).includes('Stop details are unavailable')&&view.waiting()&&detail.deliveryPoll,'bad projection became settled/empty');check(!detail.legacyControls(detail.task).length,'unreadable cancellation granted legacy actions');
  }
  await patch({cancel_state:'future-stop',stop_policy:'future-policy',cancel_reason:'Future reason <&>',extra:true});await detail.refresh();
  check(text(view.widget).includes('Stop state · future-stop')&&text(view.widget).includes('Stop policy · future-policy')&&!view.waiting()&&!detail.deliveryPoll,'future stop inferred pending/completed or lost literal fields');check(!detail.legacyControls(detail.task).length,'unknown cancellation granted legacy actions');
  await detail.refresh();check(view.waiting(),'real pending state did not recover');
  stage='failed read preserves last state';await gateway.json('POST','/fixture/receipt',{rules:[{task_id,action:'detail',status:503,body:{error:'controlled read failure'}}]});await detail.refresh();
  check(text(view.widget).includes('Stop in progress')&&detail.readStatus.label.includes('Не удалось')&&detail.deliveryPoll,'failed read lost pending stop');
  stage='live locale without private reason keys';await patch({cancel_state:'pending',stop_policy:'finalize_then_cancel',cancel_reason:reason});await detail.refresh();
  const translated=await gateway.json('POST','/api/ui/i18n/import',{language:'qaa',entries:{'Finalizing before stop':{text:'QAA finishing'},'Stop reason · {reason}':{text:'QAA reason · {reason}'}}});
  await gateway.json('POST','/api/ui/i18n/language',{language:'qaa',profile:{direction:'rtl'}});catalog.frame({type:'ui_language_changed',language:'qaa'});catalog.frame({type:'ui_i18n_updated',language:'qaa',revision:translated.revision});
  await until(()=>text(view.widget).includes('QAA finishing'),'live heading translation absent');check(text(view.widget).includes('QAA reason · '+reason)&&all(view.widget,w=>w instanceof Gtk.Label)[0].get_direction()===Gtk.TextDirection.RTL,'locale lost reason/direction');
  await until(async()=>(await facts()).audit.some(r=>r.path==='/api/ui/i18n/missing'),'missing report absent');check(!JSON.stringify((await facts()).audit.filter(r=>r.path==='/api/ui/i18n/missing')).includes('Owner saved stop reason'),'private reason became translation key');
  stage='real settlement discovered automatically';await control('settle');await until(()=>detail.task.status==='cancelled'&&!view.widget.visible&&!detail.deliveryPoll,'pending polling did not discover terminal settlement');await tasks.refresh();
  check(!view.waiting()&&!tasks.inventory.subtitle(tasks.inventory.snapshot.items.get(task_id)).includes('Stop in progress')&&text(detail.summary).includes('Retained partial result'),'settled intent remains active or result lost');
  for(const cancel_state of [null,'',undefined]){await patch({cancel_state,cancel_reason:'Historical orphan reason',stop_policy:'finalize_then_cancel'});await detail.refresh();check(!view.widget.visible&&!view.waiting(),'orphan stop fields implied active intent')}
  stage='close removes poll and bindings';await patch({cancel_state:'pending',cancel_reason:reason});await detail.refresh();const frozen=text(view.widget);detail.close();await wait(30);await gateway.json('POST','/api/ui/i18n/language',{language:'en'});catalog.frame({type:'ui_language_changed',language:'en'});await until(()=>catalog.language==='en','reset language pending');
  check(!detail.deliveryPoll&&!view.waiting()&&text(view.widget)===frozen,'closed view kept poll or translation binding');const f=await facts();check(f.calls.length===0&&f.chat_bytes===0&&!f.audit.some(r=>r.method==='POST'&&r.path.startsWith('/api/tasks')),'read view sent task/chat mutation');
  print('OK: native pending cancellation intent, graceful/immediate policy and saved reason through actual request_cancel/effective task projection; running lifecycle stays truthful, inventory caption, periodic escalation/terminal discovery, actual settled partial result, four malformed projections explicit/retried, future/absent/orphan fields, read failure retention, long literal reason, live i18n/RTL without private key, close removes poll/bindings; fixture owns intent/terminal writers, no worker/model/teardown');
 })().catch(error=>{failed=true;logError(error);print('Stage: '+stage)}).finally(()=>{tasks?.close();catalog?.close();useNativeI18n();gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
