import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {WidgetView}=await import(ARGV[0]+'widget-view.js');
const {frameLedger}=await import(ARGV[0]+'frame-ledger.js');
const {gatewayStatePath,readGatewayState}=await import(ARGV[0]+'gateway-state.js');
const check=(v,m)=>{if(!v)throw new Error(m)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,m){for(let i=0;i<900;i++){if(await fn())return;await wait(20)}throw new Error(m)}
const phase=ARGV[3],app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.FrameRecoveryTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:950,default_height:850});win.present();const gateway=new Gateway(ARGV[1],'fixture-widget-password');let widget;const path=gatewayStatePath(gateway.base,'widget-launches'),state=()=>readGatewayState(path),facts=()=>gateway.json('GET','/fixture/facts');
 const control=holds=>gateway.json('POST','/fixture/control',{action:'board-fault',fault:{holds}});
 const reports=async()=> (await facts()).audit.filter(r=>r.path==='/api/ui/holds');
 const rows=async()=> (await facts()).hold_frames.filter(f=>f.system_type==='ui_hold');
 (async()=>{
  const tab=(await gateway.json('GET','/api/widgets')).ui_tabs.find(t=>t.tab_id==='classic'),key='widget:esm_read_files:classic';
  const mount=()=>{widget=new WidgetView(gateway,tab);win.set_content(widget.widget);widget.setActive(true);return widget.framed};
  if(phase==='crash'){
   await control('empty');const launch=mount();await until(()=>launch.started,'real start did not begin');check(state().starting[key]===tab.revision,'start marker not durable');
   print('OK: crash stage SIGKILLs its own GJS process after durable real WidgetLaunch marker; no close/settled cleanup');Gio.Subprocess.new(['/bin/sh','-c','kill -KILL "$PPID"'],Gio.SubprocessFlags.NONE);await new Promise(()=>{});
  }
  if(phase==='recover'){
   check(state().starting[key]===tab.revision,'previous process did not leave marker');const launch=mount(),ledger=frameLedger(gateway);await until(()=>!ledger.reporting,'initial report did not finish');check(!launch.sandbox&&launch.status.label.includes('Предыдущий запуск'),'held launch started automatically or caption missing');check(state().holding[key]===tab.revision&&state().pending[key]===tab.revision&&!state().starting[key],'malformed acknowledgement lost recovery facts');const first=await reports();check(first.length===1&&first[0].response.ok===true&&first[0].response.named===1,'actual hold writer did not name item');check((await rows()).length===1,'actual canonical writer/broadcast absent');
   await control('badnamed');ledger.report();await until(()=>!ledger.reporting,'bad-named report stalled');check(state().pending[key]===tab.revision,'non-numeric named discarded pending hold');
   await control('lost');ledger.report();await until(()=>!ledger.reporting,'lost acknowledgement stalled');check(state().pending[key]===tab.revision&&(await rows()).length===1,'lost reply removed pending or duplicated row');
   await control('');ledger.report();await until(()=>!ledger.reporting&&!Object.keys(state().pending).length,'valid dedupe receipt did not clear pending');check((await rows()).length===1&&(await reports()).at(-1).response.named===0,'retry duplicated canonical hold row');const count=(await reports()).length;await wait(150);check((await reports()).length===count&&!launch.sandbox,'hold retry loop or automatic launch');check((await rows())[0].content.includes('classic widget of esm_read_files'),'hold text lost exact item');const history=(await gateway.json('GET','/api/chat/history?chat_id=1')).messages.filter(m=>m.system_type==='ui_hold');check(history.length===1&&history[0].role==='system','canonical history did not retain actual hold row');
  }else if(phase==='verify'){
   const count=(await reports()).length,launch=mount();await wait(200);check(!launch.sandbox&&(await reports()).length===count,'confirmed hold re-reported or auto-started in third process');launch.toggle.emit('clicked');await until(()=>launch.sandbox?.loaded,'explicit start not permitted');await until(()=>!state().starting[key],'settled start marker not removed');check(!state().holding[key],'manual release kept hold');const sandbox=launch.sandbox;widget.close();await sandbox.done;check(!state().starting[key],'ordinary close created interrupted marker');
  }else if(phase==='batch-seed'){
   const ledger=frameLedger(gateway);for(let i=0;i<65;i++)ledger.begin('widget:finite:'+String(i).padStart(2,'0'),'fixture-revision');check(Object.keys(state().starting).length===65,'finite batch markers not written');print('OK: seeded 65 finite ledger starts for separate batch-recovery process; not 65 executed widgets');return;
  }else if(phase==='batch-recover'){
   const ledger=frameLedger(gateway);await until(()=>!ledger.reporting&&!Object.keys(state().pending).length,'reporter did not drain beyond first batch');const sent=(await reports()).filter(r=>r.body?.holds?.some(h=>h.key.startsWith('widget:finite:')));check(sent.length===2&&sent[0].body.holds.length===50&&sent[1].body.holds.length===15,'batch shape/count wrong');check(sent.every(r=>r.response.ok===true&&r.response.named===r.body.holds.length),'real batch handler did not confirm all finite holds');check(Object.keys(state().holding).length===65&&(await rows()).length===3,'batch acknowledgement released held code or lost rows');
  }else throw new Error('unknown recovery phase '+phase);
  print('OK: '+phase+' verifies independent-process recovery, strict holds receipt/dedupe, facade/manual release or complete bounded batch delivery through real writer');
 })().catch(error=>{failed=true;logError(error);print('Phase: '+phase)}).finally(()=>{widget?.close();gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
