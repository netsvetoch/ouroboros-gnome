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
const text=panel=>all(panel.widget,w=>w instanceof Gtk.Label).map(w=>w.label).join('\n');
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.WorkGapTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1000,default_height:900});win.present();const gateway=new Gateway(ARGV[1],'fixture-secret'),state=new WorkState(gateway);
 const full=new WorkPanel(win,state),compact=new WorkPanel(win,state,undefined,true);compact.setRoom(1);compact.widget.expanded=true;const body=new Gtk.Box({orientation:Gtk.Orientation.VERTICAL});body.append(compact.widget);body.append(full.widget);win.set_content(body);
 let stage='real projection failure';
 (async()=>{
  await gateway.json('POST','/fixture/work-gap',{fail:true});state.setConnected(true);await state.refresh();
  check(state.loaded&&!state.complete&&state.gaps.some(gap=>gap.reason==='answer_upkeep_unavailable'),'real projection failure did not reach WorkState');
  check(!state.list().length&&compact.widget.visible&&text(compact).includes('answer_upkeep_unavailable')&&text(full).includes('Не удалось прочитать ожидающую доставку ответов.'),'empty partial census hid gap or omitted diagnostics: '+JSON.stringify({works:state.list(),visible:compact.widget.visible,compact:text(compact),full:text(full)}));
  check(!text(compact).includes('Нет активной работы.'),'partial census falsely declared no work');
  stage='healthy recovery with real authority';await gateway.json('POST','/fixture/work-gap',{fail:false});
  check((await gateway.json('POST','/api/tasks',{task_id:'gap-work',description:'Gap work',chat_id:1,source:'web'})).ok===true,'task admission failed');await state.refresh();
  check(state.complete&&!state.gaps.length&&!state.gapsUnavailable&&state.list().length===1,'healthy summary did not clear prior gap');
  const work=state.list()[0],controls=state.controls(work);check(controls.some(control=>control.action==='pause'),'healthy work lost controls');
  const healthy=await gateway.json('GET','/api/state'),privateId='private-work-gap <&> Ω '+ 'x'.repeat(1024);
  stage='detail gaps preserve authoritative completeness';state.observe({...healthy,works_gaps:[{reason:'resume_attempt_unavailable',task_id:privateId},{reason:'future-gap-reason',extra:{future:true}}]},GLib.get_monotonic_time());
  check(state.complete&&state.controls(state.list()[0]).length===controls.length&&text(full).includes(privateId)&&text(full).includes('future-gap-reason'),'detail gap suppressed healthy authority or lost raw metadata');
  const detail=all(full.widget,w=>w instanceof Gtk.Label&&w.label.includes(privateId))[0];check(!detail.use_markup&&detail.measure(Gtk.Orientation.HORIZONTAL,-1)[0]<=640,'literal task identity broke markup/geometry');
  stage='malformed diagnostics keep previous reasons';const snapshot=JSON.stringify(state.gaps);
  for(const bad of [null,{},[null],[{}],[{reason:2}],[{reason:''}],[{reason:'x',task_id:{}}]]){
   state.observe({...healthy,works_gaps:bad},GLib.get_monotonic_time());
   check(state.gapsUnavailable&&JSON.stringify(state.gaps)===snapshot&&text(full).includes('Причины пробелов сводки недоступны.')&&text(full).includes(privateId),'bad gaps erased diagnostics');
   check(state.complete&&state.controls(state.list()[0]).length===controls.length,'display diagnostics changed control authority');
  }
  stage='old snapshots and optional compatibility';const now=GLib.get_monotonic_time();state.observe({...healthy,works_gaps:[{reason:'future-gap-reason'}]},now);
  state.observe({...healthy,works_gaps:[]},now-1);check(state.gaps.length===1,'old response cleared current gap');
  const legacy={...healthy};delete legacy.works_gaps;state.observe(legacy,GLib.get_monotonic_time());check(!state.gaps.length&&!state.gapsUnavailable&&state.complete,'optional legacy field absence rejected');
  stage='incomplete empty summary stays visible';state.observe({...healthy,works:[],rooms:{},works_complete:false,works_gaps:[]},GLib.get_monotonic_time());
  check(compact.widget.visible&&!text(compact).includes('Нет активной работы.'),'empty partial compact panel hidden or invented idle');
  stage='disconnect retains diagnostics without control authority';state.observe({...healthy,works_gaps:[{reason:'episode_record_unavailable',task_id:'gap-work'}]},GLib.get_monotonic_time());state.setConnected(false);
  check(state.gapsUnavailable&&state.gaps[0].task_id==='gap-work'&&!state.complete&&state.controls(state.list()[0]).length===0&&text(full).includes('могут быть устаревшими'),'disconnect lost gap or retained writable authority');
  const frozen=text(full);full.close();state.observe({...healthy,works_gaps:[]},GLib.get_monotonic_time());check(text(full)===frozen,'closed panel retained observer');
  const facts=await gateway.json('GET','/fixture/facts');check(!facts.calls.length&&facts.chat_bytes===0,'gap viewer sent work controls or chat');
  print('OK: real work_projection answer-upkeep read failure reaches native WorkState/full and compact WorkPanel, empty partial remains visible, actual healthy recovery and pause authority; detailed gaps preserve server completeness, malformed cache/stale diagnostics, future/optional fields, stale read exclusion, literal long task identity, disconnect control revocation and close cleanup; no worker/model execution');
 })().catch(error=>{failed=true;logError(error);print('Stage: '+stage)}).finally(()=>{full.close();compact.close();state.close();gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
