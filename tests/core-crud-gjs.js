import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';

const base=ARGV[0],url=ARGV[1],run=ARGV[2];
const {Gateway}=await import(base+'gateway.js');
const {Projects}=await import(base+'projects.js');
const {FilesPage}=await import(base+'files.js');
const {SchedulesPage}=await import(base+'schedules.js');
const check=(value,message)=>{if(!value)throw new Error(message)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,message){for(let i=0;i<1000;i++){if(await fn())return;await wait(20)}throw new Error(message)}
function all(widget,predicate){let result=predicate(widget)?[widget]:[];for(let child=widget.get_first_child?.();child;child=child.get_next_sibling())result.push(...all(child,predicate));return result}
const labels=root=>all(root,w=>w instanceof Gtk.Label).map(w=>w.get_text());
const click=(root,caption)=>{const target=all(root,w=>w instanceof Gtk.Button&&w.label===caption)[0];check(target&&target.sensitive,'button unavailable: '+caption);target.emit('clicked')};
const entry=(root,title)=>{const target=all(root,w=>w instanceof Adw.EntryRow&&w.title===title)[0];check(target,'field missing: '+title);return target};
const drop=(root,first)=>{const target=all(root,w=>w instanceof Gtk.DropDown&&w.get_model()?.get_string?.(0)===first)[0];check(target,'choice missing: '+first);return target};
const dialog=page=>[...page.dialogs].at(-1);
const editor=root=>all(root,w=>w instanceof Gtk.TextView&&w.editable)[0];
const text=view=>{const b=view.get_buffer();return b.get_text(b.get_start_iter(),b.get_end_iter(),true)};
const readBytes=value=>new TextDecoder().decode(GLib.base64_decode(value));
let stage='',projects,files,schedules,failed=false,wantConfirm=false;
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.CoreTests',flags:Gio.ApplicationFlags.NON_UNIQUE});
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1000,default_height:800});win.present();
 const gateway=new Gateway(url,'fixture-secret'),facts=()=>gateway.json('GET','/fixture/facts');
 const uploadFile=Gio.File.new_for_path(run+'/upload.bin'),uploadBytes=new Uint8Array([0,1,127,128,255]);uploadFile.replace_contents(uploadBytes,null,false,Gio.FileCreateFlags.REPLACE_DESTINATION,null);
 let savedFile=Gio.File.new_for_path(run+'/download.bin');
 const chooserMethods=Object.fromEntries(['open','open_finish','save','save_finish'].map(name=>[name,Gtk.FileDialog.prototype[name]]));
 for(const method of ['open','save'])Gtk.FileDialog.prototype[method]=function(parent,_cancel,callback){check(parent===win,'file chooser parent differs');GLib.idle_add(0,()=>{callback(this,null);return GLib.SOURCE_REMOVE})};
 Gtk.FileDialog.prototype.open_finish=()=>uploadFile;Gtk.FileDialog.prototype.save_finish=()=>savedFile;
 const snapshot=async name=>{if(!GLib.getenv('FLATPAK_ID')&&GLib.find_program_in_path('import')){await wait(80);Gio.Subprocess.new(['import','-window','root',run+'/'+name+'.png'],Gio.SubprocessFlags.NONE).wait_check(null)}};
 const originalPresent=Adw.AlertDialog.prototype.present;
 Adw.AlertDialog.prototype.present=function(parent){originalPresent.call(this,parent);if(wantConfirm&&this.has_response('ok')){wantConfirm=false;GLib.idle_add(0,()=>{this.emit('response','ok');this.close();return GLib.SOURCE_REMOVE})}};
 (async()=>{
  stage='projects';const fixture=await facts();let selected;
  projects=new Projects(win,gateway,1,room=>{selected=room});win.set_content(projects.widget);await until(()=>projects.listLoaded,'project list not loaded');
  click(projects.widget,'Новый проект');let form=dialog(projects),root=form.get_extra_child();
  entry(root,'Название').set_text('Проект GTK <&> 🔧');entry(root,'ID проекта (необязательно)').set_text('gtk-core-project');
  drop(root,'Без рабочей папки').set_selected(2);entry(root,'Путь на шлюзе или URL репозитория').set_text(fixture.attached);
  click(root,'Выбрать папку на шлюзе…');const picker=dialog(projects);
  await until(()=>all(picker.get_child(),w=>w instanceof Gtk.Button&&w.label==='Выбрать эту папку'&&w.sensitive).length,'server directory picker did not load');
  click(picker.get_child(),'Выбрать эту папку');check(entry(root,'Путь на шлюзе или URL репозитория').get_text()===fixture.attached,'directory picker returned another path');
  click(root,'Создать');await until(()=>projects.projects.some(p=>p.id==='gtk-core-project'),'project creation did not reach registry');
  let project=projects.projects.find(p=>p.id==='gtk-core-project');
  check(project.working_dir===fixture.attached&&selected?.projectId===project.id,'attached project/selected room differs');
  stage='native historical project receipt';click(projects.widget,'Сведения о проекте…');const info=projects.detailsView;await until(()=>!info.reading,'project details not loaded');const stored=(await facts()).projects.find(p=>p.id===project.id);const fullFacts=all(info.receiptFacts.widget,w=>w instanceof Gtk.Label).map(w=>w.label).join("\n");check(fullFacts.includes(stored.trusted_at)&&fullFacts.includes(stored.created_at)&&fullFacts.includes('Подключённая папка')&&!all(info.facts.widget,w=>w instanceof Gtk.Label).some(w=>w.label.startsWith('Записанное время доверия')),'actual create receipt mixed with compact current facts');info.dialog.force_close();
  click(projects.widget,'Изменить проект');form=dialog(projects);root=form.get_extra_child();entry(root,'Название').set_text('Изменённый GTK проект');
  all(root,w=>w instanceof Gtk.CheckButton&&w.label==='Закрепить проект')[0].active=true;
  click(root,'Сохранить');await until(()=>projects.projects.some(p=>p.name==='Изменённый GTK проект'&&p.pinned),'project update did not persist');

  stage='files';files=new FilesPage(win,gateway);win.set_content(files.widget);await files.refresh();check(files.listing?.entries.some(x=>x.name==='seed.txt'),'file list not populated');
  stage='literal replacement character';files.openPreview({name:'replacement.txt',path:'replacement.txt',type:'file'});form=dialog(files);root=form.get_child();await until(()=>all(root,w=>w instanceof Gtk.TextView&&text(w).startsWith('Intentional')).length>0,'replacement file not loaded');
  check(all(root,w=>w instanceof Gtk.Button&&w.label==='Редактировать')[0]?.visible,'valid UTF-8 replacement character is not editable');
  click(root,'Редактировать');const replacement='Updated intentional � character 🔧\n';editor(root).buffer.set_text(replacement,-1);click(root,'Сохранить на шлюзе');await until(async()=>readBytes((await facts()).files['replacement.txt'].bytes)===replacement,'literal replacement character edit not saved');await until(()=>all(root,w=>w instanceof Gtk.Button&&w.label==='Редактировать')[0]?.visible,'replacement save did not settle');form.force_close();
  stage='damaged UTF-8 remains readonly';files.openPreview({name:'damaged.txt',path:'damaged.txt',type:'file'});form=dialog(files);root=form.get_child();await until(()=>all(root,w=>w instanceof Gtk.TextView&&text(w).startsWith('Invalid UTF-8')).length>0,'damaged file not loaded');check(!all(root,w=>w instanceof Gtk.Button&&w.label==='Редактировать')[0]?.visible,'damaged UTF-8 became editable');form.force_close();
  for(const [name,prefix] of [['unverified.txt','Unverified'],['racing.txt','Original']]){
   stage='byte verification '+name;files.openPreview({name,path:name,type:'file'});form=dialog(files);root=form.get_child();await until(()=>all(root,w=>w instanceof Gtk.TextView&&text(w).startsWith(prefix)).length>0,'unverified preview not loaded');check(!all(root,w=>w instanceof Gtk.Button&&w.label==='Редактировать')[0]?.visible,'unverified/mismatched byte source became editable');form.force_close();
  }
  const encodingFacts=await facts();check(encodingFacts.audit.some(r=>r.path==='/api/files/content'&&r.query==='path=unverified.txt'&&r.status===503),'raw-byte failure not observed');check(!encodingFacts.audit.some(r=>r.method==='POST'&&r.path==='/api/files/write'&&['damaged.txt','unverified.txt','racing.txt'].includes(r.body?.path)),'encoding guard tried to write an unreadable preview');check(encodingFacts.files['damaged.txt'].bytes===GLib.base64_encode(new Uint8Array([73,110,118,97,108,105,100,32,85,84,70,45,56,58,32,255,10])),'invalid original bytes changed');
  const writeAttempts=async name=>(await facts()).audit.filter(r=>r.path==='/api/files/write'&&r.body?.path===name).length;
  for(const name of ['loss-before.txt','loss-after.txt']){
   stage='write receipt recovery '+name;files.openPreview({name,path:name,type:'file'});form=dialog(files);root=form.get_child();await until(()=>all(root,w=>w instanceof Gtk.TextView&&text(w).startsWith('Recovery source')).length>0,'recovery file not loaded');click(root,'Редактировать');const draft='  Recovered draft '+name+' 🔧\n<&>\n';editor(root).buffer.set_text(draft,-1);click(root,'Сохранить на шлюзе');
   await until(()=>labels(root).some(v=>v.includes('Итог записи неизвестен')),'lost write receipt treated as confirmed');check(text(editor(root))===draft&&!all(root,w=>w instanceof Gtk.Button&&w.label==='Сохранить на шлюзе')[0].sensitive,'unknown write lost draft or allowed replay');check(await writeAttempts(name)===1,'unknown write automatically retried');
   click(root,'Проверить содержимое на шлюзе');
   if(name==='loss-before.txt'){
    await until(()=>labels(root).some(v=>v.includes('Можно повторить сохранение')),'absent change did not unlock explicit retry');click(root,'Сохранить на шлюзе');await until(()=>all(root,w=>w instanceof Gtk.Button&&w.label==='Редактировать')[0].visible,'explicit retry did not settle');check(await writeAttempts(name)===2,'explicit retry count incorrect');
   }else{
    await until(()=>labels(root).some(v=>v.includes('совпадает с черновиком')),'committed write not recovered by readback');check(await writeAttempts(name)===1,'committed write replayed after readback');
   }
   check(readBytes((await facts()).files[name].bytes)===draft,'recovered file bytes changed');form.force_close();
  }
  for(const [mode,name,destination] of [['copy','copy-unknown.txt','copy-recovery'],['move','move-unknown.txt','move-recovery']]){
   stage='transfer receipt recovery '+mode;await files.navigate('.');const selected=[...files.entries].find(([,e])=>e.path===name);check(selected,'transfer source absent');files.list.select_row(selected[0]);files.queueTransfer(mode);await files.navigate('./'+destination+'//');check(files.listing.path===destination,'normalized destination not retained');files.paste.emit('clicked');
   await until(()=>!files.mutating&&files.transferResult?.state==='unknown','lost transfer receipt treated as confirmed');const outcome=files.transferResult;check(!files.paste.visible&&files.clearTransfer.label==='Закрыть результат','unknown transfer can be replayed or presented as cancellable');await files.navigate('.');const other=[...files.entries].find(([,e])=>e.path==='seed.txt');files.list.select_row(other[0]);files.queueTransfer(mode);check(files.transferResult===outcome,'unknown transfer was replaced by another selected file');files.checkTransfer.emit('clicked');
   await until(()=>!files.checkingTransfer&&files.transferResult.observation?.includes('Показано текущее состояние'),'native two-directory readback did not settle');const observation=files.transferResult.observation;
   check(observation.includes('Назначение · элемент найден')&&observation.includes(mode==='move'?'Исходный путь · элемент отсутствует':'Исходный путь · элемент найден'),'readback misrepresented source/destination presence');check(files.transferResult.state==='unknown'&&!files.paste.visible,'presence check falsely confirmed transfer or unlocked replay');
   const transferFacts=await facts();check(transferFacts.audit.filter(r=>r.path==='/api/files/transfer'&&r.body?.source_path===name).length===1,'readback repeated transfer');check(readBytes(transferFacts.files[destination+'/'+name].bytes)==='Recovery source <&> 🔧\n','committed transfer bytes changed');check(Boolean(transferFacts.files[name])===(mode==='copy'),'move/copy source presence incorrect');files.clearTransfer.emit('clicked');
  }
  await files.navigate('.');
  click(files.widget,'Новая папка');form=dialog(files);all(form.get_child(),w=>w instanceof Gtk.Entry)[0].set_text('Папка +%');click(form.get_child(),'Создать');
  await until(()=>!files.mutating&&files.listing.entries.some(x=>x.path==='Папка +%'),'folder creation failed');
  click(files.widget,'Новый файл');form=dialog(files);all(form.get_child(),w=>w instanceof Gtk.Entry)[0].set_text('Текст <&> +%.txt');click(form.get_child(),'Открыть редактор');
  await until(()=>dialog(files)?.title==='Текст <&> +%.txt','new file editor absent');form=dialog(files);root=form.get_child();
  const prose='Текст GNOME 🔧\n<&> +%\n';editor(root).get_buffer().set_text(prose,-1);click(root,'Сохранить на шлюзе');
  await until(async()=>readBytes((await facts()).files['Текст <&> +%.txt']?.bytes??'')===prose,'file text not saved exactly');
  await until(()=>all(root,w=>w instanceof Gtk.Button&&w.label==='Редактировать')[0].sensitive,'file save not settled');
  click(root,'Редактировать');editor(root).get_buffer().set_text('Изменение из GTK\n',-1);click(root,'Сохранить на шлюзе');
  await until(async()=>readBytes((await facts()).files['Текст <&> +%.txt']?.bytes??'')==='Изменение из GTK\n','existing file edit did not persist');
  await until(()=>all(root,w=>w instanceof Gtk.Button&&w.label==='Редактировать')[0].sensitive,'existing file edit not settled');
  click(root,'Редактировать');editor(root).get_buffer().set_text('Local draft\n',-1);
  await gateway.json('POST','/api/files/write',{path:'Текст <&> +%.txt',content:'Concurrent server version\n'});
  click(root,'Сохранить на шлюзе');await until(()=>labels(root).some(x=>x.includes('изменилось. Черновик сохранён')),'concurrent file change not detected');
  check(text(editor(root))==='Local draft\n'&&readBytes((await facts()).files['Текст <&> +%.txt'].bytes)==='Concurrent server version\n','conflict overwrote server or local draft');await snapshot('file-conflict');form.force_close();
  const selectFile=path=>{const match=[...files.entries].find(([,value])=>value.path===path);check(match,'file row absent: '+path);files.list.select_row(match[0])};
  await files.refresh();selectFile('Текст <&> +%.txt');files.queueTransfer('copy');await files.navigate('Папка +%');click(files.widget,'Вставить сюда');
  await until(()=>!files.mutating&&files.transferResult?.state==='confirmed','copy did not confirm');
  check(readBytes((await facts()).files['Папка +%/Текст <&> +%.txt'].bytes)==='Concurrent server version\n','copy bytes differ');
  selectFile('Папка +%/Текст <&> +%.txt');files.queueTransfer('move');await files.navigate('.');click(files.widget,'Вставить сюда');
  await until(()=>!files.mutating&&files.transferResult?.state==='conflict','move collision did not remain a conflict');
  check((await facts()).files['Папка +%/Текст <&> +%.txt'],'conflicting move removed source');
  files.clearTransfer.emit('clicked');click(files.widget,'Новая папка');form=dialog(files);all(form.get_child(),w=>w instanceof Gtk.Entry)[0].set_text('Цель');click(form.get_child(),'Создать');
  await until(()=>!files.mutating&&files.listing.entries.some(x=>x.path==='Цель'),'move destination creation failed');
  await files.navigate('Папка +%');selectFile('Папка +%/Текст <&> +%.txt');files.queueTransfer('move');await files.navigate('Цель');click(files.widget,'Вставить сюда');
  await until(()=>!files.mutating&&files.transferResult?.state==='confirmed','successful move did not confirm');
  check(!(await facts()).files['Папка +%/Текст <&> +%.txt']&&readBytes((await facts()).files['Цель/Текст <&> +%.txt'].bytes)==='Concurrent server version\n','move did not transfer exact bytes');
  selectFile('Цель/Текст <&> +%.txt');wantConfirm=true;void files.remove();
  await until(()=>!files.mutating&&![...files.entries.values()].some(x=>x.path==='Цель/Текст <&> +%.txt'),'native file delete failed');
  check(!(await facts()).files['Цель/Текст <&> +%.txt'],'deleted file remains on disk');
  await files.navigate('.');await files.uploadFile();check((await facts()).files['upload.bin'].bytes===GLib.base64_encode(uploadBytes),'native file upload changed binary bytes');
  selectFile('upload.bin');files.download.emit('clicked');await until(()=>savedFile.query_exists(null),'native file download did not complete');
  check(GLib.base64_encode(savedFile.load_contents(null)[1])===GLib.base64_encode(uploadBytes),'downloaded binary bytes differ');
  savedFile=Gio.File.new_for_path(run+'/content.bin');await files.save({path:'upload.bin',name:'upload.bin',type:'file'},'content');
  check(GLib.base64_encode(savedFile.load_contents(null)[1])===GLib.base64_encode(uploadBytes),'content download bytes differ');

  stage='schedules';schedules=new SchedulesPage(win,gateway,()=>({name:'Main',chatId:1}),()=>projects.projectRooms(),()=>{});win.set_content(schedules.widget);await schedules.refresh();
  click(schedules.widget,'Новое расписание');form=dialog(schedules);root=form.get_child();entry(root,'Название').set_text('Расписание GTK <&> 🔧');
  for(const expander of all(root,w=>w instanceof Gtk.Expander))expander.expanded=true;await wait(30);
  const textViews=all(root,w=>w instanceof Gtk.TextView);textViews[0].get_buffer().set_text('Проверить нативный API\n',-1);
  const future=GLib.DateTime.new_now_utc().add_years(3).format('%Y-%m-%dT09:00:00+03:00');
  drop(root,'Повторяется (cron)').set_selected(1);entry(root,'Дата и время со смещением UTC').set_text(future);
  entry(root,'Часовой пояс IANA').set_text('Europe/Moscow');all(root,w=>w instanceof Gtk.TextView&&w.get_name()==='schedule-context')[0].buffer.set_text('Контекст',-1);entry(root,'Приоритет').set_text('7');
  all(root,w=>w instanceof Gtk.CheckButton&&w.label==='Запускать по расписанию')[0].active=false;
  textViews[1].get_buffer().set_text('{"fixture":"native"}',-1);click(root,'Сохранить расписание');
  await until(()=>schedules.rows.size===1,'schedule creation did not persist');let item=[...schedules.rows.values()][0];
  check(item.enabled===false&&item.task.text==='Проверить нативный API\n'&&item.task.priority===7&&item.task.metadata.fixture==='native','schedule values changed');
  check(Date.parse(item.trigger.run_at)===Date.parse(future),'once instant changed');
  schedules.edit(item);form=dialog(schedules);root=form.get_child();entry(root,'Название').set_text('Расписание <cron>&');drop(root,'Повторяется (cron)').set_selected(0);
  entry(root,'Минуты · часы · день месяца · месяц · день недели').set_text('15 8 * * 1-5');click(root,'Сохранить расписание');
  await until(()=>schedules.rows.get(item.id)?.trigger?.type==='cron','schedule cron edit failed');item=schedules.rows.get(item.id);
  check(item.trigger.expr==='15 8 * * 1-5'&&item.task.context==='Контекст'&&item.task.priority===7&&item.task.metadata.fixture==='native','schedule edit lost trigger or task fields');
  schedules.action(item,{label:'Включить',action:'restore'});form=dialog(schedules);root=form.get_child();entry(root,'Причина').set_text('Test enable');click(root,'Включить');
  await until(()=>schedules.rows.get(item.id)?.enabled===true,'schedule enable failed');item=schedules.rows.get(item.id);
  schedules.action(item,{label:'Выключить',action:'disable'});form=dialog(schedules);root=form.get_child();entry(root,'Причина').set_text('Test disable');click(root,'Выключить');
  await until(()=>schedules.rows.get(item.id)?.enabled===false,'schedule disable failed');item=schedules.rows.get(item.id);
  schedules.action(item,{label:'Удалить',action:'delete'});form=dialog(schedules);click(form.get_child(),'Удалить');
  await until(()=>schedules.rows.get(item.id)?.status==='delete_pending','schedule withdrawal failed');
  check(schedules.rows.get(item.id).enabled===false,'withdrawn schedule remained enabled');item=schedules.rows.get(item.id);
  schedules.action(item,{label:'Восстановить',action:'restore'});form=dialog(schedules);root=form.get_child();entry(root,'Причина').set_text('Test restore');click(root,'Восстановить');
  await until(()=>schedules.rows.get(item.id)?.enabled===true&&schedules.rows.get(item.id)?.status==='active','withdrawn schedule restoration failed');item=schedules.rows.get(item.id);
  schedules.action(item,{label:'Удалить',action:'delete'});form=dialog(schedules);root=form.get_child();entry(root,'Причина (необязательно)').set_text('Test withdrawal reason');click(root,'Удалить');
  await until(()=>schedules.rows.get(item.id)?.status==='delete_pending','schedule withdrawal with reason failed');
  await snapshot('schedules');

  stage='project deletion';win.set_content(projects.widget);click(projects.widget,'Удалить проект');form=dialog(projects);
  await until(()=>all(form.get_child(),w=>w instanceof Gtk.Button&&w.label==='Удалить проект…'&&w.sensitive).length,'project deletion preflight not ready');
  wantConfirm=true;click(form.get_child(),'Удалить проект…');await until(async()=>!(await facts()).projects.some(p=>p.id==='gtk-core-project'),'project deletion did not converge');
  check((await facts()).folder_kept==='Owner folder remains\n','project delete changed attached directory');
  const final=await facts();check(final.audit.some(x=>x.path==='/api/files/transfer'&&x.status===409),'actual transfer conflict not observed');
  const required=[['GET','/api/projects'],['POST','/api/projects'],['POST','/api/projects/gtk-core-project/update'],['POST','/api/projects/gtk-core-project/delete'],['GET','/api/fs/dirs'],
   ...['list','read','content','download'].map(route=>['GET','/api/files/'+route]),...['mkdir','write','transfer','delete','upload'].map(route=>['POST','/api/files/'+route]),
   ['GET','/api/schedules'],['POST','/api/schedules'],['POST','/api/schedules/'+item.id+'/action'],['DELETE','/api/schedules/'+item.id]];
  for(const [method,path] of required)check(final.audit.some(row=>row.method===method&&row.path===path&&row.status>=200&&row.status<300),'successful real route not observed: '+method+' '+path);
  check(!all(win,w=>String(w.constructor.name).includes('WebView')).length,'browser mounted in native CRUD');
  print('OK: '+required.length+' real route/method pairs; projects attach/update/delete with folder preservation; native file mkdir/create/edit/conflict/copy/move/collision/delete/upload/download/content and exact Unicode/binary bytes, literal U+FFFD edit with raw-byte verification, invalid UTF-8/read failure/changed-byte readonly guards, lost write receipts before/after commit with explicit retry/readback, lost copy/move receipts with two-directory observation and no replay; schedule once/cron/create/edit/enable/disable/withdraw/restore, timezone/priority/metadata; no WebView');
 })().catch(async error=>{failed=true;logError(error);print('Stage: '+stage);try{print(JSON.stringify(await facts()))}catch{}}).finally(()=>{
  projects?.close();files?.close();schedules?.close();gateway.close();Adw.AlertDialog.prototype.present=originalPresent;for(const [name,method] of Object.entries(chooserMethods))Gtk.FileDialog.prototype[name]=method;win.close();app.quit();
 });
});await app.runAsync([]);exit(failed?1:0);
