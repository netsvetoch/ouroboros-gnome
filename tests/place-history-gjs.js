import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {PlaceHistory}=await import(ARGV[0]+'place-history.js');
const check=(x,m)=>{if(!x)throw new Error(m)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,m){for(let i=0;i<1500;i++){if(await fn())return;await wait(20)}throw new Error(m)}
function all(w,p){let out=p(w)?[w]:[];for(let c=w.get_first_child?.();c;c=c.get_next_sibling())out.push(...all(c,p));return out}
const text=d=>all(d.get_child(),w=>w instanceof Gtk.Label).map(w=>w.get_text()).join('\n');
const button=(d,s)=>all(d.get_child(),w=>w instanceof Gtk.Button&&w.label===s)[0];
const click=(d,s)=>{const b=button(d,s);check(b?.is_sensitive(),'button unavailable '+s);b.emit('clicked')};
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.PlaceHistoryTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1100,default_height:1000});win.present();
 const gateway=new Gateway(ARGV[1],'fixture-secret'),observer=new Gateway(ARGV[1],'fixture-secret'),dialogs=[],active=new Set(),reads=[];
 const json=gateway.json.bind(gateway);gateway.json=async(...args)=>{const r={path:args[1],cancel:args[5],done:false};reads.push(r);try{return await json(...args)}finally{r.done=true}};
 const present=(d,p)=>{dialogs.push(d);active.add(d);let signal=p instanceof Adw.Dialog?p.connect('closed',()=>{if(d.get_mapped())d.force_close()}):0;d.connect('closed',()=>{active.delete(d);if(signal){p.disconnect(signal);signal=0}});d.present(p??win)};
 const view=new PlaceHistory(gateway,present),facts=()=>observer.json('GET','/fixture/facts'),control=(action,extra={})=>observer.json('POST','/fixture/control',{action,...extra}),fault=values=>control('fault',{values});let stage='real room index';
 async function idle(d){await until(()=>!text(d).includes('Читаю сохранённую историю…')&&!text(d).includes('Читаю индекс комнат…'),'history pending')}
 (async()=>{
  const f=await facts();view.rooms(null,f.place,'Fixture account',{mention:'Mention <&>'});let rooms=dialogs.at(-1);await idle(rooms);check(button(rooms,'Design <&>'),'real arrivals did not index room');const oldRoom=button(rooms,'Design <&>');click(rooms,'Перечитать комнаты');await idle(rooms);const count=dialogs.length;oldRoom.emit('clicked');check(dialogs.length===count,'stale index button opened history');await fault({rooms:'malformed'});click(rooms,'Перечитать комнаты');await idle(rooms);check(text(rooms).includes('Показан последний прочитанный индекс')&&button(rooms,'Design <&>'),'malformed rooms erased index');await fault({rooms:''});
  click(rooms,'Design <&>');let d=dialogs.at(-1);await idle(d);let shown=text(d);check(shown.includes('Room headline')&&shown.includes('Reply delivered & retained text')&&!shown.includes('# Room headline')&&shown.includes('Arrival 314 · **plain input**'),'Markdown not native');check(all(d.get_child(),w=>w instanceof Gtk.Label&&w.use_markup&&w.get_text()==='Reply delivered & retained text').length,'bold text not GTK markup');check(shown.includes('Получено во время паузы')&&shown.includes('Доставлено')&&shown.includes('Итог доставки неизвестен')&&shown.includes('Доставка не удалась'),'retained attention/delivery facts absent');
  stage='real cursor pagination with all retained arrivals';let pages=0;while(button(d,'Ранее').visible){check(++pages<8,'pagination loop');click(d,'Ранее');await idle(d)}shown=text(d);for(let i=0;i<314;i++)check(shown.split('Arrival '+String(i).padStart(3,'0')).length===2,'missing/duplicate arrival '+i);check(pages>=2&&shown.includes('Начало истории'),'did not reach actual history beginning');
  stage='failed and malformed history keep previous messages';for(const mode of ['fail','malformed']){await fault({history:mode});click(d,'Перечитать историю');await idle(d);check(text(d).includes('Arrival 000')&&button(d,'Повторить запрос').visible,'failed/malformed page erased history or lacked retry')}await fault({history:''});click(d,'Повторить запрос');await idle(d);check(!button(d,'Повторить запрос').visible&&text(d).includes('Reply delivered & retained text'),'retry did not recover latest');
  stage='cycle refused and history-view change restarts from latest';await fault({history:'cycle'});click(d,'Ранее');await idle(d);check(button(d,'Повторить запрос').visible&&text(d).includes('неполную страницу'),'cycle accepted');await fault({history:'moved'});click(d,'Повторить запрос');await idle(d);check(text(d).includes('история изменилась')&&text(d).includes('Room headline'),'history view changed did not reset to latest');
  stage='nested history facts reject malformed pages atomically';
  const invalid=[
   [['place_history','delivery_state'],42],[['place_history','owner_confirmed'],'true'],[['place_history','sends_as_owner'],'true'],[['place_history','held'],'true'],[['place_history','checked'],'false'],[['place_history','held_text'],{}],
   [['place_history','attention'],[]],[['place_history','attention','reason'],{}],[['place_history','attention','recipient'],42],
   [['place_history','historical_import'],[]],[['place_history','historical_import','authorship'],42],[['place_history','historical_import','received_at'],{}],[['place_history','sent_at'],42],
   [['place_history','reaction'],[]],[['place_history','reaction','summary'],{}],[['place_history','sends_as','label'],{}],
   [['place_history','identity','sends_as','label'],42],[['place_history','identity','reads_as'],[{label:'ok'},null]],[['place_history','identity','reads_as'],[{label:'ok',kind:42}]],
   [['is_progress'],'false'],[['markdown'],'false'],[['sender_label'],{}]
  ];
  for(const [field,value] of invalid){await fault({history:'row-field',field,value});click(d,'Перечитать историю');await idle(d);check(text(d).includes('неполную страницу')&&text(d).includes('Новое чтение не подтверждено.')&&text(d).includes('Reply delivered & retained text')&&button(d,'Повторить запрос').visible,'malformed fact replaced last-known page: '+field.join('.'))}
  await fault({history:'page-field',field:['window','complete'],value:'false'});click(d,'Перечитать историю');await idle(d);check(text(d).includes('неполную страницу')&&text(d).includes('Reply delivered & retained text'),'malformed coverage flag accepted');
  stage='future codes and captured legacy accounts stay readable';const compatible={kind:'future-kind',delivery_state:'constructor',attention:{decision:'heard',reason:'constructor',recipient:'Future recipient <&>'},
   facts:['constructor','__proto__'],owner_confirmed:false,sends_as_owner:false,sent_at:'2025-01-01T00:00:00Z',historical_import:{authorship:'unknown',received_at:'2026-11-13T06:00:00Z'},
   reaction:{summary:'Reaction metadata <&> Ω'},held:true,checked:false,held_text:'Held text <&>',identity:{sends_as:{label:'Captured sender',kind:'user'},reads_as:[{label:'Legacy reader'}]},
   sends_as:{label:'New account kind',kind:'future-account-kind'},future:{key:true}};
  await fault({history:'row-field',field:['place_history'],value:compatible});click(d,'Перечитать историю');await idle(d);
  for(const value of ['constructor','__proto__','Future recipient <&>','Reaction metadata <&> Ω','Held text <&>','Captured sender','Legacy reader','future-account-kind','2025-01-01T00:00:00Z','2026-11-13T06:00:00Z'])check(text(d).includes(value),'compatible history metadata lost: '+value);
  check(!text(d).includes('неполную страницу')&&!text(d).includes('function Object')&&!text(d).includes('[object Object]')&&all(d.get_child(),w=>w instanceof Gtk.Label&&w.get_text().includes('Reaction metadata')).every(w=>!w.use_markup),'future fact lookup leaked prototype or parsed markup');
  await fault({history:''});click(d,'Перечитать историю');await idle(d);
  stage='coverage retry uses current page only';await fault({history:'gap'});click(d,'Перечитать историю');await idle(d);check(text(d).includes('Продолжается импорт'),'importing coverage absent');const oldRetry=button(d,'Повторить чтение диапазона');await fault({history:''});click(d,'Перечитать историю');await idle(d);const before=(await facts()).audit.length;oldRetry.emit('clicked');await wait(30);check((await facts()).audit.length===before,'detached range retry issued read');
  stage='closing rooms cancels held index and nested history before server release';await control('hold');const heldCount=(await facts()).audit.length;click(rooms,'Перечитать комнаты');click(d,'Перечитать историю');await until(async()=>{const a=(await facts()).audit;return a.length>=heldCount+2&&a.slice(-2).every(r=>r.reply)},'held reads absent');const held=reads.slice(-2),oldRead=button(d,'Перечитать историю'),oldIndex=button(rooms,'Перечитать комнаты');rooms.force_close();await until(()=>held.every(r=>r.done),'closed held reads not settled');check(held.every(r=>r.cancel.is_cancelled()),'closed reads not cancelled');const closedCount=(await facts()).audit.length;oldRead.emit('clicked');oldIndex.emit('clicked');await wait(30);check((await facts()).audit.length===closedCount,'closed controls issued HTTP');await control('release-all');
  view.rooms(null,f.place,'Fixture account',{});rooms=dialogs.at(-1);await idle(rooms);check(button(rooms,'Design <&>')&&(await facts()).settings_unchanged&&(await facts()).audit.every(r=>r.method==='GET'),'reopen failed or mutated server Settings');
  stage='history opened directly from main GTK window';view.history(win,view.indexes.get(f.place).rooms[0],{});d=dialogs.at(-1);await idle(d);check(text(d).includes('Room headline'),'main-window history failed');d.force_close();
  print('OK: native place room index/history through real retained arrivals, delivery recorder and history projection; 315 arrivals across actual cursor pages, 23 malformed nested metadata/coverage cases retain last-known pages, future/prototype codes and captured legacy accounts, reaction/import/hold/time facts; Markdown GTK, stale controls, cycle refusal, view restart and cancellation before held replies release; no connector/model execution or client mutations');
 })().catch(async e=>{failed=true;logError(e);print('Stage: '+stage);for(const d of active)print(d.title+'\n'+text(d).slice(-3000));try{print(JSON.stringify((await facts()).audit.slice(-2).map(r=>({path:r.path,status:r.status,rows:r.reply?.messages?.length}))))}catch{}}).finally(async()=>{await control('release-all').catch(()=>{});for(const d of [...active].reverse())if(d.get_mapped())d.force_close();gateway.close();observer.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
