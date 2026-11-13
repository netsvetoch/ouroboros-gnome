import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {ModelLimits}=await import(ARGV[0]+'model-limits.js');
const check=(x,m)=>{if(!x)throw new Error(m)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,m){for(let i=0;i<800;i++){if(await fn())return;await wait(20)}throw new Error(m)}
function all(w,p){let out=p(w)?[w]:[];for(let c=w.get_first_child?.();c;c=c.get_next_sibling())out.push(...all(c,p));return out}
const texts=d=>all(d.get_child(),w=>w instanceof Gtk.Label).map(w=>w.get_text()).join('\n');
const btn=(d,s)=>all(d.get_child(),w=>w instanceof Gtk.Button&&w.label===s)[0];
const click=(d,s)=>{const b=btn(d,s);check(b?.is_sensitive()&&b.visible,'button unavailable '+s);b.emit('clicked')};
const field=(d,s)=>all(d.get_child(),w=>w instanceof Gtk.Entry&&w.placeholder_text===s)[0];
const note=d=>all(d.get_child(),w=>w instanceof Gtk.TextView&&w.get_name()==='model-window-note')[0].buffer;
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.ModelLimitsTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const gateway=new Gateway(ARGV[1],'fixture-secret');const win=new Adw.ApplicationWindow({application:app,default_width:1100,default_height:950});win.present();const dialogs=[],active=new Set();let stage='initial real preview';
 const present=(d,p)=>{dialogs.push(d);active.add(d);d.connect('closed',()=>active.delete(d));d.present(p??win)};
 const limits=new ModelLimits(gateway,present),facts=()=>gateway.json('GET','/fixture/facts'),control=b=>gateway.json('POST','/fixture/control',b),writes=async()=>((await facts()).audit).filter(r=>r.method==='POST');
 const selection={role:'main',model:'openai-compatible::fixture-model',local:false,account:'',window:0};
 (async()=>{
  limits.show(win,'Fixture',selection);let d=dialogs.at(-1);await until(()=>btn(d,'Подтвердить максимум')?.is_sensitive(),'real preview did not enable acknowledgement: '+texts(d));
  stage='atomic preview shape checks';
  const baseline=(await facts()).audit.filter(r=>r.method==='GET'&&r.path==='/api/settings').at(-1).reply;
  field(d,'Токенов ответа').text='1234';field(d,'Токенов контекста').text='4567';note(d).set_text('Private retained note <&>',-1);
  const invalid=[null,[],{},...[
   ['route',[]],['route.provider',2],['route.model','foreign-model'],['route.base_url',{}],['route.options',[]],['route.headers',[]],['route.use_local','false'],
   ['response_limit',[]],['response_limit.route_fp',{}],['response_limit.max_output_tokens',-1],['response_limit.max_output_tokens',1.5],['response_limit.source',[]],['response_limit.stale','false'],['response_limit.observed_at',42],
   ['window_route',[]],['window_route.provider',{}],['window_route.route_fp',''],['window',[]],['window.tokens','32000'],['window.usable',-1],['window.reserve',null],['window.text',{}],
   ['window.contradiction',[]],['window.contradiction.tokens','2'],['window.retired_ack',[]],['window.retired_ack.window_tokens',-1],['window.retired_ack.ts',{}],['window_ack','true']
  ].map(([path,value])=>{const copy=JSON.parse(JSON.stringify(baseline)),parts=path.split('.');let at=copy;for(const key of parts.slice(0,-1))at=at[key]??=( {} );at[parts.at(-1)]=value;return copy})];
  for(const body of invalid){
   await control({action:'preview',body});click(d,'Перечитать маршрут');await until(()=>btn(d,'Перечитать маршрут').sensitive&&texts(d).includes('Сведения о маршруте недоступны.'),'malformed preview not refused');
   check(!btn(d,'Подтвердить максимум').is_sensitive()&&!btn(d,'Подтвердить окно').is_sensitive()&&field(d,'Токенов ответа').text==='1234'&&field(d,'Токенов контекста').text==='4567'&&note(d).text==='Private retained note <&>','malformed preview changed draft or remained writable');
  }
  check((await writes()).length===0,'malformed preview wrote evidence');
  stage='optional and additive preview fields';const compatible=JSON.parse(JSON.stringify(baseline));compatible.future={data:true};compatible.window.tokens=null;compatible.window.usable=null;compatible.window.kind='future-window-kind';
  for(const key of ['source','status','observed_at','stale','max_output_tokens'])delete compatible.response_limit[key];
  await control({action:'preview',body:compatible});click(d,'Перечитать маршрут');await until(()=>btn(d,'Подтвердить максимум').is_sensitive(),'optional compatible preview rejected');
  check(texts(d).includes('future-window-kind')&&field(d,'Токенов ответа').text==='1234','future value or draft lost');
  stage='independent route account display';const accounts=JSON.parse(JSON.stringify(baseline));accounts.route.options={source_id:'response-source <&>',credential_profile_id:'response-profile',account_fingerprint:'r'.repeat(128)};accounts.window_route.options={source_id:'window-source <&>',credential_profile_id:'window-profile',account_fingerprint:'w'.repeat(128)};
  await control({action:'preview',body:accounts});click(d,'Перечитать маршрут');await until(()=>texts(d).includes('Аккаунт окна контекста · window-source <&> · window-profile'),'independent window account missing');
  for(const expander of all(d.get_child(),w=>w instanceof Gtk.Expander))expander.expanded=true;
  check(texts(d).includes('Аккаунт · response-source <&> · response-profile')&&texts(d).includes('Отпечаток аккаунта максимума ответа · '+'r'.repeat(128))&&texts(d).includes('Отпечаток аккаунта окна контекста · '+'w'.repeat(128)),'independent identity fingerprints missing');
  check(all(d.get_child(),w=>w instanceof Gtk.Label&&w.label.includes('<&>')).every(w=>!w.use_markup),'account label parsed markup');
  click(d,'Перечитать маршрут');await until(()=>btn(d,'Подтвердить максимум').is_sensitive()&&!texts(d).includes('window-source <&>'),'real preview recovery failed');
  stage='invalid preflight cannot write';await control({action:'preview',body:{...baseline,window_route:[]}});click(d,'Подтвердить максимум');
  await until(()=>btn(d,'Перечитать маршрут').sensitive&&!btn(d,'Подтвердить максимум').is_sensitive(),'invalid preflight left mutation enabled');
  check((await writes()).length===0&&field(d,'Токенов ответа').text==='1234'&&note(d).text==='Private retained note <&>','invalid preflight wrote evidence or erased draft');
  click(d,'Перечитать маршрут');await until(()=>btn(d,'Подтвердить максимум').is_sensitive(),'valid preflight recovery failed');
  stage='invalid first preview has no writable defaults';await control({action:'preview',body:[]});limits.show(win,'Bad first',selection);const badFirst=dialogs.at(-1);
  await until(()=>texts(badFirst).includes('Сведения о маршруте недоступны.'),'invalid first preview not disclosed');
  check(!btn(badFirst,'Подтвердить максимум').is_sensitive()&&!btn(badFirst,'Подтвердить окно').is_sensitive(),'invalid first preview created writable defaults');badFirst.force_close();
  for(const bad of ['0','-1','1.5','Infinity']){field(d,'Токенов ответа').text=bad;click(d,'Подтвердить максимум');check(texts(d).includes('положительное целое'),'invalid token count accepted')}
  check((await writes()).length===0,'invalid native input sent ack');
  stage='independent output acknowledgement';field(d,'Токенов ответа').text='2048';click(d,'Подтвердить максимум');await until(()=>texts(d).includes('Подтверждение сохранено.'),'response maximum not acknowledged');let f=await facts(),out=Object.values(f.evidence.response_acks)[0];check(out.max_output_tokens===2048&&!Object.keys(f.evidence.owner_acks).length,'response ack touched context records');
  stage='context acknowledgement and verbatim note';const prose='  Owner context evidence <&> 🔧\nSecond line\n';note(d).set_text(prose,-1);field(d,'Токенов контекста').text='32000';click(d,'Подтвердить окно');await until(()=>btn(d,'Отозвать окно').visible&&btn(d,'Перечитать маршрут').sensitive,'window not acknowledged');f=await facts();let context=Object.values(f.evidence.owner_acks)[0];check(context.window_tokens===32000&&context.note===prose&&Object.values(f.evidence.response_acks)[0].max_output_tokens===2048,'context note changed or output ack overwritten');
  check((await writes()).at(-1).body.note===prose&&!(await writes())[0].body.note,'note sent to wrong ack type');
  stage='independent revoke';click(d,'Отозвать максимум');await until(()=>!btn(d,'Отозвать максимум').visible&&btn(d,'Перечитать маршрут').sensitive,'output maximum not revoked');f=await facts();check(!Object.keys(f.evidence.response_acks).length&&Object.values(f.evidence.owner_acks)[0].window_tokens===32000,'output revoke removed context ack');click(d,'Отозвать окно');await until(()=>!btn(d,'Отозвать окно').visible&&btn(d,'Перечитать маршрут').sensitive,'context not revoked');check(!Object.keys((await facts()).evidence.owner_acks).length,'context revoke retained record');
  stage='route change before write';const before=(await writes()).length;field(d,'Токенов контекста').text='64000';note(d).set_text('Old route note',-1);await control({action:'route',route:'route-b'});click(d,'Подтвердить окно');await until(()=>texts(d).includes('Маршрут изменился.'),'changed route not detected at preflight');check((await writes()).length===before&&field(d,'Токенов контекста').text===''&&note(d).get_char_count()===0,'changed route sent ack or retained old note');
  stage='lost response after committed ack';field(d,'Токенов ответа').text='4096';await control({action:'lose'});click(d,'Подтвердить максимум');await until(()=>texts(d).includes('Результат записи неизвестен.'),'lost receipt became confirmed');check(!btn(d,'Подтвердить максимум').is_sensitive(),'unknown result remained writable');const afterLoss=(await writes()).length;click(d,'Перечитать маршрут');await until(()=>btn(d,'Отозвать максимум').visible&&btn(d,'Подтвердить максимум').is_sensitive(),'lost ack not recovered by preview');check((await writes()).length===afterLoss,'readback repeated ack');
  stage='mismatched annotation receipt is unconfirmed';field(d,'Токенов контекста').text='50000';note(d).set_text(prose,-1);await control({action:'mismatch'});click(d,'Подтвердить окно');await until(()=>texts(d).includes('Результат записи неизвестен.'),'mismatched annotation receipt was accepted');check(note(d).get_text(note(d).get_start_iter(),note(d).get_end_iter(),false)===prose&&!btn(d,'Подтвердить окно').is_sensitive(),'unconfirmed annotation lost its draft or remained writable');const mismatchWrites=(await writes()).length;click(d,'Перечитать маршрут');await until(()=>btn(d,'Подтвердить окно').is_sensitive(),'annotation mismatch preview did not recover');check((await writes()).length===mismatchWrites&&Object.values((await facts()).evidence.owner_acks)[0].note===prose,'mismatched receipt triggered replay or changed stored annotation');
  stage='active route changes after preflight';field(d,'Токенов контекста').text='48000';note(d).set_text('Bound to route B',-1);await control({action:'hold',kind:'write'});click(d,'Подтвердить окно');await until(async()=>(await facts()).held,'post-preflight write not held');await control({action:'route',route:'route-c'});await control({action:'release'});await until(()=>texts(d).includes('Шлюз уже показывает другой маршрут.'),'post-write route transition not explained');f=await facts();context=Object.values(f.evidence.owner_acks)[0];check(context.note==='Bound to route B'&&context.route.base_url.includes('/route-b/'),'ack bound to a different route');check(!btn(d,'Отозвать окно').visible,'old route ack shown for current route');
  stage='failed read blocks mutations';await control({action:'read-fail'});click(d,'Перечитать маршрут');await until(()=>texts(d).includes('HTTP 503'),'preview failure not shown');check(!btn(d,'Подтвердить максимум').is_sensitive()&&!btn(d,'Подтвердить окно').is_sensitive(),'failed preview left writes enabled');d.force_close();
  stage='parent close cancels preflight before POST';const parent=new Adw.Dialog({title:'Parent',child:new Gtk.Label({label:'Owner route'})});present(parent);limits.show(parent,'Child',selection);d=dialogs.at(-1);await until(()=>btn(d,'Подтвердить максимум').is_sensitive(),'child preview not ready');field(d,'Токенов ответа').text='1024';const count=(await writes()).length;await control({action:'hold',kind:'read'});click(d,'Подтвердить максимум');await until(async()=>(await facts()).held,'read preflight not held');parent.force_close();await until(()=>!active.has(d),'closing parent left route form open');await control({action:'release'});await wait(150);check((await writes()).length===count,'closed preflight posted acknowledgement');
  f=await facts();check(f.settings_unchanged&&f.audit.every(r=>r.method==='GET'||r.path==='/api/owner/capability-ack')&&(await writes()).every(r=>r.actor==='owner'),'ack modified Settings or lost owner identity');
  print('OK: real model route preview/evidence/ack API; 31 malformed preview variants retain draft and disable mutation, invalid first/preflight reads cannot write, optional/additive metadata and independent route account display; independent max/window save and revoke, verbatim multiline note, invalid input, preflight route mismatch and note reset, lost committed response readback without replay, mismatched annotation receipt rejection, post-preflight exact-route binding, failed preview write guard, parent closure before POST; no inference or Settings writes');
 })().catch(e=>{failed=true;logError(e);print('Stage: '+stage)}).finally(()=>{for(const d of [...active].reverse())d.force_close();gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
