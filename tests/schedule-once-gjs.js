import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {SchedulesPage}=await import(ARGV[0]+'schedules.js');
const {TasksPage}=await import(ARGV[0]+'tasks.js');
const check=(x,m)=>{if(!x)throw new Error(m)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,message){for(let i=0;i<700;i++){if(await fn())return;await wait(20)}throw new Error(message)}
function all(w,p){let out=p(w)?[w]:[];for(let c=w.get_first_child?.();c;c=c.get_next_sibling())out.push(...all(c,p));return out}
const text=d=>all(d.get_child(),w=>w instanceof Gtk.Label).map(w=>w.get_text()).join('\n');
const button=(d,caption)=>all(d.get_child(),w=>w instanceof Gtk.Button&&w.label===caption)[0];
const click=(d,caption)=>{const b=button(d,caption);check(b?.is_sensitive(),'missing/disabled button '+caption);b.emit('clicked')};
const field=(d,title)=>{const e=all(d.get_child(),w=>w instanceof Adw.EntryRow&&w.title===title)[0];check(e,'missing field '+title);return e};
const enabled=d=>all(d.get_child(),w=>w instanceof Gtk.CheckButton&&w.label==='Запускать по расписанию')[0];
const area=(d,key)=>{const view=all(d.get_child(),w=>w instanceof Gtk.TextView&&w.get_name()==='schedule-'+key)[0];check(view,'missing schedule field '+key);return view.buffer};
const setArea=(d,key,value)=>area(d,key).set_text(value,-1);
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.ScheduleOnceTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const gateway=new Gateway(ARGV[1],'fixture-secret');const win=new Adw.ApplicationWindow({application:app,default_width:1050,default_height:900});let page,tasks,stage='create due once schedule';const opened=[];
 const facts=()=>gateway.json('GET','/fixture/facts');const tick=()=>gateway.json('POST','/fixture/control',{action:'tick'});const latest=()=>[...page.dialogs].at(-1);
 (async()=>{
  tasks=new TasksPage(win,gateway,()=>({name:'Main',chatId:1}),()=>{});
  page=new SchedulesPage(win,gateway,()=>({name:'Main',chatId:1}),()=>[],id=>{opened.push(id);tasks.show(id)});win.set_content(page.widget);win.present();await page.refresh();
  page.edit();let d=latest();field(d,'Название').text='Once native <&> 🔧';
  const instruction='  Scheduled native objective <&> 🔧\n';all(d.get_child(),w=>w instanceof Gtk.TextView)[0].buffer.set_text(instruction,-1);
  for(const expander of all(d.get_child(),w=>w instanceof Gtk.Expander))expander.expanded=true;
  const context='  Native context <&>\nSecond line 🔧\n',expected='  Expected native output 🔧\n',constraints='  Keep literal <&> constraints\n';
  setArea(d,'context',context);setArea(d,'expected_output',expected);setArea(d,'constraints',constraints);field(d,'Предельный срок задания ISO 8601').text='2099-01-01T00:00:00+00:00';
  const resources={network:false,fixture_resource:'native-value'},contract={answer_protocol:'final_answer_line',disabled_tools:['fixture_disabled']};
  const attachments=[{status:'staged',label:'Native input <&>',root:'repo',relpath:'native-input.txt',abs_path:(await facts()).attachment}];
  setArea(d,'allowed_resources',JSON.stringify(resources));setArea(d,'attachments',JSON.stringify(attachments));setArea(d,'task_contract',JSON.stringify(contract));
  const kind=all(d.get_child(),w=>w instanceof Gtk.DropDown).find(w=>w.get_model().get_string(0)==='Повторяется (cron)');kind.set_selected(1);
  const due=GLib.DateTime.new_now_utc().add_minutes(-2).format('%Y-%m-%dT%H:%M:%S+00:00');field(d,'Дата и время со смещением UTC').text=due;field(d,'Часовой пояс IANA').text='UTC';
  stage='native advanced field validation';for(const [key,bad] of [['allowed_resources','[]'],['attachments','{}'],['task_contract','[]']]){const old={allowed_resources:resources,attachments,task_contract:contract}[key];setArea(d,key,bad);click(d,'Сохранить расписание');check(text(d).includes('Поле «'+key+'» должно'),'invalid JSON field shape not rejected');setArea(d,key,JSON.stringify(old))}
  field(d,'Предельный срок задания ISO 8601').text='2099-01-01T00:00:00';click(d,'Сохранить расписание');check(text(d).includes('Предельный срок задания должен'),'deadline without timezone accepted');field(d,'Предельный срок задания ISO 8601').text='2099-01-01T00:00:00+00:00';check((await facts()).audit.every(r=>r.method==='GET'),'invalid native advanced field submitted');
  if(!GLib.getenv('FLATPAK_ID')&&GLib.find_program_in_path('import')){
   const scroller=all(d.get_child(),w=>w instanceof Gtk.ScrolledWindow)[0];
   for(const [name,value] of [['schedule-fields',0],['schedule-fields-bottom',Number.MAX_SAFE_INTEGER]]){
    scroller.vadjustment.value=value;win.queue_draw();await new Promise(resolve=>{let frames=0;win.add_tick_callback(()=>{if(++frames<3)return GLib.SOURCE_CONTINUE;resolve();return GLib.SOURCE_REMOVE})});await wait(80);
    Gio.Subprocess.new(['import','-window','root',ARGV[2]+'/'+name+'.png'],Gio.SubprocessFlags.NONE).wait_check(null);
   }
  }
  click(d,'Сохранить расписание');await until(()=>!page.dialogs.has(d),'once definition not saved');await page.refresh();check(page.rows.size===1,'saved once not returned');let item=[...page.rows.values()][0];const sid=item.id;
  check(item.enabled&&item.trigger.type==='once'&&!item.completed_at,'once initially consumed');check((await facts()).pending.length===0,'saving immediately admitted work');
  check(item.task.context===context&&item.task.expected_output===expected&&item.task.constraints===constraints&&item.task.deadline_at==='2099-01-01T00:00:00+00:00'&&JSON.stringify(item.task.allowed_resources)===JSON.stringify(resources)&&JSON.stringify(item.task.attachments)===JSON.stringify(attachments)&&JSON.stringify(item.task.task_contract)===JSON.stringify(contract),'advanced template fields not saved');
  stage='actual scheduled occurrence admission';await tick();await page.refresh();let state=await facts();item=page.rows.get(sid);
  check(state.pending.length===1,'due schedule did not admit exactly one task: '+JSON.stringify(state.store));const task=state.pending[0],tid=task.id;
  check(item.status==='consumed'&&item.completed_at&&item.enabled===false&&item.last_task_id===tid,'committed admission did not consume once schedule');
  check(task.text===instruction&&task.metadata.schedule_id===sid,'scheduled admission changed objective or schedule identity');
  check(task.context===context&&task.expected_output===expected&&task.constraints===constraints&&task.deadline_at==='2099-01-01T00:00:00+00:00'&&task.allowed_resources.network===false&&task.allowed_resources.fixture_resource==='native-value'&&task.attachments[0].abs_path===attachments[0].abs_path&&task.task_contract.answer_protocol==='final_answer_line'&&task.task_contract.disabled_tools.includes('fixture_disabled'),'planner lost advanced template fields');
  check(state.records[tid]?.status==='scheduled'&&state.records[tid].schedule_admission?.status==='accepted'
   &&state.records[tid].schedule_admission?.dispatch==='none','scheduled admission receipt not persisted');
  stage='repeated scheduler pass cannot refire';await tick();await tick();state=await facts();check(state.pending.length===1&&state.pending[0].id===tid,'consumed once schedule fired again');
  page.details(item);d=latest();check(text(d).includes('Однократный запуск состоялся')&&!button(d,'Включить…'),'consumed schedule offers simple re-enable');click(d,'Открыть последнюю задачу');check(opened.at(-1)===tid,'last admitted task navigation wrong');d.force_close();
  const detail=tasks.openDetails.get(tid);await until(()=>detail?.task&&!detail.readStatus.label,'scheduled task detail failed to load');check(detail.task.status==='scheduled'&&text(detail.dialog).includes('Запланирована')&&text(detail.dialog).includes(instruction),'native task detail lost scheduled state or objective');detail.close();
  stage='same consumed instant cannot rearm';page.edit(item);d=latest();enabled(d).active=true;const before=state.audit.filter(r=>r.method==='POST').length;click(d,'Сохранить расписание');check(text(d).includes('Уже выполненный запуск требует нового времени.'),'same consumed instant accepted');check((await facts()).audit.filter(r=>r.method==='POST').length===before,'same consumed time sent an upsert');
  stage='equivalent offset instant cannot rearm';const equivalent=GLib.DateTime.new_from_iso8601(item.trigger.run_at,GLib.TimeZone.new_utc()).to_timezone(GLib.TimeZone.new_identifier('Europe/Moscow')).format('%Y-%m-%dT%H:%M:%S%:z');field(d,'Дата и время со смещением UTC').text=equivalent;click(d,'Сохранить расписание');check(text(d).includes('Уже выполненный запуск требует нового времени.'),'equivalent timezone instant bypassed consumed guard');
  stage='explicit new future time rearms without replay';const future=GLib.DateTime.new_now_utc().add_hours(1).format('%Y-%m-%dT%H:%M:%S+00:00');field(d,'Дата и время со смещением UTC').text=future;click(d,'Сохранить расписание');await until(()=>!page.dialogs.has(d),'new time did not rearm');await page.refresh();item=page.rows.get(sid);state=await facts();
  check(item.enabled===true&&!item.completed_at&&item.trigger.run_at.startsWith(future.slice(0,19))&&item.last_task_id===tid,'rearm lost previous admission or consumed receipt not reset');await tick();state=await facts();check(state.pending.length===1&&state.pending[0].id===tid,'future rearm duplicated queued work');
  check(item.task.context===context&&item.task.expected_output===expected&&item.task.constraints===constraints&&JSON.stringify(item.task.attachments)===JSON.stringify(attachments),'unrelated rearm lost advanced template fields');
  stage='explicit clear of advanced template fields';page.edit(item);d=latest();for(const expander of all(d.get_child(),w=>w instanceof Gtk.Expander))expander.expanded=true;for(const key of ['context','expected_output','constraints','allowed_resources','attachments','task_contract'])setArea(d,key,'');field(d,'Предельный срок задания ISO 8601').text='';click(d,'Сохранить расписание');await until(()=>!page.dialogs.has(d),'cleared advanced fields not saved');await page.refresh();item=page.rows.get(sid);for(const key of ['context','expected_output','constraints','deadline_at','allowed_resources','attachments','task_contract'])check(item.task[key]===undefined,'cleared template field retained: '+key);state=await facts();check(state.pending[0].expected_output===expected&&state.pending[0].constraints===constraints,'template edit changed already admitted task');
  check(state.audit.every(r=>r.method==='GET'||r.path==='/api/schedules'),'native once scenario used unexpected write route');
  print('OK: native once form through real schedule upsert and occurrence planner/admission; one queued task with verbatim objective and persisted accepted/dispatch-none receipt, consumed receipt and no refire across scheduler passes, native task details, advanced context/output/constraints/deadline/resources/attachments/contract validation, preservation and explicit clearing, same/equivalent instant refusal, explicit new future instant rearm retaining prior run; inert workers, no task execution or provider calls');
 })().catch(e=>{failed=true;logError(e);print('Stage: '+stage)}).finally(()=>{tasks?.close();page?.close();gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
