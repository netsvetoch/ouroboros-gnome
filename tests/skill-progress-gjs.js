import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {ChatPage}=await import(ARGV[0]+'chat.js');
const {SkillProgressView,readSkillProgress}=await import(ARGV[0]+'skill-progress.js');
const {episodeTask}=await import(ARGV[0]+'task-episodes.js');
const {NativeI18n,useNativeI18n}=await import(ARGV[0]+'native-i18n.js');
const check=(v,m)=>{if(!v)throw new Error(m)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,m){for(let i=0;i<1000;i++){if(await fn())return;await wait(20)}throw new Error(m)}
function all(w,p){let a=p(w)?[w]:[];for(let c=w.get_first_child?.();c;c=c.get_next_sibling())a.push(...all(c,p));return a}
const texts=w=>all(w,w=>w instanceof Gtk.Label).map(w=>w.label).join('\n');
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.SkillProgressTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1250,default_height:950}),body=new Gtk.Box({orientation:Gtk.Orientation.HORIZONTAL,spacing:8});win.set_content(body);win.present();
 const gateway=new Gateway(ARGV[1],'fixture-secret'),observer=new Gateway(ARGV[1],'fixture-secret'),opened=[],pages=[],controlled=[];let catalog,stage='real lifecycle producer';
 const control=(action,extra={})=>observer.json('POST','/fixture/control',{action,...extra}),facts=()=>observer.json('GET','/fixture/facts');
 const views=p=>[...p.skillProgressViews.values()],pointer=p=>views(p).find(v=>readSkillProgress(v.raw)?.pointer);
 (async()=>{
  await gateway.json('POST','/api/ui/i18n/language',{language:'en'});catalog=new NativeI18n(gateway);useNativeI18n(catalog);await until(()=>catalog.language==='en','English unavailable');const project=(await facts()).project;
  for(const room of [{chatId:1,name:'Main'},{chatId:project.chat_id,projectId:project.id,name:project.name}]){const page=new ChatPage(win,gateway,room,()=>{},id=>opened.push(id));pages.push(page);body.append(page.widget)}
  await until(async()=>(await facts()).peers===2,'two live chat peers absent');await control('progress-seed');
  await until(()=>views(pages[0]).some(v=>readSkillProgress(v.raw)?.job.status==='running'),'live native progress absent');
  const actual=(await facts()).frames.find(f=>f.lifecycle?.status==='running');check(actual&&episodeTask(actual)===undefined,'synthetic lifecycle task became ordinary episode');
  const running=views(pages[0]).find(v=>readSkillProgress(v.raw)?.job.status==='running');running.widget.expanded=true;
  for(const value of ['review-skill <&> Ω','private-group <&>','operation-task','root-task','origin-task','origin-root','presentation-task','running','Main (1)'])check(texts(running.widget).includes(value),'missing operation provenance '+value);
  check(!all(pages[0].widget,w=>w instanceof Gtk.Button&&w.label==='Открыть задачу').length,'synthetic progress offered ordinary task navigation');
  stage='actual cross-chat duplicate pointer';await control('duplicate',{chat_id:project.chat_id});await until(()=>pointer(pages[1]),'duplicate pointer absent from project chat');
  const reference=pointer(pages[1]),entry=readSkillProgress(reference.raw);reference.widget.expanded=true;
  check(entry.pointer&&entry.job.id===actual.lifecycle.id&&entry.job.chat_id===1,'pointer lost job/original chat identity');
  check(texts(reference.widget).includes('existing operation')&&texts(reference.widget).includes('Main (1)'),'duplicate ack implies independent job or wrong route');
  check(!pointer(pages[0]),'pointer leaked into original chat');check((await facts()).duplicate_runners.length===0,'duplicate executed second runner');
  const links=all(reference.widget,w=>w instanceof Gtk.Button),task=links.find(w=>w.label==='Open task · origin-task');check(task?.sensitive,'domain origin task link absent');task.emit('clicked');check(opened.at(-1)==='origin-task','wrong domain task opened');
  const reviews=links.find(w=>w.label==='Read current task reviews · presentation-task');check(reviews?.sensitive,'typed review owner navigation absent');reviews.emit('clicked');await until(async()=>(await facts()).audit.some(r=>r.path==='/api/tasks/presentation-task/reviews'),'review link did not use actual owner GET');win.get_visible_dialog()?.force_close();
  stage='history refresh preserves expansion and invalidates prior actions';const old=reference,oldTask=task,count=opened.length;pages[1].rendered='';pages[1].refresh();await until(()=>pointer(pages[1])!==old,'canonical history did not replace pointer view');check(pointer(pages[1]).widget.expanded,'history refresh lost pointer expansion');oldTask.emit('clicked');check(opened.length===count,'detached pointer retained actions');
  const history=await observer.json('GET','/api/chat/history?chat_id='+project.chat_id);check((history.messages??history.rows).some(r=>r.lifecycle_pointer||r.progress_meta?.lifecycle_pointer),'actual HTTP history dropped pointer metadata');
  await control('duplicate',{chat_id:0});const panel=(await facts()).frames.find(f=>f.chat_id===0&&f.lifecycle_pointer);check(panel&&readSkillProgress(panel).job.chat_id===1,'panel initiator was dropped or confused with Main');
  const panelView=new SkillProgressView(panel,id=>opened.push(id));controlled.push(panelView);body.append(panelView.widget);check(texts(panelView.widget.get_child()).includes('Main (1)'),'panel pointer fabricated progress chat 0');
  stage='terminal progress is separate from stale pointer';await control('release',{name:'review-skill <&> Ω'});await until(()=>views(pages[0]).some(v=>readSkillProgress(v.raw)?.job.status==='succeeded'),'real terminal progress absent');check(readSkillProgress(pointer(pages[1]).raw).job.status==='running','old pointer fabricated fresh terminal state');
  stage='read guard and compatibility';const raw=entry.job,good={lifecycle_pointer:{...raw,job_id:raw.id}};
  for(const bad of [{lifecycle_pointer:[]},{lifecycle_pointer:null},{lifecycle_pointer:{...good.lifecycle_pointer,job_id:9}},{lifecycle_pointer:{...good.lifecycle_pointer,chat_id:'1'}},{lifecycle_pointer:{...good.lifecycle_pointer,origin_task_id:{}}},{lifecycle_pointer:{...good.lifecycle_pointer,status:[]}}, {...good,lifecycle:{...raw}}, {lifecycle:{...raw,phase:{}}}]){
   let rejected=false;try{readSkillProgress(bad)}catch{rejected=true}check(rejected,'bad metadata accepted');const v=new SkillProgressView(bad,id=>opened.push(id));controlled.push(v);check(!all(v.widget.get_child(),w=>w instanceof Gtk.Button).length&&texts(v.widget.get_child()).includes('could not be read'),'bad metadata offered task/review links');v.close();
  }
  const future=new SkillProgressView({progress_meta:{lifecycle_pointer:{...good.lifecycle_pointer,status:'constructor',kind:'future-operation',target:'private skill <&> Ω'+'x'.repeat(2000),chat_id:0}}},id=>opened.push(id),id=>opened.push(id));controlled.push(future);body.append(future.widget);future.widget.expanded=true;check(texts(future.widget).includes('constructor')&&texts(future.widget).includes('Skill Review panel (0)')&&!all(future.widget,w=>w instanceof Gtk.Button&&w.label.startsWith('Read current')).length,'future status/panel or review gate wrong');
  for(const label of all(future.widget,w=>w instanceof Gtk.Label))check(!label.use_markup&&label.measure(Gtk.Orientation.HORIZONTAL,-1)[0]<680,'literal metadata broke width/markup');
  const incomplete=new SkillProgressView({lifecycle_pointer:{job_id:'job',kind:'review',target:'skill',status:'queued'}},undefined,()=>{});controlled.push(incomplete);check(!all(incomplete.widget,w=>w instanceof Gtk.Button).length,'incomplete review pointer guessed owner');
  stage='live locale, private values and close';const latest=pointer(pages[1]);latest.widget.expanded=true;const imported=await gateway.json('POST','/api/ui/i18n/import',{language:'qaa',entries:{'Existing skill operation reference':{text:'QAA reference'},'Operation source · {value}':{text:'QAA source · {value}'},'Open task · {id}':{text:'QAA task · {id}'}}});await gateway.json('POST','/api/ui/i18n/language',{language:'qaa',profile:{direction:'rtl'}});catalog.frame({type:'ui_language_changed',language:'qaa'});catalog.frame({type:'ui_i18n_updated',language:'qaa',revision:imported.revision});await until(()=>pointer(pages[1]).widget.label==='QAA reference','pointer live locale absent');const local=pointer(pages[1]);check(local.widget.expanded&&local.widget.get_direction()===Gtk.TextDirection.RTL&&texts(local.widget).includes('QAA source')&&texts(local.widget).includes('private-source <&>'),'locale lost disclosure/private data');
  await until(async()=>(await facts()).audit.some(r=>r.path==='/api/ui/i18n/missing'&&r.body),'missing reports absent');check(!(await facts()).audit.some(r=>r.path==='/api/ui/i18n/missing'&&JSON.stringify(r.body).includes('private-source')),'private value leaked to i18n keys');
  const held=all(local.widget,w=>w instanceof Gtk.Button&&w.label==='QAA task · origin-task')[0],before=opened.length;await pages[1].close();held.emit('clicked');check(opened.length===before,'closed ChatPage retained pointer action');
  check((await facts()).audit.filter(r=>r.method!=='GET').every(r=>r.path.startsWith('/api/ui/i18n/')),'native progress sent mutating API');
  print('OK: actual lifecycle lane/bridge and live Main/project WS plus canonical history: progress states/provenance, cross-chat and panel duplicate acknowledgements without second runner/task, original chat retained, exact domain links and actual review owner GET, stale pointer separate from terminal, expansion preserved and stale callbacks disabled; optional/future/malformed metadata, literal long text, QAA/RTL/private keys and close; inert runners, no model/skill mutation');
 })().catch(error=>{failed=true;logError(error);print('Stage: '+stage)}).finally(async()=>{await control('release-all').catch(()=>{});for(const v of controlled)v.close();await Promise.all(pages.map(p=>p.close()));catalog?.close();useNativeI18n();gateway.close();observer.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
