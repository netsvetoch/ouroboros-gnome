import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';

const base=ARGV[0],url=ARGV[1],run=ARGV[2];
const {Gateway}=await import(base+'gateway.js');
const {RoomCognition}=await import(base+'room-cognition.js');
const {ServerSettings}=await import(base+'settings.js');
const {ownerHeaders}=await import(base+'settings-write.js');
const check=(value,message)=>{if(!value)throw new Error(message)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,message){for(let i=0;i<1000;i++){if(await fn())return;await wait(20)}throw new Error(message)}
function all(widget,predicate){let result=predicate(widget)?[widget]:[];for(let child=widget.get_first_child?.();child;child=child.get_next_sibling())result.push(...all(child,predicate));return result}
const click=(root,caption)=>{const button=all(root,w=>w instanceof Gtk.Button&&w.label===caption)[0];check(button?.sensitive,'button unavailable: '+caption);button.emit('clicked')};
const row=(root,title)=>{const label=all(root,w=>w instanceof Gtk.Label&&w.get_text()===title)[0];check(label,'field missing: '+title);return label.get_parent()};
const select=(root,title,value)=>{
 const field=row(root,title),control=all(field,w=>w instanceof Gtk.DropDown)[0];check(control,'choice missing: '+title);
 const model=control.get_model();let index=-1;for(let i=0;i<model.get_n_items();i++)if(model.get_string(i)===value)index=i;
 check(index>=0,'option missing: '+title+' = '+value);control.set_selected(index);return field;
};
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.OwnerTests',flags:Gio.ApplicationFlags.NON_UNIQUE});
let failed=false,settings,cognition,stage='',confirmReload=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1000,default_height:800});win.present();
 const gateway=new Gateway(url,'fixture-secret'),facts=()=>gateway.json('GET','/fixture/facts');
 const original=Adw.AlertDialog.prototype.present;
 Adw.AlertDialog.prototype.present=function(parent){original.call(this,parent);if(confirmReload&&this.heading==='Перечитать настройки?'){confirmReload=false;GLib.idle_add(0,()=>{this.emit('response','ok');this.close();return GLib.SOURCE_REMOVE})}};
 (async()=>{
  stage='settings load';cognition=new RoomCognition(gateway);settings=new ServerSettings(win,gateway,undefined,undefined,undefined,cognition);settings.show();
  await until(()=>settings.snapshot&&!settings.busy,'settings not loaded');
  async function stageNumber(value){settings.edit('OUROBOROS_MAX_WORKERS');const dialog=[...settings.children].at(-1);all(dialog.get_child(),w=>w instanceof Gtk.Entry)[0].set_text(String(value));click(dialog.get_child(),'Применить в форме');check(Number(settings.pending.get('OUROBOROS_MAX_WORKERS'))===value,'numeric edit not staged')}
  stage='generic save';await stageNumber(5);settings.saveButton.emit('clicked');
  await until(async()=>!settings.busy&&(await facts()).settings.OUROBOROS_MAX_WORKERS===5,'generic setting did not persist');
  check(settings.pending.size===0,'acknowledged patch remained pending');
  stage='unavailable connection receipt';
  const fallback='openrouter@gnome-missing::fixture/model,openai@gnome-other::fixture/model';
  settings.stageSettings({OUROBOROS_MODEL_FALLBACKS:fallback});settings.saveButton.emit('clicked');
  await until(()=>!settings.busy&&settings.snapshot.OUROBOROS_MODEL_FALLBACKS===fallback,'fallback routes were not saved');
  const warning=settings.status.get_text();
  check(warning.includes('Параметры сохранены.')&&warning.includes('не могут отправлять запросы'),'saved but unusable route not disclosed');
  for(const [index,route,connection] of [['1','openrouter@gnome-missing::fixture/model','openrouter@gnome-missing'],['2','openai@gnome-other::fixture/model','openai@gnome-other']])
    check(warning.includes(['OUROBOROS_MODEL_FALLBACKS',index,route,connection,'missing'].join(' · ')),'connection receipt lost fallback identity: '+index);
  check(settings.pending.size===0,'connection warning incorrectly treated as an unsaved change');
  check(all(settings.dialog.get_child(),w=>w instanceof Gtk.Label&&w.get_text().includes('не могут отправлять запросы')).length,'connection warning not visible in native settings');
  settings.stageSettings({OUROBOROS_MODEL_FALLBACKS:''});settings.saveButton.emit('clicked');
  await until(()=>!settings.busy&&settings.snapshot.OUROBOROS_MODEL_FALLBACKS==='','fallback cleanup did not persist');
  check(!settings.status.get_text().includes('не могут отправлять запросы'),'resolved connection warning remained in next receipt');
  stage='generic conflict';await stageNumber(6);await gateway.json('POST','/api/settings',{OUROBOROS_MAX_WORKERS:7},ownerHeaders);
  const before=(await facts()).audit.filter(x=>x.path==='/api/settings'&&x.method==='POST').length;settings.saveButton.emit('clicked');
  await until(()=>!settings.busy&&settings.status.get_text().includes('изменились на шлюзе'),'concurrent settings change not detected');
  const conflict=await facts();check(conflict.settings.OUROBOROS_MAX_WORKERS===7&&Number(settings.pending.get('OUROBOROS_MAX_WORKERS'))===6,'conflict lost server value or local patch');
  check(conflict.audit.filter(x=>x.path==='/api/settings'&&x.method==='POST').length===before,'stale generic patch was sent');
  confirmReload=true;click(settings.dialog.get_child(),'Перечитать');await until(()=>!settings.busy&&settings.pending.size===0&&settings.snapshot.OUROBOROS_MAX_WORKERS===7,'confirmed reload did not reconcile values');

  stage='owner load';click(settings.dialog.get_child(),'Управление владельца…');const owner=settings.owner;
  await until(()=>owner.snapshot&&!owner.busy,'owner settings not loaded');await cognition.refresh();
  check(cognition.availability==='available','fixture catalog did not expose subagent choice');
  const choose=async(title,value)=>{const field=select(owner.body,title,value);click(field,'Сохранить');await until(()=>!owner.busy,'owner write did not settle: '+title)};
  stage='runtime';await choose('Режим доступа','advanced');check((await facts()).settings.OUROBOROS_RUNTIME_MODE==='advanced','runtime choice not saved');
  check(owner.status.get_text().includes('после перезапуска'),'restart-bound runtime choice not disclosed');
  stage='access';await choose('Автовыдача разрешений проверенным навыкам','on');check(String((await facts()).settings.OUROBOROS_AUTO_GRANT_REVIEWED_SKILLS)==='true','auto grant choice not saved');
  stage='safety';await choose('Безопасность задач владельца','light');await choose('Безопасность фоновой работы','off');
  let field=row(owner.body,'Правила безопасности владельца');all(field,w=>w instanceof Gtk.TextView)[0].get_buffer().set_text('Правило GNOME 🔧\nСохранить <буквальный> текст.',-1);click(field,'Сохранить правила');await until(()=>!owner.busy,'safety rules did not settle');
  field=row(owner.body,'Модель Safety Supervisor');all(field,w=>w instanceof Gtk.Entry)[0].set_text('fixture/safety');click(field,'Сохранить');await until(()=>!owner.busy,'safety model did not settle');
  let saved=(await facts()).settings;check(saved.OUROBOROS_SAFETY_MODE==='light'&&saved.OUROBOROS_CONSCIOUSNESS_SAFETY_MODE==='off'&&saved.OUROBOROS_MODEL_SAFETY==='fixture/safety'&&saved.OUROBOROS_SAFETY_OWNER_RULES==='Правило GNOME 🔧\nСохранить <буквальный> текст.','safety changes differ from native fields');
  await until(()=>!settings.busy&&settings.snapshot.OUROBOROS_SAFETY_OWNER_RULES===saved.OUROBOROS_SAFETY_OWNER_RULES,'parent settings did not refresh owner rules');
  const literal=all(settings.listBox,w=>w instanceof Adw.ActionRow&&w.subtitle?.includes(saved.OUROBOROS_SAFETY_OWNER_RULES))[0];
  check(literal&&!literal.use_markup&&all(literal,w=>w instanceof Gtk.Label&&w.get_text().includes('<буквальный>')).length,'settings list did not show literal owner rules');

  stage='Main cognition';await choose('Контекст','nano');await choose('Режим субагентов','swarm');
  const setRange=(min,recommended,max)=>{for(const [name,value] of [['Минимальное усилие',min],['Рекомендуемое усилие',recommended],['Максимальное усилие',max]])select(owner.body,name,value)};
  setRange('high','none','ultra');click(owner.body,'Сохранить диапазон усилия');await until(()=>!owner.busy,'Main effort save did not settle');
  saved=(await facts()).settings;check(saved.OUROBOROS_CONTEXT_MODE==='nano'&&saved.OUROBOROS_SUBAGENTS_MODE==='swarm'&&saved.OUROBOROS_EFFORT_MIN==='high'&&saved.OUROBOROS_EFFORT_TASK==='none'&&saved.OUROBOROS_EFFORT_MAX==='ultra','Main cognition values differ');
  check(cognition.get('')?.effort_range?.recommended==='none','Main cognition cache did not update from reply');
  const writes=(await facts()).audit.filter(x=>x.method==='POST').length;setRange('ultra','medium','none');click(owner.body,'Сохранить диапазон усилия');await wait(80);
  check(owner.status.get_text().includes('Минимальное усилие')&&(await facts()).audit.filter(x=>x.method==='POST').length===writes,'invalid helper range reached the API');
  select(owner.body,'Минимальное усилие','high');select(owner.body,'Максимальное усилие','ultra');

  stage='project cognition';const room=all(owner.body,w=>w instanceof Gtk.DropDown&&w.get_model()?.get_string?.(0)==='Main')[0];check(room,'room choice absent');room.set_selected(1);
  await choose('Контекст','low');await choose('Режим субагентов','off');setRange('minimal','ultra','medium');click(owner.body,'Сохранить диапазон усилия');await until(()=>!owner.busy,'project effort save did not settle');
  const final=await facts(),project=final.projects.find(p=>p.id==='fixture-project');
  check(project.cognition.context_mode==='low'&&project.cognition.subagents_mode==='off'&&project.cognition.effort_range.min==='minimal'&&project.cognition.effort_range.recommended==='ultra'&&project.cognition.effort_range.max==='medium','project cognition values differ');
  check(final.settings.OUROBOROS_CONTEXT_MODE==='nano'&&final.settings.OUROBOROS_SUBAGENTS_MODE==='swarm'&&final.settings.OUROBOROS_EFFORT_MIN==='high'&&final.settings.OUROBOROS_EFFORT_TASK==='none','project write changed Main');
  check(cognition.get('fixture-project')?.context_mode==='low'&&cognition.get('')?.context_mode==='nano','cognition scopes merged');
  const access=(await gateway.json('GET','/api/settings'))._meta.policy_state.access;
  check(access.configured==='advanced'&&access.effective==='light'&&access.restart_required===true,'subsequent settings writes erased the restart-bound access baseline');
  const ownerWrites=final.audit.filter(x=>x.method==='POST'&&x.path.startsWith('/api/owner/'));check(ownerWrites.every(x=>x.surface==='app'&&x.actor==='owner'),'owner attribution headers missing');
  const expected=['runtime-mode','auto-grant','safety-mode','safety-rules','safety-model','context-mode','subagents-mode','effort-range'];
  for(const endpoint of expected)check(ownerWrites.some(x=>x.path==='/api/owner/'+endpoint&&x.status===200),'owner route not successfully observed: '+endpoint);
  check(!all(owner.dialog.get_child(),w=>String(w.constructor.name).includes('WebView')).length,'browser mounted in owner settings');
  if(!GLib.getenv('FLATPAK_ID')&&GLib.find_program_in_path('import')){await wait(100);Gio.Subprocess.new(['import','-window','root',run+'/owner.png'],Gio.SubprocessFlags.NONE).wait_check(null)}
  print('OK: real router generic settings save/concurrent conflict/reload; unavailable connection receipts preserve both fallback positions and saved status, clear after repair; eight owner POST routes, runtime restart receipt, auto grant, safety modes/rules/model, separate Main/project context/subagents/effort, independent recommended effort, invalid range refusal and owner headers; native GTK');
 })().catch(async error=>{failed=true;logError(error);print('Stage: '+stage);try{print(JSON.stringify(await facts()))}catch{}}).finally(()=>{settings?.close();cognition?.close();gateway.close();Adw.AlertDialog.prototype.present=original;win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
