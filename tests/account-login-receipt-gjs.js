import Gio from 'gi://Gio';import GLib from 'gi://GLib';import Gtk from 'gi://Gtk?version=4.0';import Adw from 'gi://Adw?version=1';import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js'),{AccountLogin}=await import(ARGV[0]+'accounts-login.js');
const check=(ok,m)=>{if(!ok)throw Error(m)},wait=ms=>new Promise(r=>GLib.timeout_add(0,ms,()=>{r();return GLib.SOURCE_REMOVE}));
async function until(fn,m){for(let i=0;i<1000;i++){if(await fn())return;await wait(10)}throw Error(m)}
function all(w,p){const a=p(w)?[w]:[];for(let c=w.get_first_child?.();c;c=c.get_next_sibling())a.push(...all(c,p));return a}
const button=(d,text)=>all(d.get_child(),w=>w instanceof Gtk.Button&&w.label===text)[0];
const labels=d=>all(d.get_child(),w=>w instanceof Gtk.Label).map(w=>w.label).join('\n');
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.LoginReceiptTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const gateway=new Gateway(ARGV[1],'fixture-secret'),win=new Adw.ApplicationWindow({application:app,default_width:1000,default_height:950});win.present();let dialog,stage='known create identity';
 const login=new AccountLogin(gateway,(d,parent)=>{dialog=d;d.present(parent??win)},()=>{});
 const control=(action,extra={})=>gateway.json('POST','/fixture/control',{action,...extra}),facts=()=>gateway.json('GET','/fixture/facts');
 const idle=()=>until(()=>!login.busy&&!login.reading,'login operation did not settle');
 const present=Adw.AlertDialog.prototype.present;Adw.AlertDialog.prototype.present=function(parent){present.call(this,parent);GLib.idle_add(0,()=>{this.emit('response','ok');this.close();return GLib.SOURCE_REMOVE})};
 const cancel=async()=>{button(dialog,'Отменить вход…').emit('clicked');await idle();check(!login.active(),'cancel did not release selected job')};
 (async()=>{
  for(const mode of ['missing','state','phase','foreign','device','attach']){
   stage=mode;login.show(win,'claude');await control('get-fail');await control('create-envelope',{mode});
   const before=Object.keys((await facts()).jobs).length;button(dialog,'Начать вход').emit('clicked');await idle();
   const state=await facts(),id=Object.keys(state.jobs).at(-1);
   check(Object.keys(state.jobs).length===before+1&&state.jobs[id].state==='waiting_for_input','actual create was not accepted');
   check(login.attempt?.id===id&&login.active()&&!login.attempt.result,'accepted job identity was discarded or bad snapshot accepted: '+mode);
   check(!login.attempt.attach&&!button(dialog,'Начать вход').is_sensitive(),'malformed create enabled another login or attached unvalidated command');
   check(button(dialog,'Отменить вход…').visible&&button(dialog,'Перечитать').visible,'known job recovery controls hidden');
   check(!all(dialog.get_child(),w=>w instanceof Gtk.LinkButton).length&&!labels(dialog).includes('ABCD-EFGH'),'bad create exposed disclosure');
   const creates=state.audit.filter(r=>r.method==='POST'&&r.path==='/api/claudexor/login').length;
   button(dialog,'Начать вход').emit('clicked');await wait(40);check((await facts()).audit.filter(r=>r.method==='POST'&&r.path==='/api/claudexor/login').length===creates,'stale start replayed accepted create');
   if(mode==='phase'){const old=dialog,stale=button(old,'Начать вход');old.force_close();await until(()=>!login.dialog,'unconfirmed dialog did not close');login.show(win);await idle();check(login.attempt.id===id&&login.active()&&!login.attempt.result,'close/reopen lost known unconfirmed job');stale.emit('clicked');await wait(30);check((await facts()).audit.filter(r=>r.method==='POST'&&r.path==='/api/claudexor/login').length===creates,'closed create control replayed job')}
   if(mode==='missing'){
    await cancel();check((await facts()).jobs[id].state==='cancelled','known-id cancel did not reach actual job');
   }else{
    await control('get-clear');button(dialog,'Перечитать').emit('clicked');await idle();
    check(login.attempt.id===id&&login.attempt.result.job.state==='waiting_for_input'&&login.status.label==='','separate valid GET failed to recover known job');
    check(labels(dialog).includes('Исходный ответ создания')&&labels(dialog).includes('отдельным чтением'),'readback was presented as original create receipt');
    await cancel();
   }
   dialog.force_close();await wait(15);await control('get-clear');
  }
  stage='ordinary validated receipt';login.show(win,'claude');button(dialog,'Начать вход').emit('clicked');await idle();check(login.attempt.result.job.state==='waiting_for_input'&&!login.attempt.creationUnconfirmed,'normal create not confirmed');await cancel();dialog.force_close();
  const state=await facts();check(state.settings_unchanged&&state.wire.every(w=>w.authorized),'settings or daemon authentication changed');
  print('OK: actual gateway/HTTPX login creates retain canonical known job ID after missing/state/phase/foreign/device/attach receipt faults; no bad snapshot/disclosure, no replay, close/reopen custody and stale controls, recovery buttons, explicit DELETE before valid read, separate GET receipt provenance and normal create; daemon/CLI simulated, no provider authentication');
 })().catch(e=>{failed=true;logError(e);print('Stage: '+stage);print('Status: '+login.status?.label)}).finally(async()=>{await control('release-all').catch(()=>{});dialog?.force_close();Adw.AlertDialog.prototype.present=present;gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
