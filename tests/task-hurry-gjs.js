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
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.TaskHurryTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1000,default_height:1000});win.present();const gateway=new Gateway(ARGV[1],'fixture-secret');let stage='admission',tasks,catalog;
 const facts=()=>gateway.json('GET','/fixture/facts'),control=body=>gateway.json('POST','/fixture/hurry',body);
 const hurry=(id,request_id)=>gateway.json('POST',`/api/tasks/${id}/hurry`,{request_id});
 const text=view=>all(view.widget,w=>w instanceof Gtk.Label).map(w=>w.label).join('\n');
 const expand=view=>{view.widget.expanded=true;for(const item of all(view.widget,w=>w instanceof Gtk.Expander))item.expanded=true};
 (async()=>{
  for(const task_id of ['hurry-view','hurry-ended','hurry-invalid'])check((await gateway.json('POST','/api/tasks',{task_id,description:'Hurry state '+task_id,chat_id:1,source:'web'})).ok===true,'admission failed');
  await gateway.json('POST','/api/ui/i18n/language',{language:'en'});catalog=new NativeI18n(gateway);useNativeI18n(catalog);await until(()=>catalog.language==='en','English not loaded');
  const request='r'.repeat(128);check((await hurry('hurry-view',request)).ok===true,'Hurry refused');
  tasks=new TasksPage(win,gateway,()=>({name:'Main',chatId:1}),()=>{});tasks.show('hurry-view');const detail=tasks.openDetails.get('hurry-view'),view=detail.hurry;
  await until(()=>detail.task&&view.snapshot?.current?.state==='requested','requested snapshot missing');expand(view);
  check(text(view).includes('Hurry requested; application is not yet confirmed.')&&!text(view).includes('Hurry control applied')&&text(view).includes(request)&&view.waiting()&&detail.deliveryPoll,'request acknowledgement pretended applied or no follow-up poll');
  check(view.widget.measure(Gtk.Orientation.HORIZONTAL,-1)[0]<=640,'valid unbroken request ID widened TaskDetail');
  stage='real typed mailbox apply and automatic detail refresh';await control({task_id:'hurry-view',action:'apply'});
  await until(()=>view.snapshot?.current?.state==='applied','requested state did not poll real applied projection');
  check(text(view).includes('Hurry control applied in this attempt.')&&text(view).includes('Plan review is advisory for this task.')&&!view.waiting()&&!detail.deliveryPoll,'applied facts incorrect or polling continued');
  await control({task_id:'hurry-view',action:'apply'});let state=await facts();check(state.records['hurry-view'].owner_hurry.effects.plan_review==='task_local_advisory'&&state.hurry_events.filter(row=>row.task_id==='hurry-view'&&row.phase==='applied').length===1,'real latch/effect dedup failed');
  stage='same-ID retry archives previous attempt';await control({task_id:'hurry-view',action:'retry'});await detail.refresh();expand(view);check(!view.snapshot.current&&view.snapshot.history.length===1&&text(view).includes('Archive reason · fixture_same_id_retry'),'archive hidden or presented as current');
  await hurry('hurry-view','attempt-two');await control({task_id:'hurry-view',action:'apply'});await detail.refresh();expand(view);
  check(view.snapshot.current.attempt_key===2&&view.snapshot.history[0].attempt_key===1&&all(view.widget,w=>w instanceof Gtk.Expander&&w!==view.widget).length===1,'attempts collapsed');
  stage='invalid nested projection retains last confirmed whole snapshot';const cached=view.snapshot;
  const invalid=[{owner_hurry:[]},{owner_hurry:'bad'},{owner_hurry:{state:false}},{owner_hurry:{effects:[]}},{owner_hurry:{effects:{plan_review:{bad:true}}}},
   {owner_hurry:{request_id:null}},{owner_hurry:{attempt_key:0}},{owner_hurry:{attempt_key:1.5}},{owner_hurry_history:{}},{owner_hurry_history:[null]},
   {owner_hurry_history:[{archived_at:[]}]},{owner_hurry:{applied_at:3}}];
  for(const patch of invalid){await gateway.json('POST','/fixture/receipt',{rules:[{task_id:'hurry-view',action:'detail',patch}]});await detail.refresh();check(view.stale&&view.snapshot===cached&&text(view).includes('last confirmed snapshot')&&!detail.readStatus.label,'bad hurry projection replaced state or rejected unrelated task facts');}
  await detail.refresh();check(!view.stale&&view.snapshot.current.state==='applied','valid snapshot did not recover');
  stage='optional and future fields stay compatible';await gateway.json('POST','/fixture/receipt',{rules:[{task_id:'hurry-view',action:'detail',patch:{owner_hurry:{},owner_hurry_history:[]}}]});await detail.refresh();expand(view);check(text(view).includes('did not name the hurry state')&&!text(view).includes('Hurry control applied'),'minimal optional data invented success');
  await gateway.json('POST','/fixture/receipt',{rules:[{task_id:'hurry-view',action:'detail',patch:{owner_hurry:{state:'future <&> phase',effects:{'future effect Ω':'raw <&> result'},future:true},owner_hurry_history:[]}}]});await detail.refresh();expand(view);check(text(view).includes('future <&> phase')&&text(view).includes('raw <&> result'),'future string states/effects were dropped');await detail.refresh();
  stage='all retained history entries shown';for(let attempt=3;attempt<=19;attempt++){await control({task_id:'hurry-view',action:'retry'});await hurry('hurry-view',attempt===19?'private-last <&> Ω':'attempt-'+attempt);}await control({task_id:'hurry-view',action:'apply'});await detail.refresh();expand(view);state=await facts();
  check(state.records['hurry-view'].owner_hurry_history.length===16&&view.snapshot.history.length===16&&all(view.widget,w=>w instanceof Gtk.Expander&&w!==view.widget).length===16,'retained history truncated');
  stage='terminal before application is not success';await hurry('hurry-ended','terminal-request');await gateway.json('POST','/api/tasks/hurry-ended/cancel',{stop_policy:'immediate',stop_action_id:'terminal-stop'});await control({task_id:'hurry-ended',action:'terminal'});tasks.show('hurry-ended');const ended=tasks.openDetails.get('hurry-ended');await until(()=>ended.task,'terminal detail missing');expand(ended.hurry);
  check(ended.hurry.snapshot.current.state==='not_applied_before_terminal'&&text(ended.hurry).includes('ended before the hurry control was applied')&&!ended.hurry.waiting(),'terminal race was reported as applied');
  stage='bad first projection is unavailable';await gateway.json('POST','/fixture/receipt',{rules:[{task_id:'hurry-invalid',action:'detail',patch:{owner_hurry:{state:[]}}}]});tasks.show('hurry-invalid');const invalidDetail=tasks.openDetails.get('hurry-invalid');await until(()=>invalidDetail.task,'invalid detail missing');expand(invalidDetail.hurry);check(invalidDetail.hurry.stale&&!invalidDetail.hurry.snapshot&&text(invalidDetail.hurry).includes('Hurry details are unavailable.'),'bad first projection became confirmed empty');
  await invalidDetail.refresh();check(!invalidDetail.hurry.widget.visible,'confirmed absence did not hide section');
  stage='live captions preserve expansion and private facts';const historyWidgets=all(view.widget,w=>w instanceof Gtk.Expander&&w!==view.widget);historyWidgets[0].expanded=true;historyWidgets[1].expanded=false;const count=(await facts()).calls.filter(row=>row.action==='hurry').length;
  let imported=await gateway.json('POST','/api/ui/i18n/import',{language:'qaa',entries:{'Owner hurry':{text:'QAA hurry'},'Hurry control applied in this attempt.':{text:'QAA applied'}}});await gateway.json('POST','/api/ui/i18n/language',{language:'qaa',profile:{direction:'rtl'}});catalog.frame({type:'ui_language_changed',language:'qaa'});catalog.frame({type:'ui_i18n_updated',language:'qaa',revision:imported.revision});await until(()=>view.widget.label==='QAA hurry','hurry captions not live');
  const repainted=all(view.widget,w=>w instanceof Gtk.Expander&&w!==view.widget);check(text(view).includes('QAA applied')&&text(view).includes('private-last <&> Ω')&&view.widget.expanded&&repainted[0].expanded&&!repainted[1].expanded&&view.widget.get_direction()===Gtk.TextDirection.RTL,'locale dropped state/expansion');
  await until(async()=>(await facts()).audit.some(row=>row.path==='/api/ui/i18n/missing'),'real missing report absent');state=await facts();check(state.calls.filter(row=>row.action==='hurry').length===count&&!JSON.stringify(state.audit.filter(row=>row.path==='/api/ui/i18n/missing')).includes('private-last <&> Ω'),'locale posted Hurry or private ID became translation source');
  const closedTitle=view.widget.label;detail.close();await gateway.json('POST','/api/ui/i18n/language',{language:'en'});catalog.frame({type:'ui_language_changed',language:'en'});await until(()=>catalog.language==='en','English reset failed');check(view.widget.label===closedTitle,'closed view retained locale watcher');
  check(state.chat_bytes===0&&state.hurry_events.every(row=>row.is_progress===false)&&!state.audit.some(row=>row.path==='/api/chat/send'||row.path==='/api/command'),'Hurry projection created dialogue');
  print('OK: production native TaskDetail reads real requested/applied/not-applied Hurry projections, polls pending application, typed mailbox latch/effect dedup, retry archive and all 16 retained histories; malformed whole-projection cache retention, optional/future data, live i18n/RTL/expansion and private-key isolation; real handlers/writers, inert worker contexts, no model execution or chat side effect');
 })().catch(error=>{failed=true;logError(error);print('Stage: '+stage)}).finally(()=>{tasks?.close();catalog?.close();useNativeI18n();gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
