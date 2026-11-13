import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {WidgetView}=await import(ARGV[0]+'widget-view.js');
const check=(v,m)=>{if(!v)throw new Error(m)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,m){for(let i=0;i<700;i++){if(await fn())return;await wait(20)}throw new Error(m)}
function all(w,p){let a=p(w)?[w]:[];for(let c=w.get_first_child?.();c;c=c.get_next_sibling())a.push(...all(c,p));return a}
const words=w=>all(w,c=>c instanceof Gtk.Label).map(c=>c.label).join('\n');
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.WidgetSessionTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1000,default_height:950});win.present();const gateway=new Gateway(ARGV[1],''),cancel=new Gio.Cancellable();let widget,socket,stage='registered declarative view';const snapshots=[];
 const facts=()=>gateway.json('GET','/api/extensions/native_session/facts'),control=v=>gateway.json('POST','mode' in v?'/api/extensions/native_session/control':'/fixture/control',v);
 const value=target=>widget.session.values.get(target);
 const press=caption=>{const b=all(widget.widget,c=>c instanceof Gtk.Button&&c.label===caption)[0];check(b?.is_sensitive(),'missing enabled button '+caption);b.emit('clicked');return b};
 (async()=>{
  const tabs=(await gateway.json('GET','/api/widgets')).ui_tabs;check(tabs.length===1,'registered tab missing');widget=new WidgetView(gateway,tabs[0],{text:'Prefill <&>'});const scrolled=new Gtk.ScrolledWindow();scrolled.set_child(widget.widget);win.set_content(scrolled);widget.setActive(true);widget.session.observe('job_result',v=>snapshots.push(v));socket=await gateway.connect('/ws',cancel);socket.connect('message',(_s,t,b)=>{if(t===1)widget.frame(JSON.parse(new TextDecoder().decode(b.get_data())))});await until(async()=>(await gateway.json('GET','/fixture/facts')).peers===1,'WS absent');
  await until(()=>words(widget.widget).includes('Streamed <&>'),'actual SSE did not render');check((await facts()).streams===1,'duplicate SSE');
  stage='native form and explicit action body';check(all(widget.widget,c=>c instanceof Gtk.Entry&&c.text==='Prefill <&>').length===1,'input prefill lost');press('Отправить');await until(()=>value('form_result')?.status==='success','form failed');check(value('form_result').data.echo==='Prefill <&>'&&words(widget.widget).includes('Prefill <&>'),'form data not rendered');
  const button=press('Start job');button.emit('clicked');await until(async()=>Object.values((await facts()).ticks).includes(2),'job did not poll');check(value('job_result').data.progress_pct===60&&value('job_result').data.custom_pct===80,'multi-key progress regressed');
  await until(()=>value('job_result')?.status==='success','job did not finish');check(words(widget.widget).includes('Completed <&>'),'job result not rendered');let f=await facts();check(f.calls.length===2&&f.calls[1].literal==='Body <&>'&&f.calls[1].kind==='job','duplicate job or action body loss');
  stage='malformed status cannot succeed or continue polling';for(const mode of ['null','number','failed']){await control({mode});press('Start job');await until(()=>value('job_result')?.status==='error','invalid/failure not terminal: '+mode);const job=String((await facts()).calls.length);check((await facts()).ticks[job]===1,'invalid job status was retried');check(!snapshots.some(v=>v.data?.text==='FALSE SUCCESS'),'null status fell through to state')}
  await control({mode:'scalar'});press('Start job');await until(()=>value('job_result')?.status==='success','scalar result did not finish');check(value('job_result').data.result===0&&words(widget.widget).includes('Published status <&>'),'scalar result replaced published status payload');check([...widget.components].filter(v=>v.controls.length).length===2,'form/action views have no lifetime owner');
  stage='poll/subscription and inactive mount';press('Poll now');await until(()=>words(widget.widget).includes('Polled <&>'),'poll missing');await control({event:'WS <&>'});await until(()=>words(widget.widget).includes('WS <&>'),'subscription missing');widget.setActive(false);await until(async()=>(await facts()).disconnected>=1,'SSE not canceled on hide');const old=value('ws_result');await control({event:'Hidden'});await wait(80);check(value('ws_result')===old,'inactive subscription changed');
  widget.setActive(true);await until(async()=>(await facts()).streams===2,'SSE not resumed');await control({mode:'waiting'});press('Start job');await until(()=>value('job_result').data?.progress_pct===60,'new job progress not reset');widget.setActive(false);await wait(1100);const ticks=JSON.stringify((await facts()).ticks);await wait(1100);check(JSON.stringify((await facts()).ticks)===ticks,'hidden job kept polling');widget.setActive(true);await until(async()=>JSON.stringify((await facts()).ticks)!==ticks,'job did not resume');
  stage='close cancels readers and makes stale action inert';widget.close();const calls=(await facts()).calls.length;button.emit('clicked');await until(async()=>(await facts()).disconnected>=2,'close left stream active');await wait(1100);check((await facts()).calls.length===calls&&!widget.session.jobs.size&&!widget.session.requests.size&&!widget.components.size,'closed session retained work');
  print('OK: actual declared skill registration/HTTP dispatch and native WidgetView form/action/body/job/poll/SSE/WS; literal input prefill/results, duplicate action suppression, multiple progress keys monotonic, own null/non-string status rejected after one tick, failure terminal, hidden job pause/resume and SSE cancellation/reconnect, stale controls inert and owned views released; finite extension jobs, no model worker');
 })().catch(error=>{failed=true;logError(error);print('Stage: '+stage);if(widget)print(words(widget.widget))}).finally(()=>{widget?.close();socket?.close(1000,'done');cancel.cancel();gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
