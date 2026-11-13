import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {Cards}=await import(ARGV[0]+'cards.js');
const {frameLedger}=await import(ARGV[0]+'frame-ledger.js');
const {gatewayStatePath,readGatewayState}=await import(ARGV[0]+'gateway-state.js');
const check=(v,m)=>{if(!v)throw new Error(m)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,m){for(let i=0;i<900;i++){if(await fn())return;await wait(20)}throw new Error(m)}
const phase=ARGV[3],app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.CardAppRecoveryTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1000,default_height:850});win.present();const gateway=new Gateway(ARGV[1],'fixture-secret'),cards=new Cards(win,gateway);let live;const lines=[];
 const facts=()=>gateway.json('GET','/fixture/facts'),state=()=>readGatewayState(gatewayStatePath(gateway.base,'widget-launches'));
 const draft={append:line=>{lines.push(line);return false},focus:()=>{throw new Error('unexpected draft focus')}};
 const boots=()=>lines.filter(line=>line.startsWith('From «App»: boot ')).map(line=>JSON.parse(line.slice('From «App»: boot '.length)));
 (async()=>{
  const f=await facts(),identity=f.app,key='app:'+identity.card_id,stateKey=key+':'+identity.app.sha256;
  const show=async()=>{cards.show(identity,'',draft);live=cards.dialogs.get(identity.card_id);await until(()=>live.appView,'native app view did not load');return live.appView};
  const requests=async()=> (await facts()).audit.filter(r=>r.path.endsWith('/app')).length;
  if(phase==='crash'){
   const view=await show();await until(()=>view.run?.ledgerEntry,'real app did not begin');check(state().starting[key]===identity.app.sha256,'app start marker not durable');print('OK: SIGKILL own GJS process during actual Cards/CardApp start with durable SHA marker');Gio.Subprocess.new(['/bin/sh','-c','kill -KILL "$PPID"'],Gio.SubprocessFlags.NONE);await new Promise(()=>{});
  }
  if(phase==='recover'){
   check(state().starting[key]===identity.app.sha256,'missing interrupted app marker');cards.appStates.set(stateKey,JSON.stringify({mount:7,text:'Prepared cached state <&>'}));cards.appStates.set('app:unrelated:hash',JSON.stringify({keep:true}));const before=await requests(),view=await show(),ledger=frameLedger(gateway);await until(()=>!ledger.reporting,'hold report did not finish');check(!view.run&&view.status.label.includes('Предыдущий запуск приложения прервался'),'held app started automatically or facade absent');check((await requests())===before&&boots().length===0,'held app fetched/executed bytes');check(cards.appStates.has(stateKey),'facade cleared cache before owner action');
   const facts1=await facts(),rows=facts1.hold_frames.filter(r=>r.system_type==='ui_hold');check(rows.length===1&&rows[0].chat_id===f.publication.chat_id&&rows[0].content.includes('card «App»'),'app hold not routed to publication room');const project=(await gateway.json('GET','/api/chat/history?chat_id='+f.publication.chat_id)).messages.filter(r=>r.system_type==='ui_hold'),main=(await gateway.json('GET','/api/chat/history?chat_id=1')).messages.filter(r=>r.system_type==='ui_hold');check(project.length===1&&project[0].role==='system'&&main.length===0,'hold polluted Main or missing canonical project row');check(!state().pending[key]&&state().holding[key]===identity.app.sha256,'delivery acknowledgement released hold or pending not cleared');
   view.toggle.emit('clicked');await until(()=>boots().length===1,'manual open did not execute HTML');check(boots()[0].mount===1&&boots()[0].before===null&&JSON.parse(cards.appStates.get('app:unrelated:hash')).keep,'held manual open did not clear only matching cached state');await until(()=>!state().starting[key],'app start did not settle');check(!state().holding[key],'manual open kept hold');live.close();await until(()=>!cards.dialogs.has(identity.card_id),'app dialog did not close');const remount=await show();await until(()=>boots().length===2,'ordinary remount did not execute');check(boots()[1].mount===2&&boots()[1].before==='Состояние <&> 😀','ordinary remount discarded confirmed session state');remount.toggle.emit('clicked');check(!remount.run&&state().stopped.includes('card:'+identity.card_id),'owner close not durable');
  }else if(phase==='verify'){
   const before=await requests(),view=await show();await wait(150);check(!view.run&&(await requests())===before,'owner close auto-started after process restart');const reports=(await facts()).audit.filter(r=>r.path==='/api/ui/holds');check(reports.length===1,'acknowledged app hold reported again');view.toggle.emit('clicked');await until(()=>boots().length===1,'owner reopen did not start');check(boots()[0].mount===1&&boots()[0].before===null,'state map unexpectedly survived new process');await until(()=>!state().starting[key],'reopened app did not settle');check(!state().stopped.includes('card:'+identity.card_id),'explicit open kept owner stop');
  }else throw new Error('unknown phase '+phase);
  print('OK: '+phase+' verifies native CardApp facade/manual cache reset, canonical publication-room hold isolation, ordinary remount state and owner close/reopen across independent processes; prepared cache is scoped test data, no models');
 })().catch(error=>{failed=true;logError(error);print('Phase: '+phase);print('App status: '+live?.appView?.status?.label)}).finally(()=>{cards.close();gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
