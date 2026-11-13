import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {RuntimeCommands}=await import(ARGV[0]+'commands.js');
const {EvolutionCampaign}=await import(ARGV[0]+'evolution-campaign.js');
const check=(x,m)=>{if(!x)throw new Error(m)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,m){for(let i=0;i<1200;i++){if(await fn())return;await wait(20)}throw new Error(m)}
function all(w,p){let out=p(w)?[w]:[];for(let c=w.get_first_child?.();c;c=c.get_next_sibling())out.push(...all(c,p));return out}
const text=w=>all(w,w=>w instanceof Gtk.Label).map(w=>w.get_text()).join('\n');
const button=(w,s)=>all(w,w=>w instanceof Gtk.Button&&w.label===s)[0];
const click=(w,s)=>{const b=button(w,s);check(b?.is_sensitive(),'button unavailable '+s);b.emit('clicked')};
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.CampaignTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1000,default_height:900});win.present();
 const gateway=new Gateway(ARGV[1],'fixture-secret'),observer=new Gateway(ARGV[1],'fixture-secret'),commands=new RuntimeCommands(win,gateway,()=>undefined),dialogs=[],opened=[];
 const facts=()=>observer.json('GET','/fixture/facts'),control=(action,extra={})=>observer.json('POST','/fixture/control',{action,...extra});let stage='readiness',view;
 const refresh=async()=>view.observe(await observer.json('GET','/fixture/state'),GLib.get_monotonic_time());view=new EvolutionCampaign(win,commands,refresh,id=>opened.push(id));win.set_content(view.widget);
 const present=Adw.AlertDialog.prototype.present;Adw.AlertDialog.prototype.present=function(p){dialogs.push(this);return present.call(this,p)};
 const disabled={runtime_mode:'advanced',supervisor_ready:true,evolution_enabled:false,evolution_state:{enabled:false,status:'disabled',owner_chat_bound:true,budget_remaining_usd:2.5}};
 const enabled=id=>({...disabled,evolution_enabled:true,evolution_state:{...disabled.evolution_state,enabled:true,status:'queued',cycle:3,campaign:{id,objective:'Goal <&>',progress_notes:'Retained progress <&>',cycles_done:2,absorbed_cycles_done:1},queued_task_id:'cycle-task'}});
 async function state(value){await control('state',{value});await refresh()}
 function ask(){click(view.widget,view.enabled()?'Изменить цель…':'Запустить кампанию…');return dialogs.at(-1)}
 function answer(d,goal,response='apply'){d.get_extra_child().text=goal;d.emit('response',response);d.emit('response',response);d.close()}
 async function idle(){await until(()=>!view.busy,'campaign command pending')}
 (async()=>{
  const f=await facts();commands.observeBoot(f.boot);await refresh();check(button(view.widget,'Запустить кампанию…').sensitive&&!button(view.widget,'Остановить кампанию').sensitive,'initial controls wrong');await state({...disabled,runtime_mode:'light'});check(!button(view.widget,'Запустить кампанию…').sensitive,'light allowed start');await state({...disabled,supervisor_ready:false});check(!button(view.widget,'Запустить кампанию…').sensitive,'unready supervisor allowed start');view.observe(null,GLib.get_monotonic_time());check(!view.start.sensitive&&text(view.widget).includes('Показано последнее состояние'),'malformed state enabled start/erased last known');await state({...disabled,evolution_state:{enabled:null}});check(!view.start.sensitive,'unknown enable state allowed start');await state(disabled);
  stage='closed objective response cannot launch or clear newer dialog';let d=ask();d.force_close();const old=d;d=ask();old.emit('closed');check(view.objectiveDialog===d,'old closed erased new dialog');old.emit('response','apply');await wait(20);check(!(await facts()).admitted.length,'closed objective sent command');answer(d,'  Improve <&> 🔧  ');await idle();let a=await facts();check(a.admitted.length===1&&a.admitted[0].cmd==='/evolve on Improve <&> 🔧'&&a.audit[0].body.if_boot===f.boot&&a.audit[0].body.client_surface.channel==='gnome'&&a.admitted[0].kwargs.task_metadata.client_surface.channel==='api_command','actual command/boot/surface admission wrong');check(view.startUntil&&!view.start.sensitive&&text(view.widget).includes('Ожидается подтверждение запуска'),'receipt claimed running or allowed duplicate start');
  stage='fresh execution observation and task/progress facts';await state(enabled('campaign-a'));check(!view.startUntil&&view.start.label==='Изменить цель…'&&text(view.widget).includes('Retained progress <&>')&&text(view.widget).includes('Применено циклов · 1'),'observed campaign not rendered');click(view.widget,'Задача в очереди · cycle-task');check(opened[0]==='cycle-task','queued task target wrong');
  stage='campaign change invalidates pending objective';d=ask();await state(enabled('campaign-b'));answer(d,'Must not apply old offer');await idle();check((await facts()).admitted.length===1&&text(view.widget).includes('Состояние изменилось'),'old campaign offer sent');d=ask();answer(d,'');await idle();check((await facts()).admitted.length===1,'blank running objective sent command');d=ask();answer(d,'New goal');await idle();check((await facts()).admitted.at(-1).cmd==='/evolve on New goal','objective edit command wrong');
  stage='one stop request and boot refusal is not unknown acceptance';click(view.widget,'Остановить кампанию');view.stop.emit('clicked');await idle();check((await facts()).admitted.filter(r=>r.cmd==='/evolve off').length===1,'stop duplicated');await state(disabled);commands.observeBoot('old-boot');d=ask();answer(d,'Rejected');await idle();a=await facts();check(a.audit.at(-1).status===409&&a.admitted.length===3&&!view.startUntil&&text(view.widget).includes('Команда отклонена'),'boot conflict admitted or retained unknown start');commands.observeBoot(f.boot);
  stage='lost accepted start has bounded readback window and no replay';await control('lost');d=ask();answer(d,'Lost receipt');await idle();a=await facts();let count=a.admitted.length;check(count===4&&view.startUntil&&!view.start.sensitive&&text(view.widget).includes('Результат команды неизвестен'),'lost receipt not retained');view.unavailable();await until(()=>!view.startUntil&&view.start.sensitive,'fresh post-window read did not release explicit start');check((await facts()).admitted.length===count,'uncertain command auto-replayed');
  stage='blank initial goal preserves autonomous choice';d=ask();answer(d,'');await idle();count++;check((await facts()).admitted.length===count&&(await facts()).admitted.at(-1).cmd==='/evolve on','empty initial objective changed command');await state(enabled('campaign-c'));
  stage='closed controller ignores late observations and detached actions';d=ask();const oldStart=view.start,oldStop=view.stop;view.close();view.observe(enabled('late'),GLib.get_monotonic_time());oldStart.emit('clicked');oldStop.emit('clicked');d.emit('response','apply');await wait(30);check(!view.start.sensitive&&!view.stop.sensitive&&(await facts()).admitted.length===count,'closed controller reopened command flow');
  print('OK: native evolution campaign with actual command handler/boot fencing/surface stamp and bridge admission; controlled execution snapshots, readiness/unknown guards, abandoned/duplicate objective responses, stale campaign ID, exact on/off, queued task facts, lost start window readback without replay and disposal guards; no campaign execution/model work');
 })().catch(e=>{failed=true;logError(e);print('Stage: '+stage);print(text(view.widget))}).finally(()=>{view.close();commands.close();gateway.close();observer.close();Adw.AlertDialog.prototype.present=present;win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
