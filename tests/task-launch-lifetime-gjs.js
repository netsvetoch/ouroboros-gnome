import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {TaskLaunch}=await import(ARGV[0]+'task-launch.js');
const check=(x,m)=>{if(!x)throw new Error(m)};
const wait=ms=>new Promise(r=>GLib.timeout_add(0,ms,()=>{r();return GLib.SOURCE_REMOVE}));
async function until(fn,m){for(let i=0;i<500;i++){if(await fn())return;await wait(20)}throw new Error(m)}
function all(w,p){let a=p(w)?[w]:[];for(let c=w.get_first_child?.();c;c=c.get_next_sibling())a.push(...all(c,p));return a}
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.LaunchLifetimeTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1100,default_height:950});win.present();
 const gateway=new Gateway(ARGV[1],'fixture-secret'),launch=new TaskLaunch(win,gateway,()=>{},()=>{});let root,aux,stage='cancel pending chooser';const pending=[],outcomes=new WeakMap();let mode='cancel';
 const originalOpen=Gtk.FileDialog.prototype.open,originalFinish=Gtk.FileDialog.prototype.open_finish;
 Gtk.FileDialog.prototype.open=function(parent,cancel,callback){check(parent instanceof Gtk.Window&&cancel instanceof Gio.Cancellable,'chooser lacks native root/cancellable');const slot={dialog:this,parent,cancel,done:false};pending.push(slot);slot.deliver=error=>{if(slot.done)return;slot.done=true;outcomes.set(this,error);callback(this,null)};if(mode==='cancel')cancel.connect(()=>{GLib.idle_add(0,()=>{slot.deliver(true);return GLib.SOURCE_REMOVE})});else if(mode==='immediate')GLib.idle_add(0,()=>{slot.deliver(false);return GLib.SOURCE_REMOVE})};
 Gtk.FileDialog.prototype.open_finish=function(){if(outcomes.get(this))throw new Gio.IOErrorEnum({code:Gio.IOErrorEnum.CANCELLED,message:'fixture chooser cancelled'});return Gio.File.new_for_path(ARGV[2]+'/attachment.txt')};
 const facts=()=>gateway.json('GET','/fixture/facts');const show=()=>{launch.show({chatId:1,name:'Main'});return launch.openDialog};
 const add=(form,path)=>{form.serverPath.text=path;all(form.editor.attachments,w=>w instanceof Gtk.Button&&w.label==='Добавить путь')[0].emit('clicked')};
 const uploads=async()=>(await facts()).audit.filter(x=>x.path==='/api/chat/upload').length;
 (async()=>{
  let old=show(),before=await uploads(),promise=old.upload();check(pending.length===1&&!old.attach.sensitive,'pending chooser state wrong');old.cancelUpload.emit('clicked');await promise;check(pending[0].cancel.is_cancelled()&&!old.uploadCancel&&old.attach.sensitive&&await uploads()===before,'explicit cancel did not stop chooser cleanly');
  stage='dialog close cancels chooser before late successful result';mode='late';promise=old.upload();const late=pending.at(-1),count=pending.length;await old.upload();check(pending.length===count,'double upload opened duplicate chooser');const stale=all(old.editor.attachments,w=>w instanceof Gtk.Button&&w.label==='Добавить путь')[0];old.dialog.force_close();check(late.cancel.is_cancelled(),'closed launch did not cancel chooser');const current=show();late.deliver(false);await promise;check(await uploads()===before&&current.attachments.length===0,'late chooser uploaded or attached into new form');
  old.serverPath.text='/stale';stale.emit('clicked');check(old.attachments.length===0,'stale path callback changed closed draft');
  stage='current chooser still uploads through actual primary handler';mode='immediate';await current.upload();check(current.attachments.length===1&&await uploads()===before+1,'fresh upload failed');
  stage='retired attachment controls cannot remove current row';const oldRemove=all(current.attachmentList,w=>w instanceof Gtk.Button&&w.label==='Убрать')[0];add(current,'/second-source');check(current.attachments.length===2,'add path failed');oldRemove.emit('clicked');check(current.attachments.length===2,'retired remove removed current attachment');const active=all(current.attachmentList,w=>w instanceof Gtk.Button&&w.label==='Убрать')[0];active.emit('clicked');check(current.attachments.length===1&&current.attachments[0].path==='/second-source','current remove failed');current.dialog.force_close();
  stage='controller close cancels chooser and forbids reopening';mode='cancel';old=show();promise=old.upload();const closing=pending.at(-1);launch.close();await promise;check(closing.cancel.is_cancelled()&&launch.disposed&&!launch.openDialog,'controller close left chooser/form');launch.show({chatId:1,name:'Main'});check(!launch.openDialog,'closed controller reopened');
  stage='parent root retires controller and chooser';root=new Adw.ApplicationWindow({application:app,default_width:800,default_height:650});root.present();aux=new TaskLaunch(root,gateway,()=>{},()=>{});aux.show({chatId:1,name:'Main'});old=aux.openDialog;promise=old.upload();const rooted=pending.at(-1);root.close();await until(()=>old.disposed,'root dismissal did not close launch dialog');await promise;check(rooted.cancel.is_cancelled(),'parent dismissal did not cancel chooser');if(!aux.disposed)root.close();await until(()=>aux.disposed,'closed root did not retire launch controller');aux.show({chatId:1,name:'Main'});check(!aux.openDialog,'retired root reopened launch');
  const data=await facts();check(!data.requests.length&&!data.pending.length,'attachment-only check launched work');
  print('OK: native task attachment chooser receives owning root/cancellable; explicit cancel, close before late chooser result, duplicate chooser prevention, fresh actual upload, stale path/remove guards, controller/root retirement and no accidental task launch');
 })().catch(e=>{failed=true;logError(e);print('Stage: '+stage)}).finally(()=>{launch.close();aux?.close();for(const p of pending)p.deliver(true);Gtk.FileDialog.prototype.open=originalOpen;Gtk.FileDialog.prototype.open_finish=originalFinish;root?.close();gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
