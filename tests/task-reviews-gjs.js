import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {TaskReviews}=await import(ARGV[0]+'task-reviews.js');
const {renderReviewExecution}=await import(ARGV[0]+'review-execution.js');
const check=(value,message)=>{if(!value)throw new Error(message)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,message){for(let i=0;i<1000;i++){if(fn())return;await wait(20)}throw new Error(message)}
function all(widget,predicate){let result=predicate(widget)?[widget]:[];for(let child=widget.get_first_child?.();child;child=child.get_next_sibling())result.push(...all(child,predicate));return result}
const labels=root=>all(root,w=>w instanceof Gtk.Label).map(w=>w.label).join('\n');
const press=(root,caption)=>{const button=all(root,w=>w instanceof Gtk.Button&&w.label===caption)[0];check(button?.sensitive,'button unavailable: '+caption);button.emit('clicked')};
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.ReviewTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1000,default_height:850});win.present();
 const gateway=new Gateway(ARGV[1],'fixture-secret'),reviews=new TaskReviews(gateway);let stage='native ledger projection';
 const save=Gtk.FileDialog.prototype.save,finish=Gtk.FileDialog.prototype.save_finish;
 let chooseMode='normal',chooseCount=0,heldChooser,heldWrite,writeCancel,sourceReads=0;
 const exportSource=gateway.reviewExport.bind(gateway);gateway.reviewExport=(...args)=>{sourceReads++;return exportSource(...args)};
 Gtk.FileDialog.prototype.save=function(parent,cancel,callback){check(parent===win,'review chooser parent differs');check(cancel instanceof Gio.Cancellable,'review chooser cancellation absent');chooseCount++;this.fixtureCancel=cancel;const complete=()=>callback(this,null);if(chooseMode==='hold-chooser')heldChooser={cancel,complete};else GLib.idle_add(0,()=>{complete();return GLib.SOURCE_REMOVE})};
 Gtk.FileDialog.prototype.save_finish=function(){
  if(this.fixtureCancel.is_cancelled())throw new Error('Fixture chooser cancelled');
  if(chooseMode==='directory')return Gio.File.new_for_path(ARGV[2]);
  const file=Gio.File.new_for_path(ARGV[2]+(chooseMode==='hold-write'?'/cancelled-write.txt':chooseMode==='hold-chooser'?'/cancelled-chooser.txt':'/review.txt'));
  if(chooseMode!=='hold-write')return file;
  return {replace_contents_bytes_async(...args){writeCancel=args[4];heldWrite=()=>file.replace_contents_bytes_async(...args)},replace_contents_finish(result){return file.replace_contents_finish(result)}};
 };
 (async()=>{
  const fixture=await gateway.json('GET','/fixture/facts');reviews.history(win,'review-root');const dialog=[...reviews.dialogs][0],root=dialog.get_child();
  const panels=()=>all(root,w=>w instanceof Gtk.Expander&&w.label.includes('commit_gate'));
  await until(()=>panels().length===20,'initial native history page not loaded');
  for(const panel of panels())panel.expanded=true;
  const text=labels(root);
  check(text.includes('Неограниченный повтор <&>')&&text.includes('Повторяется бесконечно')&&text.includes('Наблюдение GNOME')&&text.includes('Ограничить число повторов'),'native projection lost finding item/reason/evidence/recommendation');
  check(text.includes('Замечаний за пределами списка · 4')&&text.includes('Раздел · change')&&text.includes('Проверка состава <&>'),'native projection hid omission, section verdict or panel composition');
  check(text.includes('Запрошенная модель · fixture/requested')&&text.includes('Модель не указана')&&text.includes('Ответ не учитывается в кворуме'),'requested model was presented as observed or failed reviewer counted in quorum');
  for(const panel of all(root,w=>w instanceof Gtk.Expander&&w.label==='Подробности отказа'))panel.expanded=true;
  const failures=labels(root);
  for(const value of ['Наблюдаемая модель · fixture/reviewer','Наблюдаемая модель не сообщена.','Наблюдение исполнения · api · fixture/reviewer',
    'Операция ревью · provider_refused','Код отказа · fixture_capacity','HTTP-статус · 429','Сброс лимита · 2026-11-13T08:00:00Z','Сообщённая причина · Capacity <&> exhausted','retry_after_seconds'])check(failures.includes(value),'review execution/failure fact missing: '+value);
  check(!failures.includes(fixture.secret),'failure facts exposed unredacted provider secret');
  stage='typed execution rendering';const isolated=new Gtk.Box({orientation:Gtk.Orientation.VERTICAL});
  renderReviewExecution(isolated,{requested_model:'must-not-be-observed',executions:[{kind:'future <&> runner',model:'private-run <&> Ω'},null,{kind:'api',model:42}],failure_details:[],http_status:{}});
  check(labels(isolated).includes('private-run <&> Ω')&&labels(isolated).includes('Часть сведений об исполнении')&&!labels(isolated).includes('must-not-be-observed'),'malformed/unknown execution rendering inferred a requested route or lost healthy evidence');
  const duplicate=new Gtk.Box({orientation:Gtk.Orientation.VERTICAL});renderReviewExecution(duplicate,{executions:[{kind:'api',model:'same'}],execution:{kind:'api',model:'same'}});
  check(all(duplicate,w=>w instanceof Gtk.Label&&w.label==='Наблюдение исполнения · api · same').length===1,'legacy execution duplicate shown twice');
  press(root,'Следующая страница');await until(()=>panels().length===21&&labels(root).includes(fixture.records[1].id),'second page or missing-record disclosure not loaded');
  for(const panel of panels())panel.expanded=true;
  check(!all(root,w=>w instanceof Gtk.Button&&w.label==='Следующая страница'&&w.visible).length,'completed archive retained next page');
  const selected=panels().find(panel=>panel.label.includes(fixture.records[0].id));check(selected,'first record missing after paging');
  press(selected,'Сохранённый ответ · change…');let document=[...reviews.dialogs].at(-1),documentRoot=document.get_child();
  const buffer=()=>all(documentRoot,w=>w instanceof Gtk.TextView)[0].buffer;
  const content=()=>buffer().get_text(buffer().get_start_iter(),buffer().get_end_iter(),false);
  await until(()=>content()===fixture.normal,'full saved response including tail not loaded');
  press(documentRoot,'Скачать текст…');await until(()=>labels(documentRoot).includes('Текст сохранён.'),'native review download stalled');
  const [,saved]=GLib.file_get_contents(ARGV[2]+'/review.txt');check(new TextDecoder().decode(saved)===fixture.normal,'download differs from verified native source');
  stage='changed source refusal';await gateway.json('POST','/fixture/tamper',{});press(documentRoot,'Перечитать текст');await until(()=>labels(documentRoot).includes('review_source_unavailable')||labels(documentRoot).includes('integrity check'),'tampered source not refused');
  check(content()===''&&!all(documentRoot,w=>w instanceof Gtk.Button&&w.label==='Скачать текст…')[0].sensitive,'failed source left stale export enabled');document.force_close();
  stage='redacted source export';const redacted=panels().find(panel=>panel.label.includes(fixture.records[21].id));press(redacted,'Сохранённый ответ · change…');document=[...reviews.dialogs].at(-1);documentRoot=document.get_child();
  await until(()=>content()===fixture.records[21].public,'redacted native source not accepted with distinct source/export checksums');check(!content().includes(fixture.secret)&&content().endsWith('REDACTED-TAIL'),'redacted export leaked fixture secret or lost tail');
  document.force_close();
  stage='native plan source';reviews.history(win,'plan-root',undefined,true);const planDialog=[...reviews.dialogs].at(-1),planRoot=planDialog.get_child();
  await until(()=>all(planRoot,w=>w instanceof Gtk.Expander&&w.label==='Реплики к плану').length===1,'native plan hydration failed');
  const expandAll=root=>{for(let i=0;i<4;i++)for(const panel of all(root,w=>w instanceof Gtk.Expander))panel.expanded=true};expandAll(planRoot);
  check(labels(planRoot).includes('Цель GNOME <&>')&&labels(planRoot).includes('Получить результат'),'native plan lost revision/criterion');
  for(const value of ['Назначено · fixture/plan','Наблюдение исполнения · api · fixture/api-observed','Наблюдение исполнения · harness · fixture-cli · fixture/plan-observed',
    'Код отказа · fixture_plan_capacity','HTTP-статус · 503','Сообщённая причина · Plan provider unavailable <&>'])check(labels(planRoot).includes(value),'plan participant fact missing: '+value);
  check(!labels(planRoot).includes(fixture.secret),'plan participant failure exposed secret');
  press(planRoot,'Сохранённый ответ…');document=[...reviews.dialogs].at(-1);documentRoot=document.get_child();await until(()=>content()===fixture.plan_text,'plan-domain source not read in full');
  await gateway.json('POST','/fixture/change-plan',{});press(documentRoot,'Перечитать текст');await until(()=>labels(documentRoot).includes('changed')||labels(documentRoot).includes('review_source_changed'),'changed plan selection not refused');
  check(content()===''&&!all(documentRoot,w=>w instanceof Gtk.Button&&w.label==='Скачать текст…')[0].sensitive,'changed plan source retained stale export');document.force_close();
  const oldSource=all(planRoot,w=>w instanceof Gtk.Button&&w.label==='Сохранённый ответ…')[0];
  reviews.reference({task:'plan-root',surface:'plan_review',revision:'fixture-new-source'});
  await until(()=>all(planRoot,w=>w instanceof Gtk.Button&&w.label==='Сохранённый ответ…').some(button=>button!==oldSource),'plan reference did not refresh saved selection');
  press(planRoot,'Сохранённый ответ…');document=[...reviews.dialogs].at(-1);documentRoot=document.get_child();await until(()=>content()==='Новый ответ','refreshed plan source did not use new SHA256');document.force_close();
  stage='native skill review exports';reviews.skill(win,{skill:'weather',attempts:[
    {job_id:fixture.skill_exports[0].id,initiator_task_id:'skill-owner'},
    {record_id:fixture.skill_exports[1].id,origin_task_id:'skill-owner'}]});
  const skillDialog=[...reviews.dialogs].at(-1),skillRoot=skillDialog.get_child();
  for(let i=0;i<2;i++){
   all(skillRoot,w=>w instanceof Gtk.Button&&w.label==='Прочитать сохранённую проверку…')[i].emit('clicked');document=[...reviews.dialogs].at(-1);documentRoot=document.get_child();
   await until(()=>content()===fixture.skill_exports[i].text,'native saved skill export differs: '+i);document.force_close();
  }
  for(const selection of fixture.skill_exports){let foreignRefused=false;try{await gateway.reviewExport('/api/tasks/foreign-task/reviews/skill/'+encodeURIComponent(selection.id)+'?skill=weather')}catch(error){foreignRefused=error.status===404}
   check(foreignRefused,'skill review leaked across task ownership: '+selection.id)}
  stage='save failure restores native export and uses clicked bytes';
  reviews.skill(win,{skill:'weather',attempts:[{job_id:fixture.skill_exports[0].id,initiator_task_id:'skill-owner'}]});let owner=[...reviews.dialogs].at(-1);press(owner.get_child(),'Прочитать сохранённую проверку…');document=[...reviews.dialogs].at(-1);documentRoot=document.get_child();await until(()=>content()===fixture.skill_exports[0].text,'save lifecycle source missing');
  const exportButton=()=>all(documentRoot,w=>w instanceof Gtk.Button&&w.label==='Скачать текст…')[0];chooseMode='directory';press(documentRoot,'Скачать текст…');await until(()=>exportButton().sensitive,'failed file save did not restore button');check(!labels(documentRoot).includes('Текст сохранён.'),'failed save claimed success');chooseMode='normal';press(documentRoot,'Скачать текст…');await until(()=>labels(documentRoot).includes('Текст сохранён.'),'retry after write failure failed');let [,retrySaved]=GLib.file_get_contents(ARGV[2]+'/review.txt');check(new TextDecoder().decode(retrySaved)===fixture.skill_exports[0].text,'retry changed verified bytes');
  stage='parent close cancels chooser and detached read/save/source controls';chooseMode='hold-chooser';const chooserBefore=chooseCount;press(documentRoot,'Скачать текст…');exportButton().emit('clicked');await until(()=>heldChooser,'chooser did not start');check(chooseCount===chooserBefore+1,'duplicate chooser opened');const oldRead=all(documentRoot,w=>w instanceof Gtk.Button&&w.label==='Перечитать текст')[0],oldSave=exportButton(),oldChooserSource=all(owner.get_child(),w=>w instanceof Gtk.Button&&w.label==='Прочитать сохранённую проверку…')[0];owner.force_close();check(heldChooser.cancel.is_cancelled()&&!reviews.dialogs.has(document),'parent did not cancel chooser/close document');heldChooser.complete();await wait(30);const beforeReads=sourceReads,beforeDialogs=reviews.dialogs.size;oldRead.emit('clicked');oldSave.emit('clicked');oldChooserSource.emit('clicked');await wait(30);check(sourceReads===beforeReads&&reviews.dialogs.size===beforeDialogs&&chooseCount===chooserBefore+1&&!Gio.File.new_for_path(ARGV[2]+'/cancelled-chooser.txt').query_exists(null),'closed controls read/saved/opened source');
  stage='closing during scheduled write cancels actual Gio replacement';chooseMode='normal';reviews.skill(win,{skill:'weather',attempts:[{job_id:fixture.skill_exports[0].id,initiator_task_id:'skill-owner'}]});owner=[...reviews.dialogs].at(-1);press(owner.get_child(),'Прочитать сохранённую проверку…');document=[...reviews.dialogs].at(-1);documentRoot=document.get_child();await until(()=>content()===fixture.skill_exports[0].text,'reopened source missing');chooseMode='hold-write';press(documentRoot,'Скачать текст…');await until(()=>heldWrite,'file replacement not scheduled');check(writeCancel instanceof Gio.Cancellable,'file replacement cancellation absent');document.force_close();check(writeCancel.is_cancelled(),'close did not cancel write');heldWrite();await wait(50);check(!Gio.File.new_for_path(ARGV[2]+'/cancelled-write.txt').query_exists(null),'cancelled Gio replacement created file');chooseMode='normal';owner.force_close();
  check(!all(root,w=>String(w.constructor.name).includes('WebView')).length,'browser mounted in native review');
  print('OK: real ledger-built native review history and source exports; finding/section/composition facts, observed versus requested models, typed failure details with credential masking, API/harness execution facts, malformed/legacy execution guards, omissions, paging/gaps, exact long text/download, tamper/redaction checks; native plan hydration/source and changed-selection refusal; legacy and ledger skill exports with exact task ownership; real Gio save failure/retry, one chooser, parent-close cancellation and detached controls, cancelled Gio write without destination creation');
 })().catch(error=>{failed=true;logError(error);print('Stage: '+stage)}).finally(()=>{reviews.close();gateway.close();Gtk.FileDialog.prototype.save=save;Gtk.FileDialog.prototype.save_finish=finish;win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
