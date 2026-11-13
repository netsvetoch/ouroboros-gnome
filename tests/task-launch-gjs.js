import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const base=ARGV[0],url=ARGV[1],run=ARGV[2];
const {Gateway}=await import(base+'gateway.js');
const {TaskLaunch}=await import(base+'task-launch.js');
const check=(value,message)=>{if(!value)throw new Error(message)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,message){for(let i=0;i<1000;i++){if(await fn())return;await wait(20)}throw new Error(message)}
function all(widget,predicate){let result=predicate(widget)?[widget]:[];for(let child=widget.get_first_child?.();child;child=child.get_next_sibling())result.push(...all(child,predicate));return result}
const click=(root,caption)=>{const button=all(root,w=>w instanceof Gtk.Button&&w.label===caption)[0];check(button?.sensitive&&button.visible,'button unavailable: '+caption);button.emit('clicked')};
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.LaunchTests',flags:Gio.ApplicationFlags.NON_UNIQUE});
let failed=false,stage='',launch;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1000,default_height:850});win.present();
 const gateway=new Gateway(url,'fixture-secret'),facts=()=>gateway.json('GET','/fixture/facts');
 const open=Gtk.FileDialog.prototype.open,finish=Gtk.FileDialog.prototype.open_finish;
 Gtk.FileDialog.prototype.open=function(parent,_cancel,callback){check(parent===win,'attachment chooser parent differs');GLib.idle_add(0,()=>{callback(this,null);return GLib.SOURCE_REMOVE})};
 Gtk.FileDialog.prototype.open_finish=()=>Gio.File.new_for_path(run+'/attachment.txt');
 (async()=>{
  const fixture=await facts(),room={name:'Main',chatId:1};let opened,changed=0;
  launch=new TaskLaunch(win,gateway,id=>{opened=id},()=>{changed++});
  check(launch.location.startsWith(run+'/client-state/'),'launch state escaped the fixture directory');
  function form(id){launch.show(room);const current=launch.openDialog;for(const expander of all(current.dialog.get_child(),w=>w instanceof Gtk.Expander))expander.expanded=true;
   current.editor.fields.get('description').set('Задача GNOME 🔧');current.editor.fields.get('task_id').set(id);return current}
  const add=(form,path,name)=>{form.serverPath.set_text(path);form.serverLabel.set_text(name);click(form.dialog.get_child(),'Добавить путь')};
  stage='partial attachment admission';let current=form('gtk-partial');await current.upload();check(current.attachments.length===1,'native upload did not attach source');add(current,fixture.missing,'Missing source');
  current.submit.emit('clicked');await until(()=>!current.busy,'partial launch did not settle');
  check(current.confirmed==='gtk-partial','partial launch not accepted: '+current.status.label);
  let state=await facts(),record=state.records['gtk-partial'];
  check(state.pending.some(row=>row.id==='gtk-partial')&&record.api_admission.status==='accepted','acceptance did not persist in real queue/result store');
  check(record.attachment_manifest.some(row=>row.status==='staged')&&record.attachment_manifest.some(row=>row.status==='rejected'),'partial manifest lost staged/rejected rows');
  check(state.staged_bytes['gtk-partial'].length===1&&state.staged_bytes['gtk-partial'][0]===state.source_bytes,'staged upload bytes differ');
  check(state.snapshot.pending.some(row=>row.id==='gtk-partial'),'acceptance missing from durable queue snapshot');
  check(all(current.receipt,w=>w instanceof Gtk.Expander&&w.label.includes('отклонено')).length,'native manifest did not disclose rejected attachment');
  click(current.dialog.get_child(),'Открыть задачу');check(opened==='gtk-partial'&&changed===1,'accepted task navigation changed identity');

  stage='atomic attachment refusal';current=form('gtk-atomic');add(current,fixture.source,'Valid source');add(current,fixture.missing,'Missing source');current.editor.atomic.active=true;
  current.submit.emit('clicked');await until(()=>!current.busy,'atomic launch did not settle');state=await facts();
  check(!current.confirmed&&!current.pending&&!state.pending.some(row=>row.id==='gtk-atomic'),'atomic refusal queued work or retained unknown receipt');
  check(current.editor.widget.sensitive&&current.attachments.length===2,'atomic refusal lost editable draft/attachments');current.dialog.force_close();

  stage='response unavailable before admission';current=form('gtk-before');
  const recoveredText={context:'  Native context\nSecond line 🔧\n',expected_output:'  Native expected <&>\nSecond result 🔧\n',constraints:'  Literal constraints\n\nKeep spacing  \n'};
  for(const [key,value] of Object.entries(recoveredText)){current.editor.fields.get(key).set(value);check(all(current.dialog.get_child(),w=>w instanceof Gtk.TextView&&w.get_name()==='task-launch-'+key).length===1,'free text field is not a native multiline editor: '+key)}
  current.submit.emit('clicked');await until(()=>!current.busy,'before-admission fault did not settle');
  check(current.pending&&!current.confirmed&&!current.submit.visible,'unknown launch offered an unchecked replay');
  const [,saved]=GLib.file_get_contents(launch.location);
  const original=JSON.parse(new TextDecoder().decode(saved)).body;
  current.dialog.force_close();launch.show(room);current=launch.openDialog;check(current.pending.body.task_id==='gtk-before','reopen lost pending identity');
  for(const [key,value] of Object.entries(recoveredText))check(current.editor.fields.get(key).get()===value&&current.pending.body[key]===value,'reopen changed multiline '+key);
  current.check.emit('clicked');await until(()=>!current.busy,'receipt absence check did not settle');check(current.retry&&current.submit.visible,'404 did not offer exact replay');
  current.submit.emit('clicked');await until(()=>!current.busy,'exact replay did not settle');check(current.confirmed==='gtk-before','replay was not accepted');
  state=await facts();const attempts=state.requests.filter(row=>row.task_id==='gtk-before');check(attempts.length===2&&attempts.every(row=>JSON.stringify(row)===JSON.stringify(original)),'replay changed exact body/submission identity');
  check(state.pending.filter(row=>row.id==='gtk-before').length===1,'replay enqueued a duplicate');current.dialog.force_close();

  stage='response unavailable after admission';current=form('gtk-after');current.submit.emit('clicked');await until(()=>!current.busy,'after-admission fault did not settle');check(current.pending&&!current.confirmed,'lost acknowledgement became a definite result');
  current.dialog.force_close();launch.show(room);current=launch.openDialog;current.check.emit('clicked');await until(()=>!current.busy,'durable receipt check did not settle');
  check(current.confirmed==='gtk-after','durable matching admission was not recovered: '+current.status.label);state=await facts();check(state.requests.filter(row=>row.task_id==='gtk-after').length===1&&state.pending.filter(row=>row.id==='gtk-after').length===1,'readback replayed an admitted task');current.dialog.force_close();

  stage='explicitly abandon unknown submission';current=form('gtk-abandon');for(const [key,value] of Object.entries(recoveredText))current.editor.fields.get(key).set(value);
  current.submit.emit('clicked');await until(()=>!current.busy,'abandoned unknown request did not settle');check(current.pending&&!current.confirmed,'missing pre-admission fault for abandonment');
  click(current.dialog.get_child(),'Оставить без повтора');check(!current.pending&&!current.retry&&current.editor.fields.get('task_id').get()===''&&current.editor.widget.sensitive,'abandon did not unlock a fresh identity');
  for(const [key,value] of Object.entries(recoveredText))check(current.editor.fields.get(key).get()===value,'abandon changed multiline draft '+key);
  const [,cleared]=GLib.file_get_contents(launch.location);check(JSON.parse(new TextDecoder().decode(cleared))===null,'abandon left replay state on disk');current.dialog.force_close();launch.show(room);current=launch.openDialog;check(!current.pending,'abandoned request returned on reopen');current.dialog.force_close();
  state=await facts();check(state.requests.filter(row=>row.task_id==='gtk-abandon').length===1&&!state.pending.some(row=>row.id==='gtk-abandon'),'abandon repeated or admitted the unknown request');

  stage='advanced parameters';current=form('gtk-advanced');const fields=current.editor.fields,options=current.editor.options;
  fields.get('workspace_root').set(fixture.workspace);options.get('memory_mode').widget.set_selected(options.get('memory_mode').values.indexOf('empty'));
  fields.get('context').set('    Контекст с отступом\nСтрока\n');fields.get('expected_output').set('  Ответ <&>\nЕщё результат 🔧\n');fields.get('constraints').set('  Ограничение\n\nЕщё строка  \n');
  fields.get('timeout_sec').set('1.25e2');fields.get('execution_timeout_sec').set('7,5');fields.get('depth').set('2');
  fields.get('allowed_resources').set('{"web":false,"network":false}');fields.get('disabled_tools').set('web_search\nread_file\nweb_search');
  fields.get('acceptance_claims').set('[{"id":"result","claim":"Exact result","priority":"must"}]');
  fields.get('metadata').set('{"fixture":"native"}');options.get('answer_protocol').widget.set_selected(1);options.get('service_teardown').widget.set_selected(2);options.get('reasoning_effort').widget.set_selected(options.get('reasoning_effort').values.indexOf('high'));
  current.editor.ownBody.active=true;current.submit.emit('clicked');await until(()=>!current.busy,'advanced launch did not settle');
  check(current.confirmed==='gtk-advanced','advanced launch not accepted: '+current.status.label);state=await facts();record=state.records['gtk-advanced'];
  const submitted=state.requests.find(row=>row.task_id==='gtk-advanced');
  check(submitted.context==='    Контекст с отступом\nСтрока\n'&&record.context===submitted.context&&record.expected_output==='  Ответ <&>\nЕщё результат 🔧\n'&&record.constraints==='  Ограничение\n\nЕщё строка  \n','native form changed verbatim free text');
  const task=state.pending.find(row=>row.id==='gtk-advanced');
  const queued=state.snapshot.pending.find(row=>row.id==='gtk-advanced');
  check(submitted.timeout_sec===125&&Math.abs(Date.parse(task.deadline_at)-Date.parse(queued.queued_at)-125000)<5000&&task.execution_timeout_sec===7.5&&task.memory_mode==='empty'&&task.workspace_root===fixture.workspace,'time/workspace parameters changed');
  check(task.reasoning_effort==='high'&&task.task_contract.context_requires_self_body_docs===true&&task.task_contract.answer_protocol==='final_answer_line'&&task.metadata.service_teardown==='keep','execution/answer options changed');
  check(task.allowed_resources.web===false&&task.task_contract.disabled_tools.includes('read_file')&&task.task_contract.acceptance_claims[0].id==='result','task policies changed');
  check(!all(current.dialog.get_child(),w=>String(w.constructor.name).includes('WebView')).length,'browser mounted in native launch');
  print('OK: real managed queue admission/result receipt and upload/attachment staging; partial/atomic manifests, persisted unknown launch and exact replay, after-admission readback without duplicate, native advanced workspace/time/policy/answer/free-text fields, multiline expected output/constraints through disk recovery and exact replay, explicit abandonment without replay; no model execution');
 })().catch(async error=>{failed=true;logError(error);print('Stage: '+stage);try{const state=await facts();print(JSON.stringify({requests:state.requests,audit:state.audit,pending:state.pending.map(row=>({id:row.id,timeout_sec:row.timeout_sec,execution_timeout_sec:row.execution_timeout_sec}))}))}catch{}}).finally(()=>{launch?.close();gateway.close();Gtk.FileDialog.prototype.open=open;Gtk.FileDialog.prototype.open_finish=finish;win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
