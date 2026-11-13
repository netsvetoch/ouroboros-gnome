import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {showSkillProcesses}=await import(ARGV[0]+'skill-processes.js');
const check=(x,m)=>{if(!x)throw new Error(m)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,m){for(let i=0;i<1000;i++){if(await fn())return;await wait(20)}throw new Error(m)}
function all(w,p){let out=p(w)?[w]:[];for(let c=w.get_first_child?.();c;c=c.get_next_sibling())out.push(...all(c,p));return out}
const text=d=>all(d.get_child(),w=>w instanceof Gtk.Label).map(w=>w.get_text()).join('\n');
const button=(d,s)=>all(d.get_child(),w=>w instanceof Gtk.Button&&w.label===s)[0];
const click=(d,s)=>{const b=button(d,s);check(b?.is_sensitive(),'button unavailable '+s);b.emit('clicked')};
const rows=d=>all(d.get_child(),w=>w instanceof Adw.ExpanderRow);
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.ProcessTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1100,default_height:1000});win.present();
 const gateway=new Gateway(ARGV[1],'fixture-secret'),observer=new Gateway(ARGV[1],'fixture-secret'),dialogs=[],active=new Set(),reads=[];
 const json=gateway.json.bind(gateway);gateway.json=async(...args)=>{const r={cancel:args[5],done:false};reads.push(r);try{return await json(...args)}finally{r.done=true}};
 const facts=()=>observer.json('GET','/fixture/facts'),control=(action,extra={})=>observer.json('POST','/fixture/control',{action,...extra}),present=d=>{dialogs.push(d);active.add(d);d.connect('closed',()=>active.delete(d));d.present(parent)};
 let parent=new Adw.Dialog({title:'Skills owner',child:new Gtk.Box()});parent.present(win);let stage='actual companion snapshot';
 const open=skill=>{showSkillProcesses(gateway,present,skill,parent);return dialogs.at(-1)};
 async function idle(d){await until(()=>button(d,'Обновить процессы').sensitive&&!text(d).includes('Читаю список процессов…'),'process read pending')}
 async function reread(d){click(d,'Обновить процессы');await idle(d)}
 (async()=>{
  let d=open();await idle(d);let f=await facts();check(rows(d).length===3,'real companion snapshot missing');const alpha=rows(d).find(r=>r.title==='alpha · worker <&>');check(alpha&&alpha.subtitle.includes('Работает')&&alpha.subtitle.includes('PID '+f.snapshot['alpha:worker <&>'].pid)&&alpha.subtitle.includes('32123'),'native process fields missing');check(rows(d).find(r=>r.title==='beta · finished').subtitle.includes('код 7'),'actual exited process code missing');alpha.expanded=true;await reread(d);check(rows(d).includes(alpha)&&alpha.expanded,'timestamp-only refresh replaced/collapsed row');
  stage='local skill/name/PID/port search preserves expanded row';const search=all(d.get_child(),w=>w instanceof Gtk.SearchEntry)[0];for(const value of ['ALPHA','worker <&>',String(f.snapshot['alpha:worker <&>'].pid),'32123']){search.text=value;await until(()=>rows(d).length===1,'search did not filter '+value);check(rows(d)[0]===alpha,'local search rebuilt row')}search.text='absent';await until(()=>text(d).includes('По этому поиску процессов нет.')&&rows(d).length===0,'empty search wrong');search.text='';await until(()=>rows(d).length===3,'cleared search did not restore snapshot');check(rows(d).includes(alpha)&&alpha.expanded,'filter lost expanded state');
  stage='actual signal exit and retained stop uncertainty';await control('signal');await until(async()=>((await facts()).snapshot['gamma:signal']?.returncode===-15),'owned process did not exit by signal');await reread(d);check(rows(d).find(r=>r.title==='gamma · signal').subtitle.includes('сигналом · 15'),'actual signal exit missing');await control('retiring');await reread(d);let retiring=rows(d).find(r=>r.title==='alpha · worker <&>');check(retiring.expanded&&retiring.subtitle.includes('Остановка процесса не подтверждена')&&text(d).includes('Fixture stop pending <&>'),'retiring process presented as confirmed running');
  stage='failed and malformed snapshot retain last good rows';for(const mode of ['fail','malformed']){await control('fault',{mode});await reread(d);check(text(d).includes('Показан последний снимок')&&rows(d).length===3&&rows(d).includes(retiring),'failed/malformed read changed snapshot')}await control('fault',{mode:''});await reread(d);check(!text(d).includes('Не удалось обновить'),'recovery retained read error');
  stage='actual supervisor stop removes row; skill filter describes its own empty state';await control('stop-alpha');await reread(d);check(rows(d).length===2&&!rows(d).some(r=>r.title.startsWith('alpha')),'stopped process remained');const filtered=open('alpha');await idle(filtered);check(!rows(filtered).length&&text(filtered).includes('нет процессов выбранного навыка'),'empty skill filter claimed global empty snapshot');filtered.force_close();
  stage='closing owner cancels held read and stops polling';await control('hold');const before=(await facts()).audit.length;click(d,'Обновить процессы');await until(async()=>(await facts()).audit.length>before,'held process read absent');const held=reads.at(-1);parent.force_close();await until(()=>held.done,'parent close did not settle read before server release');check(held.cancel.is_cancelled(),'parent close did not cancel read');const count=(await facts()).audit.length;button(d,'Обновить процессы').emit('clicked');await wait(3300);check((await facts()).audit.length===count,'closed window read/poll continued');await control('release-all');
  for(const child of [...active])if(child.get_mapped())child.force_close();parent=new Adw.Dialog({title:'Skills owner reopened',child:new Gtk.Box()});parent.present(win);d=open();await idle(d);check(rows(d).length===2&&(await facts()).settings_unchanged&&(await facts()).audit.every(r=>r.method==='GET'),'reopen failed or client mutated server');
  print('OK: native companion monitor through actual CompanionSupervisor/start/snapshot/owned signal exit/stop and daemon endpoint; literal fields, local filters, timestamp/expanded-row preservation, retained stop uncertainty, atomic last-known snapshot, scope empty state and parent cancellation/poll cleanup; only inert owned children, declared port unbound, retiring state controlled and automatic monitor disabled');
 })().catch(e=>{failed=true;logError(e);print('Stage: '+stage);for(const d of active)print(text(d))}).finally(async()=>{await control('release-all').catch(()=>{});for(const d of [...active])if(d.get_mapped())d.force_close();if(parent.get_mapped())parent.force_close();gateway.close();observer.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
