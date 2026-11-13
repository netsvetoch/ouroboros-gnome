import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {ModelCatalog}=await import(ARGV[0]+'model-catalog.js');
const check=(x,m)=>{if(!x)throw new Error(m)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,m){for(let i=0;i<600;i++){if(await fn())return;await wait(20)}throw new Error(m)}
function all(w,p){let out=p(w)?[w]:[];for(let c=w.get_first_child?.();c;c=c.get_next_sibling())out.push(...all(c,p));return out}
const texts=d=>all(d.get_child(),w=>w instanceof Gtk.Label).map(w=>w.get_text()).join('\n');
const buttons=(d,caption)=>all(d.get_child(),w=>w instanceof Gtk.Button&&w.label===caption);
const click=(d,caption)=>{const b=buttons(d,caption)[0];check(b?.is_sensitive(),'button unavailable '+caption);b.emit('clicked')};
const rows=d=>all(d.get_child(),w=>w instanceof Adw.ActionRow);
async function expand(d){for(let i=0;i<3;i++){for(const e of all(d.get_child(),w=>w instanceof Gtk.Expander))e.expanded=true;await wait(30)}}
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.ModelAccountCatalogTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const gateway=new Gateway(ARGV[1],'fixture-secret');const win=new Adw.ApplicationWindow({application:app,default_width:1100,default_height:950});win.present();const dialogs=[],active=new Set(),selected=[];let stage='real subscription mapper';
 const present=(d,p)=>{dialogs.push(d);active.add(d);d.connect('closed',()=>active.delete(d));d.present(p??win)};
 const latest=()=>dialogs.at(-1),facts=()=>gateway.json('GET','/fixture/facts');
 (async()=>{
  new ModelCatalog(gateway,present).pick(win,model=>selected.push(model));const picker=latest();await until(()=>rows(picker).length===70,'initial catalog not loaded');await expand(picker);
  for(const name of ['A','B','C','D'])check(buttons(picker,'Аккаунт · Account '+name).length===1,'aggregate source lost account '+name);
  check(texts(picker).includes('codex')&&texts(picker).includes('fast')&&texts(picker).includes('Каталоги по аккаунтам · true'),'source capabilities missing');
  click(picker,'Источник · Fixture CLI');await until(()=>rows(picker).length===4,'source scoped items missing');await expand(picker);const reads=(await facts()).providers.length;
  stage='missing versus empty account catalog';click(picker,'Аккаунт · Account C');await until(()=>texts(picker).includes('В полученной выборке нет совпадений.'),'missing catalog did not settle');await expand(picker);let t=texts(picker);check(t.includes('Could not read account C <&>')&&t.includes('Недоступен')&&t.includes('unknown'),'missing catalog state hidden');check(!t.includes('Моделей в снимке'),'null catalog falsely counted as empty');
  click(picker,'Источник · Fixture CLI');await until(()=>rows(picker).length===4,'source recovery missing');await expand(picker);click(picker,'Аккаунт · Account D');await until(()=>texts(picker).includes('В полученной выборке нет совпадений.'),'empty catalog did not settle');await expand(picker);t=texts(picker);check(t.includes('Получен')&&t.includes('Моделей в снимке · 0')&&t.includes('fingerprint-d')&&t.includes('2026-11-12T00:00:00Z'),'empty catalog snapshot hidden');
  click(picker,'Источник · Fixture CLI');await until(()=>rows(picker).length===4,'second source recovery missing');await expand(picker);click(picker,'Аккаунт · Account B');await until(()=>rows(picker).length===2,'account B models missing');await expand(picker);check(texts(picker).includes('Window spent <&> 🔧'),'account problem hidden');
  stage='arbitrary capability JSON and full model selection';const search=all(picker.get_child(),w=>w instanceof Gtk.SearchEntry)[0];search.text='shared';await until(()=>rows(picker).length===1,'shared model search failed');click(picker,'Подробнее…');const detail=latest();t=texts(detail);for(const value of ['Fixture CLI','Claudexor','fixture-source','fingerprint-b','reported context','1000000','8192','high','text, image','fast','Window spent <&> 🔧'])check(t.includes(value),'model metadata missing '+value);
  click(detail,'Выбрать этот маршрут');check(selected.length===1,'selection callback missing');const model=selected[0];check(model.value==='claudexor::fixture-source=shared'&&model.credential_profile_id==='fixture-b'&&model.account_fingerprint==='fingerprint-b'&&model.context_window.basis==='reported context','selection lost model account/capabilities');
  const f=await facts();check(f.settings_unchanged,'catalog picker wrote settings');check(f.providers.length===reads,'scoped catalog fetched ordinary providers');check(f.audit.every(r=>r.method==='GET'&&r.status===200),'unexpected catalog transport');for(const id of ['b','c','d'])check(f.audit.some(r=>r.query==='source_id=fixture-source&credential_profile_id=fixture-'+id),'exact profile query missing '+id);check(f.account_calls.some(r=>r.op==='models'&&r.profile==='fixture-b'&&r.options.view==='accounts'),'real mapper did not negotiate account view');
  print('OK: real subscription model mapper with simulated owned-daemon account view, aggregate source field, four native account scopes, unavailable versus empty catalog metadata, provider/source labels, arbitrary capability JSON, full selected model profile/fingerprint, exact scoped GETs and unchanged settings; no vendor CLI or inference');
 })().catch(e=>{failed=true;logError(e);print('Stage: '+stage)}).finally(()=>{for(const d of [...active].reverse())d.force_close();gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
