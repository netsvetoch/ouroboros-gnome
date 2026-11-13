import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {TasksPage}=await import(ARGV[0]+'tasks.js');
const {NativeI18n,useNativeI18n}=await import(ARGV[0]+'native-i18n.js');
const check=(value,message)=>{if(!value)throw new Error(message)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,message){for(let i=0;i<900;i++){if(await fn())return;await wait(20)}throw new Error(message)}
function all(widget,predicate){let result=predicate(widget)?[widget]:[];for(let child=widget.get_first_child?.();child;child=child.get_next_sibling())result.push(...all(child,predicate));return result}
const text=view=>all(view.widget,w=>w instanceof Gtk.Label).map(w=>w.label).join('\n');
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.RetentionTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1000,default_height:1000});win.present();const gateway=new Gateway(ARGV[1],'fixture-secret');let tasks,catalog,stage='seed';
 const task_id='retention-view';
 const write=promotion=>gateway.json('POST','/fixture/retention',{task_id,promotion:{schema_version:1,status:'incomplete',pending_refs:[],unavailable_refs:[],promoted_ref_count:7,promoted_source_handle_count:3,...promotion}});
 const patch=history_retention=>gateway.json('POST','/fixture/receipt',{rules:[{task_id,action:'detail',patch:{history_retention}}]});
 const facts=()=>gateway.json('GET','/fixture/facts');
 (async()=>{
  await write({pending_refs:[{kind:'history_retention_deferred',reason:'background_history_retention'}]});
  await gateway.json('POST','/api/ui/i18n/language',{language:'en'});catalog=new NativeI18n(gateway);useNativeI18n(catalog);await until(()=>catalog.language==='en','English not loaded');
  tasks=new TasksPage(win,gateway,()=>({name:'Main',chatId:1}),()=>{});tasks.show(task_id);const detail=tasks.openDetails.get(task_id),view=detail.historyRetention;
  await until(()=>view.snapshot?.status==='pending','actual retention summary missing');view.widget.expanded=true;
  check(detail.task.status==='completed'&&view.waiting()&&detail.deliveryPoll,'storage pending changed task outcome or did not poll');
  check(text(view).includes('being saved in the background')&&text(view).includes('Pending entries · 1')&&text(view).includes('Saved references · 7')&&text(view).includes('Saved source handles · 3'),'pending facts missing');
  stage='real grouped problem summary';const reason='private-retention <&> Ω '+ 'x'.repeat(2048);
  await write({pending_refs:[{kind:'copy',reason},{kind:'copy',reason}],unavailable_refs:[{reason:'source_unavailable'}]});
  await until(()=>view.snapshot?.status==='problem','pending polling did not discover problem');
  check(detail.task.status==='completed'&&!view.waiting()&&!detail.deliveryPoll&&view.widget.label==='History storage problem','problem changed lifecycle or stayed hidden on collapsed title');
  check(text(view).includes('2 × '+reason)&&text(view).includes('1 × source_unavailable')&&text(view).includes('Problem entries · 3'),'grouped reasons/counts missing');
  check(view.widget.measure(Gtk.Orientation.HORIZONTAL,-1)[0]<=640&&all(view.widget,w=>w instanceof Gtk.Label&&w.label.includes('<&>')).every(w=>!w.use_markup),'reason broke geometry or parsed markup');
  stage='malformed snapshots retain prior facts';const confirmed=JSON.stringify(view.snapshot);
  for(const bad of [[],{}, {status:2},{status:'complete',pending_count:-1},{status:'complete',problem_count:1.2},{status:'complete',promoted_ref_count:'2'},{status:'complete',promoted_source_handle_count:null},{status:'complete',problem_reasons:{}},{status:'complete',problem_reasons:[{reason:42}]},{status:'complete',problem_reasons:[{reason:'x',count:-1}]}]){
   await patch(bad);await detail.refresh();check(view.stale&&JSON.stringify(view.snapshot)===confirmed&&text(view).includes('last confirmed snapshot')&&text(view).includes(reason),'bad projection replaced last good snapshot');
  }
  stage='optional and additive compatibility';await patch({status:'future-storage-state',extra:{future:true},problem_reasons:[{reason:'future <&> reason'}]});await detail.refresh();
  check(!view.stale&&text(view).includes('future-storage-state')&&text(view).includes('future <&> reason')&&!view.waiting(),'future string data rejected or invented pending state');
  await patch({status:'deferred'});await detail.refresh();check(view.waiting(),'legacy deferred not treated as pending');
  stage='real complete summary';await write({status:'complete'});await detail.refresh();
  check(view.snapshot.status==='complete'&&!view.stale&&!view.waiting()&&!detail.deliveryPoll&&text(view).includes('Task history has been saved.')&&detail.task.status==='completed','complete receipt not independent or poll retained');
  stage='live language with private facts';await write({pending_refs:[{kind:'copy',reason}]});await detail.refresh();view.widget.expanded=true;
  const imported=await gateway.json('POST','/api/ui/i18n/import',{language:'qaa',entries:{'History storage problem':{text:'QAA storage problem'},'Some task history could not be saved.':{text:'QAA storage failed'}}});
  await gateway.json('POST','/api/ui/i18n/language',{language:'qaa',profile:{direction:'rtl'}});catalog.frame({type:'ui_language_changed',language:'qaa'});catalog.frame({type:'ui_i18n_updated',language:'qaa',revision:imported.revision});
  await until(()=>view.widget.label==='QAA storage problem','live title missing');check(text(view).includes('QAA storage failed')&&text(view).includes(reason)&&view.widget.expanded&&view.widget.get_direction()===Gtk.TextDirection.RTL,'locale dropped facts/expansion/direction');
  await until(async()=>(await facts()).audit.some(row=>row.path==='/api/ui/i18n/missing'),'missing report absent');
  let state=await facts();check(!JSON.stringify(state.audit.filter(row=>row.path==='/api/ui/i18n/missing')).includes('private-retention'),'private reason became translation source');
  stage='confirmed absence and bad first read';await patch(null);await detail.refresh();check(!view.widget.visible&&!view.snapshot,'absence not cleared');
  await patch({status:'complete',pending_count:'invalid'});await detail.refresh();check(view.stale&&view.widget.visible&&!view.snapshot,'bad first projection became absence');
  const frozen=text(view),title=view.widget.label;detail.close();await gateway.json('POST','/api/ui/i18n/language',{language:'en'});catalog.frame({type:'ui_language_changed',language:'en'});await until(()=>catalog.language==='en','language reset failed');
  check(text(view)===frozen&&view.widget.label===title&&!detail.deliveryPoll,'closed view retained watcher/poll');state=await facts();
  check(state.chat_bytes===0&&!state.audit.some(row=>row.method==='POST'&&row.path.startsWith('/api/tasks')),'storage display changed work or chat');
  print('OK: native TaskDetail real stored retention summary pending/problem/complete, background detail polling, grouped reasons and all counters, independent completed outcome; ten malformed projections retain prior facts, optional/future/deferred compatibility, absent/bad first states, long literal reasons, live i18n/RTL and close cleanup; actual settings/task writer/router, no promotion worker or model execution');
 })().catch(error=>{failed=true;logError(error);print('Stage: '+stage)}).finally(()=>{tasks?.close();catalog?.close();useNativeI18n();gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
