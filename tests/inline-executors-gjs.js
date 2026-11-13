import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {ActivityPage}=await import(ARGV[0]+'activity.js');
const {NativeI18n,useNativeI18n}=await import(ARGV[0]+'native-i18n.js');
const check=(v,m)=>{if(!v)throw new Error(m)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,m){for(let i=0;i<1000;i++){if(await fn())return;await wait(20)}throw new Error(m)}
function all(w,p){let out=p(w)?[w]:[];if(w instanceof Gtk.Expander){const c=w.get_child();return c?[...out,...all(c,p)]:out}for(let c=w.get_first_child?.();c;c=c.get_next_sibling())out.push(...all(c,p));return out}
const text=w=>all(w,w=>w instanceof Gtk.Label).map(w=>w.label).join('\n');
const buttons=w=>all(w,w=>w instanceof Gtk.Button&&['Open task','Открыть задачу'].includes(w.label));
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.InlineExecutorTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1000,default_height:1000});win.present();const gateway=new Gateway(ARGV[1],'fixture-secret'),opened=[];let page,catalog,stage='actual health producer';
 const control=body=>gateway.json('POST','/fixture/control',body),wire=value=>control({action:'inline-wire',wire:{value}}),facts=()=>gateway.json('GET','/fixture/facts');
 (async()=>{
  await gateway.json('POST','/api/ui/i18n/language',{language:'en'});catalog=new NativeI18n(gateway);useNativeI18n(catalog);await until(()=>catalog.language==='en','English unavailable');await control({action:'inline-baseline'});
  page=new ActivityPage(win,gateway,id=>opened.push(id),()=>undefined);win.set_content(page.widget);
  const reason='private-carrier-reason <&> Ω '+ 'x'.repeat(2048);await control({action:'inline',mode:'seed',reason});await page.refresh();const view=page.inlineExecutors;view.widget.expanded=true;
  check(view.snapshot?.degraded_total===1&&view.snapshot.live.length===2&&view.snapshot.recent.length===2,'real health observation missing');
  check(text(view.widget).includes(reason)&&text(view.widget).includes('inline-call')&&text(view.widget).includes('Slot · -101')&&text(view.widget).includes('does not confirm task completion'),'count/slots/reason or recent semantics missing');
  check(view.widget.measure(Gtk.Orientation.HORIZONTAL,-1)[0]<=640&&all(view.widget,w=>w instanceof Gtk.Label).every(w=>!w.use_markup),'private reason broke geometry or markup');
  let actions=buttons(view.widget);check(actions.length===4,'task navigation missing');actions[0].emit('clicked');check(opened.at(-1)==='inline-call','wrong task navigation');const old=actions[0],snapshot=view.snapshot;
  stage='malformed diagnostics remain independent of base health';
  for(const value of [null,[],{}, {degraded_total:-1,live:[],recent:[]},{degraded_total:1.2,live:[],recent:[]},{degraded_total:0,live:null,recent:[]},{degraded_total:0,live:[null],recent:[]},{degraded_total:0,live:[{executor:'inline_call',wid:'-1'}],recent:[]},{degraded_total:0,live:[],recent:[{executor:'inline_call',reason:[]}]}]){
   await wire(value);await page.refresh();check(view.stale&&view.snapshot===snapshot&&text(view.widget).includes(reason)&&buttons(view.widget).every(b=>!b.sensitive),'bad diagnostic erased cache or enabled navigation');check(text(page.health).includes('Версия ·'),'inline problem hid valid health');const n=opened.length;old.emit('clicked');check(opened.length===n,'old button navigated while stale');
  }
  stage='real reread restores and invalidates detached actions';await control({action:'inline-wire',wire:{}});await page.refresh();check(!view.stale&&view.snapshot!==snapshot&&view.widget.expanded,'recovery lost state/expansion');let n=opened.length;old.emit('clicked');check(opened.length===n,'detached old snapshot navigated');buttons(view.widget)[0].emit('clicked');check(opened.length===n+1,'fresh navigation failed');
  stage='health transport failure and producer removal';await control({action:'fault',values:{'/api/health':'fail'}});await page.refresh();check(view.stale&&text(view.widget).includes(reason),'health failure erased details');await control({action:'fault',values:{}});await control({action:'inline',mode:'idle'});await page.refresh();check(view.snapshot.live.length===0&&view.snapshot.recent.length===2&&view.snapshot.degraded_total===1,'recent disclosure was inferred live/completed or total reset');
  stage='future fields and absent legacy health';await wire({degraded_total:0,live:[{executor:'constructor',wid:0,task_id:null}],recent:[{executor:'future-inline',task_id:'private <&> task',reason:'Future reason',chat_id:0,extra:true}],extra:{future:true}});await page.refresh();check(!view.stale&&text(view.widget).includes('constructor')&&text(view.widget).includes('future-inline')&&text(view.widget).includes('Chat · 0')&&!buttons(view.widget).length,'future values unsafe or fabricated task navigation');
  await control({action:'inline-wire',wire:{omit:true}});await page.refresh();check(!view.widget.visible&&!view.snapshot&&!view.stale,'missing older field was not hidden');await wire([]);await page.refresh();check(view.widget.visible&&view.stale&&!view.snapshot,'bad first read became absence');
  await control({action:'inline-wire',wire:{}});await control({action:'inline',mode:'clear'});await page.refresh();check(view.snapshot.degraded_total===0&&view.snapshot.live.length===0&&view.snapshot.recent.length===0&&!view.stale,'genuine zero snapshot not rendered');
  stage='live locale and private data';await control({action:'inline',mode:'seed',reason});await page.refresh();
  const expanded=view.widget.expanded;
  const translated=await gateway.json('POST','/api/ui/i18n/import',{language:'qaa',entries:{'Recent execution disclosures':{text:'QAA recent'},'Gateway process · {live} current · {count} fallback disclosures':{text:'QAA gateway · {live} · {count}'}}});
  await gateway.json('POST','/api/ui/i18n/language',{language:'qaa',profile:{direction:'rtl'}});catalog.frame({type:'ui_language_changed',language:'qaa'});catalog.frame({type:'ui_i18n_updated',language:'qaa',revision:translated.revision});
  await until(()=>text(view.widget).includes('QAA recent'),'live locale body missing');check(view.widget.label.includes('QAA gateway')&&view.widget.expanded===expanded&&view.widget.get_direction()===Gtk.TextDirection.RTL&&text(view.widget).includes(reason),'locale lost expansion, direction or private facts');
  await until(async()=>(await facts()).audit.some(r=>r.path==='/api/ui/i18n/missing'),'missing report absent');check(!JSON.stringify((await facts()).audit.filter(r=>r.path==='/api/ui/i18n/missing')).includes('private-carrier-reason'),'private reason became translation key');
  stage='close disables snapshot callbacks';const staleButton=buttons(view.widget)[0];n=opened.length;page.close();staleButton.emit('clicked');view.update({degraded_total:99,live:[],recent:[]});check(opened.length===n&&view.snapshot.degraded_total===1,'closed panel navigated or changed snapshot');const frozen=text(view.widget),frozenTitle=view.widget.label;await gateway.json('POST','/api/ui/i18n/language',{language:'en'});catalog.frame({type:'ui_language_changed',language:'en'});await until(()=>catalog.language==='en','reset locale pending');check(text(view.widget)===frozen&&view.widget.label===frozenTitle,'closed panel retained locale bindings');const f=await facts();check(f.non_language_settings_unchanged&&!f.commands.length&&f.audit.every(r=>r.method==='GET'||r.path.startsWith('/api/ui/i18n/')),'readonly panel changed Settings/work');
  print('OK: native Activity inline executors through real health/inline_executors_fact and disclosure writer over inert slot observations; process counter/live/recent separate, no completion inference, exact task navigation, nine malformed diagnostics retain prior facts without breaking base health, transport loss/recovery, future/nullable/zero/absent forms, long literal data and close gates; no thread/task/model execution');
 })().catch(error=>{failed=true;logError(error);print('Stage: '+stage)}).finally(()=>{page?.close();catalog?.close();useNativeI18n();gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
