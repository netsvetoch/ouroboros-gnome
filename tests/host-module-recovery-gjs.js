import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {UiContributions}=await import(ARGV[0]+'ui-contributions.js');
const {HostModules}=await import(ARGV[0]+'host-modules.js');
const {frameLedger}=await import(ARGV[0]+'frame-ledger.js');
const {gatewayStatePath,readGatewayState}=await import(ARGV[0]+'gateway-state.js');
const check=(v,m)=>{if(!v)throw new Error(m)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,m){for(let i=0;i<900;i++){if(await fn())return;await wait(20)}throw new Error(m)}
function buttons(w){const found=w instanceof Gtk.Button?[w]:[];for(let c=w.get_first_child?.();c;c=c.get_next_sibling())found.push(...buttons(c));return found}
const phase=ARGV[3],app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.HostRecoveryTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:800,default_height:600});win.present();
 const gateway=new Gateway(ARGV[1],'fixture-host-password'),catalog=new UiContributions(gateway,()=>{}),notices=[];
 let manager,module;
 const state=()=>readGatewayState(gatewayStatePath(gateway.base,'widget-launches'));
 const facts=()=>gateway.json('GET','/fixture/facts');
 const assets=f=>f.audit.filter(r=>r.path.startsWith('/api/extensions/')&&r.path.includes('/ui/')).length;
 const reports=f=>f.audit.filter(r=>r.path==='/api/ui/holds');
 (async()=>{
  await catalog.refresh();const item=catalog.hostEntries().find(i=>i.id==='client_voice');check(item,'reviewed module missing');const key='module:'+item.key;
  // Exercise the real manager with one actual catalog entry; unrelated intentional hang/fault fixtures are outside this recovery scenario.
  catalog.hostEntries=()=>[item];
  if(phase!=='crash'&&phase!=='verify')check(state().starting?.[key]===item.revision||state().holding?.[key]===item.revision,'previous process left no interrupted/held marker');
  const before=await facts();
  manager=new HostModules(gateway,catalog,{changed:()=>{},notice:t=>notices.push(t),insert:()=>true});win.set_content(manager.widget);manager.reconcile();module=manager.get(item);
  check(module,'real manager did not create module');
  if(phase==='crash'){
   await until(()=>module.status==='ready','actual module did not execute');
   check(notices.some(n=>n.includes('"phase":"mount"'))&&state().starting[key]===item.revision,'executed module has no durable unsettled revision marker');
   print('OK: SIGKILL own GJS process after real reviewed HostModule mount and before its durable start marker settles');
   Gio.Subprocess.new(['/bin/sh','-c','kill -KILL "$PPID"'],Gio.SubprocessFlags.NONE);await new Promise(()=>{});
  }
  const ledger=frameLedger(gateway);
  if(phase==='recover'||phase==='release'){
   await until(()=>!ledger.reporting,'hold delivery did not finish');await wait(100);
   check(module.status==='held'&&!module.started&&!module.provider&&notices.length===0,'interrupted module executed without owner release');
   const heldFacts=await facts();check(assets(heldFacts)===assets(before),'held module requested executable assets');
   check(!state().starting[key]&&state().holding[key]===item.revision&&!state().pending[key],'hold receipt lost facts or left unconfirmed delivery');
   const sent=reports(heldFacts);check(sent.length===1&&sent[0].status===200&&sent[0].body.holds.length===1&&sent[0].body.holds[0].key===key&&sent[0].body.holds[0].rev===item.revision,'actual hold writer did not receive exact module identity/revision once');
   const rows=heldFacts.hold_frames.filter(r=>r.system_type==='ui_hold');check(rows.length===1&&rows[0].role==='system'&&rows[0].content.includes('page code of native_actions'),'actual canonical hold broadcast missing');
   const history=(await gateway.json('GET','/api/chat/history?chat_id=1')).messages.filter(r=>r.system_type==='ui_hold');
   const project=(await gateway.json('GET','/api/chat/history?chat_id='+heldFacts.project.chat_id)).messages.filter(r=>r.system_type==='ui_hold');
   check(history.length===1&&project.length===0,'module hold missing from owner history or leaked into unrelated project');
   if(phase==='release'){
    const release=buttons(manager.widget).find(b=>b.label==='Запустить модуль');check(release,'native manual release absent');release.emit('clicked');
    await until(()=>module.status==='ready','native release did not mount');await until(()=>!state().starting[key],'released start did not settle');
    check(!state().holding[key]&&notices.some(n=>n.includes('"phase":"mount"'))&&(await module.call('voices'))[0].id==='test:voice','release failed to restore real provider');
    const count=assets(await facts());release.emit('clicked');await wait(80);check(assets(await facts())===count,'stale release restarted module');
   }
  }else if(phase==='verify'){
   await until(()=>module.status==='ready','ordinary new process did not auto-mount after confirmed release');
   await until(()=>!state().starting[key],'ordinary start did not settle');
   const final=await facts();check(reports(final).length===1&&final.hold_frames.filter(r=>r.system_type==='ui_hold').length===1&&!state().holding[key]&&!state().pending[key],'normal close/reopen created another recovery hold');
  }else throw new Error('unknown phase '+phase);
  await manager.close();check(module.status==='closed'&&!state().starting[key],'ordinary close retained module or interrupted marker');
  print('OK: '+phase+' verifies HostModule recovery across independent GJS processes, no held asset execution, exact revision report and canonical owner history, native manual release/stale control and ordinary reopen; no models or physical audio');
 })().catch(e=>{failed=true;logError(e);print('Phase '+phase+' module '+module?.status+' notices '+JSON.stringify(notices))}).finally(async()=>{if(manager)await manager.close();catalog.close();gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
