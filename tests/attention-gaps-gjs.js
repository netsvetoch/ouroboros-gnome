import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {WorkActions}=await import(ARGV[0]+'work-actions.js');
const {OwnerAttention}=await import(ARGV[0]+'owner-attention.js');
const {OwnerAttentionView}=await import(ARGV[0]+'owner-attention-view.js');
const {NativeI18n,useNativeI18n}=await import(ARGV[0]+'native-i18n.js');
const check=(v,m)=>{if(!v)throw new Error(m)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,m){for(let i=0;i<700;i++){if(await fn())return;await wait(20)}throw new Error(m)}
function all(w,p){let out=p(w)?[w]:[];for(let c=w.get_first_child?.();c;c=c.get_next_sibling())out.push(...all(c,p));return out}
const text=v=>all(v.widget.get_child(),w=>w instanceof Gtk.Label).map(w=>w.label).join('\n');
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.AttentionGapTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1000,default_height:900}),body=new Gtk.Box({orientation:Gtk.Orientation.VERTICAL});win.set_content(body);win.present();
 const gateway=new Gateway(ARGV[1],'fixture-secret'),actions=new WorkActions(gateway),state=new OwnerAttention(gateway,actions,()=>{}),views=[];let catalog,stage='actual malformed live wait';
 const view=(compact=false,task)=>{const v=new OwnerAttentionView(win,gateway,state,undefined,undefined,compact,task);views.push(v);body.append(v.widget);return v};
 let full,main,detail,other;
 const observe=s=>state.observe(s,GLib.get_monotonic_time());
 (async()=>{
  await gateway.json('POST','/api/ui/i18n/language',{language:'en'});catalog=new NativeI18n(gateway);useNativeI18n(catalog);await until(()=>catalog.language==='en','English unavailable');full=view();main=view(true);detail=view(false,'attention-gap-task');other=view(false,'other-task');main.setRoom(1);
  const setup=await gateway.json('POST','/fixture/attention-gap',{fail:true});state.setConnected(true);let broken=await gateway.json('GET','/api/state');observe(broken);
  check(broken.main_attention_complete===false&&broken.main_attention_gaps.some(g=>g.reason==='model_wait_action_unknown'),'real state did not publish malformed wait gap '+JSON.stringify(broken.main_attention_gaps));
  check(state.gaps.length===1&&!state.complete&&!state.gapsUnavailable&&state.waits().length===0,'gap became usable wait authority');
  for(const v of [full,main,detail])check(v.widget.visible&&text(v).includes('model_wait_action_unknown')&&text(v).includes('attention-gap-task')&&text(v).includes('Related model wait · main'),'native gap absent '+JSON.stringify({visible:v.widget.visible,text:text(v),gaps:state.gaps}));
  check(!text(other).includes('attention-gap-task'),'task scope leaked unrelated gap');const projectView=view(true),otherProject=view(true);projectView.setRoom(setup.chat_id);otherProject.setRoom(setup.chat_id+100);check(text(projectView).includes('attention-gap-task')&&!text(otherProject).includes('attention-gap-task'),'project scope leaked or lost gap');
  stage='actual repaired wait';await gateway.json('POST','/fixture/attention-gap',{fail:false});const healthy=await gateway.json('GET','/api/state');observe(healthy);
  check(state.complete&&!state.gaps.length&&!state.gapsUnavailable&&state.waits().some(w=>w.row.wait_id==='main'),'actual repaired wait did not recover');
  check(!text(full).includes('model_wait_action_unknown'),'cleared gap remained visible');
  const count=state.waits().length,privateId='private attention <&> Ω '+'x'.repeat(2048);
  stage='future diagnostic, completeness independence and literal IDs';observe({...healthy,main_attention_gaps:[{reason:'constructor',task_id:privateId,wait_id:'private wait <&>'}]});
  check(state.complete&&state.waits().length===count&&text(full).includes(privateId)&&text(full).includes('constructor'),'display diagnostic changed authority/lost future reason');
  check(!text(detail).includes(privateId),'task gap scope widened');
  for(const label of all(full.widget,w=>w instanceof Gtk.Label&&w.label.includes(privateId)))check(!label.use_markup&&label.measure(Gtk.Orientation.HORIZONTAL,-1)[0]<680,'literal gap broke markup/width');
  stage='atomic malformed diagnostic reads and old snapshots';const previous=JSON.stringify(state.gaps);
  for(const bad of [null,{},[null],[{}],[{reason:3}],[{reason:''}],[{reason:'x',task_id:{}}],[{reason:'x',wait_id:[]}]] ){
   observe({...healthy,main_attention_gaps:bad});check(state.gapsUnavailable&&JSON.stringify(state.gaps)===previous&&text(full).includes('Previous details may be stale.')&&state.complete&&state.waits().length===count,'bad diagnostic erased prior data or changed wait authority');
  }
  const now=GLib.get_monotonic_time();state.observe({...healthy,main_attention_gaps:[{reason:'future-gap'}]},now);state.observe({...healthy,main_attention_gaps:[]},now-1);check(state.gaps.length===1,'old response erased current gap');
  stage='locale and private source keys';observe({...healthy,main_attention_gaps:[{reason:'constructor',task_id:privateId}]});full.widget.expanded=true;
  const imported=await gateway.json('POST','/api/ui/i18n/import',{language:'qaa',entries:{'Model access and owner actions':{text:'QAA attention'},'Related task · {value}':{text:'QAA task · {value}'}}});
  await gateway.json('POST','/api/ui/i18n/language',{language:'qaa',profile:{direction:'rtl'}});catalog.frame({type:'ui_language_changed',language:'qaa'});catalog.frame({type:'ui_i18n_updated',language:'qaa',revision:imported.revision});
  await until(()=>full.widget.label==='QAA attention'&&text(full).includes('QAA task'),'live locale absent');check(full.widget.expanded&&full.widget.get_direction()===Gtk.TextDirection.RTL&&text(full).includes(privateId),'locale lost value/direction/expansion');
  await until(async()=>(await gateway.json('GET','/fixture/facts')).audit.some(r=>r.path==='/api/ui/i18n/missing'&&r.body),'actual missing reports absent');
  stage='legacy absence, empty incomplete visibility and disconnect';const legacy={...healthy};delete legacy.main_attention_gaps;observe(legacy);check(!state.gaps.length&&!state.gapsUnavailable,'legacy absence rejected');
  observe({...healthy,active_chat_activities:[],main_attention:[],main_attention_complete:false,main_attention_gaps:[]});check(main.widget.visible,'empty incomplete attention disappeared');
  observe({...healthy,main_attention_gaps:[{reason:'model_wait_action_unknown',task_id:'attention-gap-task',wait_id:'main'}]});state.setConnected(false);check(state.gapsUnavailable&&state.gaps.length===1&&!state.complete&&state.tasks().every(t=>!t.confirmed),'disconnect kept authority or lost diagnostics');
  const frozen=text(full),heading=full.widget.label;full.close();observe({...healthy,main_attention_gaps:[]});await gateway.json('POST','/api/ui/i18n/language',{language:'en'});catalog.frame({type:'ui_language_changed',language:'en'});await until(()=>catalog.language==='en','English reset absent');check(text(full)===frozen&&full.widget.label===heading,'closed view accepted state/locale');
  const facts=await gateway.json('GET','/fixture/facts');check(!facts.calls.length&&facts.chat_bytes===0,'diagnostic display sent work/chat');check(!facts.audit.some(r=>r.path==='/api/ui/i18n/missing'&&JSON.stringify(r.body).includes('private attention')),'private diagnostic became i18n key');
  print('OK: actual state/main_decisions malformed live model-wait revision publishes gap to native OwnerAttention views; real repair restores wait and clears gap; Main/project/exact-task scoping, no diagnostic authority, future/literal long IDs, atomic malformed/stale/legacy reads, incomplete empty visibility, disconnect, QAA/RTL/private keys and close ownership; no work controls, models or chat');
 })().catch(error=>{failed=true;logError(error);print('Stage: '+stage)}).finally(()=>{for(const v of views)v.close();state.close();catalog?.close();useNativeI18n();gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
