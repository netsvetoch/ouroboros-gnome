import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {TasksPage}=await import(ARGV[0]+'tasks.js');
const {WorkState}=await import(ARGV[0]+'work-state.js');
const check=(v,m)=>{if(!v)throw new Error(m)};
const wait=ms=>new Promise(r=>GLib.timeout_add(0,ms,()=>{r();return GLib.SOURCE_REMOVE}));
async function until(fn,m){for(let i=0;i<600;i++){if(await fn())return;await wait(20)}throw new Error(m)}
function all(w,p){const out=p(w)?[w]:[];for(let c=w.get_first_child?.();c;c=c.get_next_sibling())out.push(...all(c,p));return out}
const buttons=w=>all(w,x=>x instanceof Gtk.Button),find=(w,name)=>buttons(w).find(x=>x.label===name);
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.TaskLineageTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{const win=new Adw.ApplicationWindow({application:app,default_width:1000,default_height:900}),gateway=new Gateway(ARGV[1],'fixture-secret');win.present();const pages=[];let work,stage='seed root';
 const patch=task=>gateway.json('POST','/fixture/receipt',{rules:[{task_id:'lineage-gate',action:'detail',patch:{status:'running',metadata:{},root_task_id:null,parent_task_id:null,delegation_role:null,original_task_id:null,timeout_retry_from:null,...task}}]});
 const facts=()=>gateway.json('GET','/fixture/facts');
 (async()=>{
  check((await gateway.json('POST','/api/tasks',{task_id:'lineage-gate',description:'Inert lineage gate',chat_id:1,source:'web'})).ok===true,'root seed refused');
  const [,bytes]=Gio.File.new_for_path(ARGV[2]+'/lineage-cases.json').load_contents(null),cases=JSON.parse(new TextDecoder().decode(bytes));
  const page=new TasksPage(win,gateway,()=>({name:'Main',chatId:1}),()=>{});pages.push(page);win.set_content(page.widget);let detail,oldPause,oldHurry;
  for(const item of cases){stage=item.name;await patch(item.task);if(!detail){page.show('lineage-gate');detail=page.openDetails.get('lineage-gate');await until(()=>detail.task,'detail absent')}else await detail.refresh();
   const captions=buttons(detail.controls).map(b=>b.label);check(captions.includes('Остановить')&&captions.includes('Завершить с частичным результатом'),'lineage removed subtree stop/wrap-up '+stage);
   check(captions.includes('Пауза')===item.root&&captions.includes('Ускорить')===item.root,'legacy root controls disagree with primary lineage '+stage+': '+JSON.stringify(captions));
   if(stage==='root'){oldPause=find(detail.controls,'Пауза');oldHurry=find(detail.controls,'Ускорить')}
   if(stage==='child'){await gateway.json('POST','/fixture/receipt',{rules:Array.from({length:3},()=>({task_id:'lineage-gate',action:'detail',patch:item.task}))});const n=(await facts()).calls.length;for(const stale of [oldPause,oldHurry]){stale.emit('clicked');await until(()=>!detail.actionPending,'retired root callback did not finish')}await detail.refresh();check((await facts()).calls.length===n,'retired root controls dispatched for child')}
  }
  stage='pure predicate parity and unreadable relevant fields';const {rootTaskAttempt}=await import(ARGV[0]+'task-lineage.js');for(const item of cases)check(rootTaskAttempt(item.task,'lineage-gate')===item.root,'predicate differs '+item.name);
  for(const task of [{parent_task_id:[]},{root_task_id:{}},{delegation_role:42},{root_task_id:'other',delegation_role:'root',original_task_id:[],timeout_retry_from:[]}])check(!rootTaskAttempt(task,'lineage-gate'),'unreadable lineage granted root controls');
  check((await facts()).calls.length===0,'read-only lineage cases invoked controls');
  stage='retained unknown root requests cannot bypass new child identity';
  const child={status:'running',metadata:{},root_task_id:'parent',parent_task_id:'parent'};await gateway.json('POST','/fixture/receipt',{rules:[{task_id:'lineage-gate',action:'hurry',status:503,body:{error:'Unknown hurry receipt'}},{task_id:'lineage-gate',action:'detail',patch:child}]});
  await detail.workActions.run(win,{action:'hurry',target:'lineage-gate'},'',()=>true);await detail.refresh();detail.renderControls();const retry=find(detail.controls,'Повторить запрос · Ускорить');check(retry&&!retry.sensitive,'unknown root hurry retry enabled for child');const n=(await facts()).calls.length;retry.emit('clicked');await wait(40);check((await facts()).calls.length===n,'unknown root request replayed with changed lineage');
  stage='canonical work projection remains authoritative';work=new WorkState(gateway);work.setConnected(true);await work.refresh();const current=new TasksPage(win,gateway,()=>({name:'Main',chatId:1}),()=>{},undefined,work);pages.push(current);await patch(child);current.show('lineage-gate');const active=current.openDetails.get('lineage-gate');await until(()=>active.task,'projected detail absent');check(find(active.controls,'Пауза'),'local fallback lineage overrode actual root work projection');
  print('OK: legacy native Pause/Hurry match actual resolve_task_lineage for canonical/metadata parents, explicit empty/null and timeout retry markers; malformed relevant fields fail closed, stale controls and retained unknown Hurry cannot dispatch for a child; Stop/Wrap up remain subtree actions, primary WorkState authority retained; real task HTTP with controlled lineage projections, inert queue/no model');
 })().catch(e=>{failed=true;logError(e);print('Stage '+stage)}).finally(()=>{for(const page of pages)page.close();work?.close();gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
