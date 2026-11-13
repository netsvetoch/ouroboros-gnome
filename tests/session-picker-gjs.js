import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {pickSubagentSession}=await import(ARGV[0]+'subagent-session.js');
const {sheet}=await import(ARGV[0]+'ui.js');
const check=(x,m)=>{if(!x)throw new Error(m)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,m){for(let i=0;i<650;i++){if(await fn())return;await wait(20)}throw new Error(m)}
function all(w,p){let out=p(w)?[w]:[];for(let c=w.get_first_child?.();c;c=c.get_next_sibling())out.push(...all(c,p));return out}
const texts=d=>all(d.get_child(),w=>w instanceof Gtk.Label).map(w=>w.get_text()).join('\n');
const buttons=(d,t)=>all(d.get_child(),w=>w instanceof Gtk.Button&&w.label===t);
const click=(d,t)=>{const b=buttons(d,t)[0];check(b?.is_sensitive(),'unavailable button '+t);b.emit('clicked')};
const controls=d=>all(d.get_child(),w=>w instanceof Gtk.DropDown);
const value=w=>w.get_model()?.get_string(w.get_selected())??'';
const choices=w=>{const m=w.get_model();return Array.from({length:m?.get_n_items()??0},(_,i)=>m.get_string(i))};
const select=(w,text)=>{const i=choices(w).findIndex(v=>v.includes(text));check(i>=0,'choice missing '+text+' in '+choices(w));w.selected=i};
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.SessionPickerTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const gateway=new Gateway(ARGV[1],'fixture-secret'),observer=new Gateway(ARGV[1],'fixture-secret');const win=new Adw.ApplicationWindow({application:app,default_width:1000,default_height:900});win.present();const dialogs=[],active=new Set(),selected=[],reads=[];let stage='unlisted authored harness';
 const present=(d,p)=>{dialogs.push(d);active.add(d);d.connect('closed',()=>active.delete(d));d.present(p??win)};
 const json=gateway.json.bind(gateway);gateway.json=async(...args)=>{const r={path:args[1],cancel:args[5],done:false};reads.push(r);try{return await json(...args)}finally{r.done=true}};
 const facts=()=>observer.json('GET','/fixture/facts'),control=(action,rest={})=>observer.json('POST','/fixture/control',{action,...rest});
 const parent=()=>{const d=sheet('Parent fixture',new Gtk.Box());present(d,win);return d};
 const pick=(p,target,pin)=>{pickSubagentSession(gateway,p,present,target,pin,(target,pin)=>selected.push({target,pin}));return dialogs.at(-1)};
 const ready=d=>until(()=>buttons(d,'Выбрать маршрут сессии')[0]?.is_sensitive(),'session catalog not selectable: '+texts(d));
 (async()=>{
  const primary='work-🔧 & profile';let p=parent(),d=pick(p,'not-installed=retained-model','missing-profile');await ready(d);let [h,a,m]=controls(d);check(value(h).includes('not-installed')&&value(a).includes('missing-profile')&&value(m).includes('retained-model')&&texts(d).includes('без замены'),'unlisted authored route silently replaced');const choose=buttons(d,'Выбрать маршрут сессии')[0];choose.emit('clicked');choose.emit('clicked');check(selected.length===1&&selected[0].target==='not-installed=retained-model'&&selected[0].pin==='missing-profile','unlisted route not preserved/selected twice');p.force_close();
  stage='account models and preserved model choice';p=parent();d=pick(p,'claude=shared',primary);await ready(d);[h,a,m]=controls(d);check(value(a).includes(primary)&&value(m).includes('shared'),'initial account/model missing');check(choices(m).some(v=>v.includes('only-a'))&&!choices(m).some(v=>v.includes('only-b')),'model catalog not scoped to account A');select(a,'alternate');check(value(m).includes('shared')&&choices(m).some(v=>v.includes('only-b'))&&!choices(m).some(v=>v.includes('only-a')),'account change reset shared model or mixed catalogs');select(a,primary);select(m,'only-a');select(a,'alternate');check(value(m).includes('only-a')&&value(m).includes('не подтверждена'),'unlisted model silently replaced by tool default');select(m,'shared');select(a,'unread');check(value(m).includes('shared')&&texts(d).includes('Fixture unread <&>'),'unread account model state hidden');select(a,'alternate');
  stage='atomic malformed catalog and readonly last snapshot';for(const mode of ['nested-model','nested-envelope','nested-profile','nested-duplicate','facet-catalog-fail','fail','malformed']){await control('status',{mode});const start=reads.length;click(d,'Перечитать каталог');await until(()=>reads[start]?.done,'malformed read did not settle '+mode);check(!buttons(d,'Выбрать маршрут сессии')[0].is_sensitive()&&controls(d)[0]===h&&value(a).includes('alternate')&&value(m).includes('shared'),'bad catalog replaced selection or allowed choice '+mode);buttons(d,'Выбрать маршрут сессии')[0].emit('clicked');check(selected.length===1,'bad snapshot chose a route '+mode)}await control('status',{mode:''});click(d,'Перечитать каталог');await ready(d);check(value(a).includes('alternate')&&value(m).includes('shared'),'valid retry lost authored selection');click(d,'Выбрать маршрут сессии');check(selected.length===2&&selected[1].target==='claude=shared'&&selected[1].pin==='alternate','exact account route selection wrong');p.force_close();
  stage='accepted read cancels before parent release';const beforeHeld=(await facts()).audit.length;await control('hold');p=parent();d=pick(p,'claude=shared',primary);const pending=reads.at(-1);await until(async()=>{const audit=(await facts()).audit;return audit.length>beforeHeld&&audit.at(-1).path===pending.path.split('?')[0]&&audit.at(-1).status===200&&!pending.done},'accepted status response not held');const oldReload=buttons(d,'Перечитать каталог')[0],oldChoose=buttons(d,'Выбрать маршрут сессии')[0];p.force_close();await until(()=>pending.done,'closed picker did not settle before server release');check(pending.cancel.is_cancelled()&&!active.has(d),'parent did not close/cancel session picker');const count=reads.length;oldReload.emit('clicked');oldChoose.emit('clicked');check(reads.length===count&&selected.length===2,'closed picker read/chose');await control('release-all');
  stage='window parent closure';const another=new Adw.ApplicationWindow({application:app});another.present();d=pick(another,'claude=shared',primary);await ready(d);another.close();await wait(400);check(!active.has(d),'window parent left session picker open');
  const f=await facts();check(f.settings_unchanged&&f.audit.every(r=>r.method==='GET'&&r.query==='include=models'),'picker wrote settings or used unexpected API query');check(f.wire.every(r=>r.authorized)&&f.wire.some(r=>r.path.endsWith('/models')&&r.query==='view=accounts'),'real authenticated account-model fan-out missing');
  print('OK: native session picker through real status fan-out and authenticated simulated daemon account catalogs, preserved unlisted harness/profile/model and model across account switches, exact scoped choices, partial unread metadata, atomic nested failures/cache retry, once-only selection, parent/window closure and accepted GET cancellation before release; Settings unchanged, no vendor CLI/inference');
 })().catch(e=>{failed=true;logError(e);print('Stage: '+stage)}).finally(async()=>{await control('release-all').catch(()=>{});for(const d of [...active].reverse())d.force_close();await wait(400);gateway.close();observer.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
