import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {TasksPage}=await import(ARGV[0]+'tasks.js');
const {ActivityPage}=await import(ARGV[0]+'activity.js');
const {projectHold,projectHoldPanel}=await import(ARGV[0]+'project-hold.js');
const {NativeI18n,useNativeI18n}=await import(ARGV[0]+'native-i18n.js');
const check=(v,m)=>{if(!v)throw new Error(m)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,m){for(let i=0;i<1000;i++){if(await fn())return;await wait(20)}throw new Error(m)}
function all(w,p){let out=p(w)?[w]:[];if(w instanceof Gtk.Expander){const c=w.get_child();return c?[...out,...all(c,p)]:out}for(let c=w.get_first_child?.();c;c=c.get_next_sibling())out.push(...all(c,p));return out}
const text=w=>all(w,w=>w instanceof Gtk.Label).map(w=>w.label).join('\n');
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.ProjectHoldTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1000,default_height:1000});win.present();const gateway=new Gateway(ARGV[1],'fixture-secret');let tasks,activity,catalog,stage='accepted project task';
 const task_id='project-held',control=action=>gateway.json('POST','/fixture/project-hold',{action}),facts=()=>gateway.json('GET','/fixture/facts');
 (async()=>{
  const project=await control('setup');
  await gateway.json('POST','/api/tasks',{task_id,description:'Keep this original project assignment <&>',project_id:project.id,memory_mode:'empty'});
  await control('hold');let f=await facts();const basis=JSON.stringify(f.pending[0]._project_admission);
  check(f.pending[0]._project_admission_restore_hold&&f.records[task_id].status==='scheduled','actual restore hold absent');
  await gateway.json('POST','/api/ui/i18n/language',{language:'en'});catalog=new NativeI18n(gateway);useNativeI18n(catalog);await until(()=>catalog.language==='en','English unavailable');
  tasks=new TasksPage(win,gateway,()=>({name:'Main',chatId:1}),()=>{});win.set_content(tasks.widget);await tasks.refresh();tasks.show(task_id);const detail=tasks.openDetails.get(task_id);
  await until(()=>detail.task?.project_admission_hold?.label,'detail did not read actual hold');
  check(text(detail.summary).includes('Waiting for Project verification')&&text(detail.summary).includes('The task was accepted.')&&detail.deliveryPoll,'detail wait or polling missing');
  check(tasks.inventory.subtitle(tasks.inventory.snapshot.items.get(task_id)).includes('Waiting for Project verification'),'inventory dropped queue wait for saved task');
  activity=new ActivityPage(win,gateway,()=>{},()=>undefined);await activity.refresh();check(text(activity.queue).includes('Waiting for Project verification'),'activity queue wait missing');
  stage='real authority recovery without task replay';await control('heal');
  await until(()=>!projectHold(detail.task)&&!detail.deliveryPoll,'automatic detail read did not remove healed wait');await tasks.refresh();await activity.refresh();
  check(!text(detail.summary).includes('The task was accepted.')&&!text(activity.queue).includes('Waiting for Project verification'),'healed wait remained visible');
  check(!tasks.inventory.subtitle(tasks.inventory.snapshot.items.get(task_id)).includes('Waiting for Project verification'),'inventory did not clear explicit empty hold');
  f=await facts();check(f.pending.length===1&&f.pending[0].id===task_id&&JSON.stringify(f.pending[0]._project_admission)===basis&&!f.pending[0]._project_admission_restore_hold,'revalidation changed original task or failed to release project hold');
  check(f.pending[0]._budget_pause_hold?.reason==='saved_work_hold','revalidation released independent app-stop hold');
  stage='long inventory wait caption';
  const listed=tasks.inventory.snapshot.items.get(task_id);
  listed.task={...listed.task,project_admission_hold:{label:'Private wait <&> '+ 'Ω'.repeat(2048)}};tasks.inventory.render();await wait(30);
  check(text(tasks.widget).includes(listed.task.project_admission_hold.label),'long wait was truncated in list');
  const waitLabels=all(tasks.widget,w=>w instanceof Gtk.Label&&w.label.includes('Private wait <&>'));
  check(waitLabels.length&&waitLabels.every(w=>!w.use_markup&&w.measure(Gtk.Orientation.HORIZONTAL,-1)[0]<=640),'long list wait broke geometry or markup');
  await tasks.refresh();
  stage='partial future and malformed projections';
  const reason='private-project-hold <&> Ω '+'x'.repeat(2048);
  const panel=projectHoldPanel({project_admission_hold:{reason,detail:'literal detail <&>',label:'Gateway own wait <&>',future:{x:true}}});
  check(text(panel).includes(reason)&&text(panel).includes('literal detail <&>')&&text(panel).includes('Gateway own wait <&>'),'literal/future fields lost');
  check(panel.measure(Gtk.Orientation.HORIZONTAL,-1)[0]<=640&&all(panel,w=>w instanceof Gtk.Label).every(w=>!w.use_markup),'wait broke geometry or markup safety');
  const translated=await gateway.json('POST','/api/ui/i18n/import',{language:'qaa',entries:{'Reason · {reason}':{text:'QAA reason · {reason}'}}});
  await gateway.json('POST','/api/ui/i18n/language',{language:'qaa',profile:{direction:'rtl'}});catalog.frame({type:'ui_language_changed',language:'qaa'});catalog.frame({type:'ui_i18n_updated',language:'qaa',revision:translated.revision});
  await until(()=>text(panel).includes('QAA reason · '+reason),'live translated reason missing');
  check(text(panel).includes('Gateway own wait <&>')&&all(panel,w=>w instanceof Gtk.Label&&w.label.startsWith('QAA reason'))[0].get_direction()===Gtk.TextDirection.RTL,'translation changed gateway label or omitted direction');
  for(const bad of [[],false,'held',42,{label:42},{reason:[]},{detail:{}}]){
   await gateway.json('POST','/fixture/receipt',{rules:[{task_id,action:'detail',patch:{project_admission_hold:bad}}]});await detail.refresh();
   check(text(detail.summary).includes('Project waiting details are unavailable')&&detail.deliveryPoll,'bad hold hidden or not re-read');
  }
  for(const absent of [null,{}, {label:null,reason:null,detail:null}]){
   await gateway.json('POST','/fixture/receipt',{rules:[{task_id,action:'detail',patch:{project_admission_hold:absent}}]});await detail.refresh();
   check(!projectHold(detail.task)&&!detail.deliveryPoll&&!text(detail.summary).includes('Project waiting details are unavailable'),'empty hold did not clear');
  }
  stage='read failures preserve wait and close stops polling';
  await gateway.json('POST','/fixture/receipt',{rules:[{task_id,action:'detail',patch:{project_admission_hold:{label:'Synthetic readonly wait'}}}]});await detail.refresh();
  await gateway.json('POST','/fixture/receipt',{rules:[{task_id,action:'detail',status:503,body:{error:'read unavailable'}}]});await detail.refresh();
  check(text(detail.summary).includes('Synthetic readonly wait')&&detail.readStatus.label.includes('Не удалось')&&detail.deliveryPoll,'failed read erased wait or stopped recovery');
  detail.close();await wait(30);check(!detail.deliveryPoll,'close retained polling');
  await until(async()=>(await facts()).audit.some(r=>r.path==='/api/ui/i18n/missing'),'missing report absent');f=await facts();
  check(!JSON.stringify(f.audit.filter(r=>r.path==='/api/ui/i18n/missing')).includes('private-project-hold'),'private reason became translation key');
  check(f.calls.length===0&&f.chat_bytes===0&&f.audit.filter(r=>r.method==='POST'&&r.path.startsWith('/api/tasks')).length===1,'readonly hold display sent work command');
  print('OK: native task detail, inventory and Activity show real Project hold from accepted task snapshot restore under torn registry; actual revalidate_project_holds clears same-id hold while independent app-stop pause/basis remain; detail polling discovers recovery, explicit empty removes cached wait, seven malformed variants visible/retried, additive/nullable fields, literal long reasons, read failure retention, close removes polling, no task replay/model/worker');
 })().catch(error=>{failed=true;logError(error);print('Stage: '+stage)}).finally(()=>{activity?.close();tasks?.close();catalog?.close();useNativeI18n();gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
