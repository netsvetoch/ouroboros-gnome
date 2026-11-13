import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {FilesPage}=await import(ARGV[0]+'files.js');
const check=(v,m)=>{if(!v)throw new Error(m)};
const wait=ms=>new Promise(r=>GLib.timeout_add(0,ms,()=>{r();return GLib.SOURCE_REMOVE}));
async function until(f,m){for(let i=0;i<900;i++){if(await f())return;await wait(20)}throw new Error(m)}
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.FileUploadReceiptTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1100,default_height:900});win.present();
 const gateway=new Gateway(ARGV[1],''),observer=new Gateway(ARGV[1],''),page=new FilesPage(win,gateway);win.set_content(page.widget);let stage='initial listing',selected,choosers=0;
 const methods=Object.fromEntries(['open','open_finish'].map(k=>[k,Gtk.FileDialog.prototype[k]]));
 Gtk.FileDialog.prototype.open=function(parent,cancel,callback){check(parent===win&&cancel instanceof Gio.Cancellable,'chooser ownership missing');choosers++;GLib.idle_add(0,()=>{callback(this,null);return GLib.SOURCE_REMOVE})};Gtk.FileDialog.prototype.open_finish=()=>selected;
 const facts=()=>observer.json('GET','/fixture/facts'),control=b=>observer.json('POST','/fixture/control',b),uploads=()=>facts().then(d=>d.audit.filter(r=>r.path==='/api/files/upload').length);
 const payload=new Uint8Array([0,1,34,92,127,128,255]);
 const prepare=name=>{selected=Gio.File.new_for_path(ARGV[2]+'/'+name);GLib.file_set_contents(selected.get_path(),payload)};
 const exact=async(path,bytes=payload)=>check((await facts()).files[path]===GLib.base64_encode(bytes),'actual uploaded bytes wrong '+path);
 (async()=>{
  await page.refresh();
  for(const fault of ['size-missing','size-short','size-string','name','path','ok','loss']){
   stage='actual multipart with '+fault+' receipt';prepare('upload-'+fault+'.bin');await control({fault:'upload-'+fault});const before=await uploads(),chosen=choosers;const pending=page.uploadFile(),duplicate=page.uploadFile();await Promise.all([pending,duplicate]);check(choosers===chosen+1&&(await uploads())===before+1,'duplicate upload/chooser '+fault);check(page.status.label.includes('Шлюз мог сохранить файл.')&&!page.status.label.includes('Файл загружен.'),'bad receipt called success '+fault);await exact(selected.get_basename());await wait(30);check((await uploads())===before+1,'upload automatically replayed '+fault);await control({fault:''});await page.refresh();check(page.listing.entries.some(x=>x.path===selected.get_basename()),'landed file absent after explicit list read '+fault);
  }
  stage='valid Unicode, multipart sanitization and Python whitespace';
  for(const [local,remote,bytes]of [[' Ω 🧭.bin ','Ω 🧭.bin',payload],['quoted"back\\name.bin','quoted_back_name.bin',payload],['\u0085trimmed.bin\u0085','trimmed.bin',payload],['\ufeffretained.bin\ufeff','\ufeffretained.bin\ufeff',payload],['empty.bin','empty.bin',new Uint8Array()]]){
   prepare(local);GLib.file_set_contents(selected.get_path(),bytes);const before=await uploads();await page.uploadFile();check(page.status.label==='Файл загружен.'&&(await uploads())===before+1,'valid receipt not confirmed '+JSON.stringify(local));await exact(remote,bytes)
  }
  stage='destination and conflict';await page.navigate('first');prepare('nested-upload.bin');await page.uploadFile();check(page.status.label==='Файл загружен.','nested upload not confirmed');await exact('first/nested-upload.bin');const prior=await uploads();await page.uploadFile();check(page.status.label.includes('HTTP 409')&&!page.status.label.includes('мог сохранить')&&(await uploads())===prior+1,'real collision not refused');await exact('first/nested-upload.bin');
  stage='cancel after actual handler committed before receipt';prepare('cancel-after.bin');await control({hold:'upload-receipt'});const pending=page.uploadFile();await until(async()=>(await facts()).audit.some(x=>x.path==='/api/files/upload'&&x.handler_done),'upload handler not completed');await exact('first/cancel-after.bin');page.cancelUpload.emit('clicked');await pending;check(page.status.label.includes('Шлюз мог сохранить файл.')&&!page.fileUpload,'cancel after write misrepresented result');const count=await uploads();await control({action:'release-all'});await wait(50);check((await uploads())===count,'cancel replayed upload');check((await observer.json('GET','/api/files/list?path=first')).entries.some(x=>x.name==='cancel-after.bin'),'late receipt lost actual file');
  print('OK: native Files upload through real multipart primary handler and temporary disk; measured byte/name/destination receipt validation, malformed/lost receipts remain uncertain without replay, exact binary/Unicode/empty and multipart/Python filename normalization, nested destination and actual 409 collision, cancellation after committed handler before held reply remains uncertain; chooser/faults/timing controlled, no user files or portal.');
 })().catch(e=>{failed=true;logError(e);print('Stage: '+stage);print(page.status.label)}).finally(async()=>{await control({action:'release-all'}).catch(()=>{});page.close();for(const [k,v]of Object.entries(methods))Gtk.FileDialog.prototype[k]=v;gateway.close();observer.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
