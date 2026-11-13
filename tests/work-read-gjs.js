import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {WorkState}=await import(ARGV[0]+'work-state.js');
const {WorkPanel}=await import(ARGV[0]+'work-panel.js');
const check=(value,message)=>{if(!value)throw new Error(message)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,message){for(let i=0;i<700;i++){if(await fn())return;await wait(20)}throw new Error(message)}
function all(widget,predicate){let result=predicate(widget)?[widget]:[];for(let child=widget.get_first_child?.();child;child=child.get_next_sibling())result.push(...all(child,predicate));return result}
const text=root=>all(root,w=>w instanceof Gtk.Label).map(w=>w.label).join('\n');
const clone=value=>JSON.parse(JSON.stringify(value));
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.WorkReadTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1000,default_height:900});win.present();const gateway=new Gateway(ARGV[1],'fixture-secret'),state=new WorkState(gateway);
 const full=new WorkPanel(win,state),compact=new WorkPanel(win,state,undefined,true);compact.setRoom(1);compact.widget.expanded=true;const root=new Gtk.Box({orientation:Gtk.Orientation.VERTICAL});root.append(compact.widget);root.append(full.widget);win.set_content(root);let stage='real work authority';
 const fault=body=>gateway.json('POST','/fixture/receipt',{rules:[{task_id:'',action:'state',body}]}),facts=()=>gateway.json('GET','/fixture/facts');
 (async()=>{
  for(const task_id of ['work-read-first','work-read-second'])check((await gateway.json('POST','/api/tasks',{task_id,description:'Read fixture '+task_id,chat_id:1,source:'web'})).ok===true,'admission failed');
  state.setConnected(true);await state.refresh();check(state.complete&&state.list().length===2&&state.forTask('work-read-first').length,'actual controls not loaded');
  const healthy=await gateway.json('GET','/api/state'),ids=state.list().map(work=>work.work_id),original=state.list()[0];
  const expand=()=>{for(const widget of all(full.widget,w=>w instanceof Gtk.Expander))widget.expanded=true};expand();
  const stalePause=all(full.widget,w=>w instanceof Gtk.Button&&w.label==='Пауза')[0];check(stalePause,'real Pause button missing');
  const modify=(path,value)=>{const body=clone(healthy);let at=body;for(const key of path.slice(0,-1))at=at[key]??={};at[path.at(-1)]=value;return body};
  const invalid=[null,[],{...healthy,works:[null]}, {...healthy,works:[healthy.works[0],healthy.works[0]]},...[
   [['works_complete'],'true'],[['supervisor_ready'],'true'],[['works',0,'work_id'],{}],[['works',0,'name'],{}],[['works',0,'confirmed'],'true'],[['works',0,'room'],{}],
   [['works',0,'episode'],[]],[['works',0,'episode','live'],'true'],[['works',0,'focus','text'],{}],
   [['works',0,'because'],{}],[['works',0,'because'],[{text:'reason',wake:{}}]],[['works',0,'because'],[{by:{actor:[]}}]],
   [['works',0,'tails'],[null]],[['works',0,'turn'],[{kind:42}]],[['works',0,'members','ids'],[{}]],
   [['works',0,'members','states'],{member:null}],[['works',0,'members','states'],{member:{last_resume:{by:[]}}}],
   [['works',0,'controls'],[null]],[['works',0,'controls'],[{action:'pause',target:{}}]],[['works',0,'controls'],[{action:'pause',target:'work-read-first',scope:[]}]],
   [['rooms'],[]],[['rooms'],{'1':{confirmed:'true'}}],[['active_chat_activities'],[null]],
   [['active_chat_activities'],[{activity_id:'work-read-first',task_attempt:{}}]],[['active_chat_activities'],[{activity_id:'work-read-first',task_attempt:0}]],
   [['active_chat_activities'],[{activity_id:'work-read-first'},{activity_id:'work-read-first'}]]
  ].map(([path,value])=>modify(path,value))];
  stage='malformed state revokes commands without erasing records';
  for(const body of invalid){await fault(body);check(!await state.refresh(),'invalid state accepted');
   check(state.readUnavailable&&!state.complete&&!state.legacy&&state.list().map(work=>work.work_id).join()===ids.join()&&state.list().every(work=>work.confirmed===false)&&!state.forTask('work-read-first').length,'bad state erased cache or left actions');
   check(compact.widget.visible&&text(root).includes('действия отключены.')&&!text(compact.widget).includes('Нет активной работы'),'bad state hidden or declared idle');
   check(await state.refresh()&&state.complete&&state.forTask('work-read-first').length,'valid reread did not restore authority');
  }
  check(!state.controls(original).length,'detached old work object kept controls after reread');
  stage='stale action must pass fresh structural read';await fault({...healthy,works:[null]});stalePause.emit('clicked');
  await until(()=>state.readUnavailable&&text(full.widget).includes('Шлюз не подтвердил актуальные действия.'),'old Pause did not recheck bad snapshot');check(!(await facts()).calls.length,'stale control sent task action');await state.refresh();
  stage='minimal unknown work and missing room proof';for(const work of [{work_id:'minimal',room:1,controls:[{action:'pause',target:'work-read-first'}]}, {work_id:'minimal'}]){
   state.observe({supervisor_ready:true,works_complete:true,works:[work],rooms:{}},GLib.get_monotonic_time());check(!state.readUnavailable&&!state.forTask('work-read-first').length&&state.room(1).confirmed===false,'missing confirmation/room became permission or idle');
  }
  stage='future enums and independent diagnostics';const future=clone(healthy);future.works[0].activity='constructor';future.works[0].because=[{text:'Future reason <&>',by:{actor:'constructor',text:'literal'}}];future.works[0].controls.push({action:'future-action',target:'future-target',scope:'future-scope'});future.works_gaps=[{reason:'constructor'}];future.extra={future:true};
  state.observe(future,GLib.get_monotonic_time());expand();check(state.complete&&!state.readUnavailable&&state.forTask('work-read-first').length&&!text(root).includes('function Object'),'future fields rejected or prototype rendered');
  future.works[0].last_resume={at:{toString:'legacy timestamp'},by:{actor:'host'},text:'Legacy refusal time remains unknown'};
  state.observe(clone(future),GLib.get_monotonic_time());expand();check(state.complete&&text(root).includes('Legacy refusal time remains unknown'),'open timestamp field crashed or revoked valid state');
  stage='bad first read and legacy fallback cannot retain authority';const cold=new WorkState(gateway);cold.observe({...healthy,works:[null]},GLib.get_monotonic_time());check(cold.readUnavailable&&!cold.loaded&&!cold.legacy&&!cold.complete,'bad first created a known-empty or legacy census');cold.close();
  const legacy=new WorkState({base:gateway.base,json:async()=>({supervisor_ready:true})});legacy.setConnected(true);await legacy.refresh();check(legacy.legacy,'actual older envelope not supported');legacy.observe({...healthy,works:[null]},GLib.get_monotonic_time());check(!legacy.legacy&&legacy.readUnavailable,'bad modern response retained legacy actions');legacy.setConnected(false);check(!legacy.legacy,'disconnect retained legacy flag');legacy.close();
  const stateFacts=await facts();check(!stateFacts.calls.length&&stateFacts.chat_bytes===0,'state display executed controls or chat');
  print('OK: native WorkState and WorkPanel over real state/queue handlers; '+invalid.length+' malformed snapshots retain unconfirmed records and revoke controls, fresh recovery, no false idle, stale Pause preflight refuses without POST; explicit confirmation, room proof, detached objects, future/prototype data and legacy transition guards; no worker/model');
 })().catch(error=>{failed=true;logError(error);print('Stage: '+stage)}).finally(()=>{full.close();compact.close();state.close();gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
