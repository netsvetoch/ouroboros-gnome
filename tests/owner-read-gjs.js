import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {OwnerSettings}=await import(ARGV[0]+'owner-settings.js');
const check=(x,m)=>{if(!x)throw new Error(m)};
const wait=ms=>new Promise(r=>GLib.timeout_add(0,ms,()=>{r();return GLib.SOURCE_REMOVE}));
async function until(fn,m){for(let i=0;i<500;i++){if(await fn())return;await wait(20)}throw new Error(m)}
function all(w,p){let a=p(w)?[w]:[];for(let c=w.get_first_child?.();c;c=c.get_next_sibling())a.push(...all(c,p));return a}
const field=(o,title)=>{const l=all(o.body,w=>w instanceof Gtk.Label&&w.label===title)[0];check(l,'field missing '+title);return l.get_parent()};
const rooms=o=>all(o.body,w=>w instanceof Gtk.DropDown).find(w=>w.get_model().get_string(0)==='Main');
const model=o=>all(field(o,'Модель Safety Supervisor'),w=>w instanceof Gtk.Entry)[0];
const save=o=>all(field(o,'Модель Safety Supervisor'),w=>w instanceof Gtk.Button&&w.label==='Сохранить')[0];
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.OwnerReadTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1150,default_height:1000});win.present();
 const gateway=new Gateway(ARGV[1],'fixture-secret'),observer=new Gateway(ARGV[1],'fixture-secret'),owner=new OwnerSettings(win,gateway,()=>{});let stage='initial read';
 const control=mode=>observer.json('POST','/fixture/control',{action:'fault',mode});
 const facts=()=>observer.json('GET','/fixture/facts');
 (async()=>{
  await control('owner-settings-root');owner.show();await until(()=>!owner.busy,'initial invalid read pending');
  check(!owner.snapshot&&!owner.readReady&&!owner.body.get_sensitive()&&all(owner.body,w=>w instanceof Gtk.Entry).length===0,'initial invalid response created writable default form');
  await control('');await owner.load();check(owner.readReady,'valid primary response refused');
  rooms(owner).selected=1;model(owner).text='retained-private-draft';
  for(const mode of ['settings-root','settings-missing','settings-text','settings-policy','projects-root','projects-missing','projects-id','projects-duplicate','projects-cognition','projects-effort','projects-http']){
   stage=mode;const snapshot=owner.snapshot,projects=owner.projects,scope=owner.projectId,version=owner.version;
   await control('owner-'+mode);await owner.load();
   check(!owner.readReady&&!owner.body.get_sensitive(),'invalid read left form writable: '+mode);
   check(owner.snapshot===snapshot&&owner.projects===projects&&owner.projectId===scope&&scope==='locale-project'&&owner.version===version,'invalid response partially replaced state or scope: '+mode);
   check(model(owner).text==='retained-private-draft'&&(owner.status.label.includes('Неполный или неверный ответ')||mode==='projects-http'),'draft/error missing: '+mode);
   const before=(await facts()).audit.filter(x=>x.method==='POST'&&x.path.startsWith('/api/')).length;
   save(owner).emit('clicked');await wait(30);
   check((await facts()).audit.filter(x=>x.method==='POST'&&x.path.startsWith('/api/')).length===before,'stale writable callback sent POST after invalid read');
   await control('');await owner.load();check(owner.readReady&&owner.body.get_sensitive()&&owner.projectId===scope&&model(owner).text==='retained-private-draft','valid read did not recover preserved scope/draft');
  }
  stage='desktop malformed response is isolated';await control('owner-desktop');await owner.load();
  check(owner.readReady&&owner.hosts.get('/api/desktop/background').state==='unavailable'&&model(owner).text==='retained-private-draft','malformed host response broke unrelated owner form');
  await control('');await owner.load();
  stage='real save after recovery';save(owner).emit('clicked');await until(()=>!owner.busy,'owner save pending');
  const persisted=await observer.json('GET','/api/settings');check(persisted.OUROBOROS_MODEL_SAFETY==='retained-private-draft'&&owner.readReady&&owner.projectId==='locale-project','recovery save failed or retargeted scope');
  print('OK: native owner read validates primary settings/projects atomically; initial invalid read and eleven malformed/failed responses preserve last snapshot/project/draft, disable form and block programmatic POST; valid reload recovers, desktop failure isolated, actual owner model POST/readback succeeds');
 })().catch(e=>{failed=true;logError(e);print('Stage: '+stage)}).finally(async()=>{await control('').catch(()=>{});owner.close();gateway.close();observer.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
