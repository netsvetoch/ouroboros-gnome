import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {TaskReviews}=await import(ARGV[0]+'task-reviews.js');
const check=(x,m)=>{if(!x)throw new Error(m)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,m){for(let i=0;i<1200;i++){if(await fn())return;await wait(20)}throw new Error(m)}
function all(w,p){let out=p(w)?[w]:[];for(let c=w.get_first_child?.();c;c=c.get_next_sibling())out.push(...all(c,p));return out}
const text=d=>all(d.get_child(),w=>w instanceof Gtk.Label).map(w=>w.get_text()).join('\n');
const button=(d,s)=>all(d.get_child(),w=>w instanceof Gtk.Button&&w.label===s)[0];
const click=(d,s)=>{const b=button(d,s);check(b?.is_sensitive(),'button unavailable '+s);b.emit('clicked')};
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.ArtifactsTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1100,default_height:1000});win.present();
 const gateway=new Gateway(ARGV[1],'fixture-secret'),observer=new Gateway(ARGV[1],'fixture-secret'),reviews=new TaskReviews(gateway),transfers=[];
 const download=gateway.download.bind(gateway);gateway.download=async(...args)=>{const r={cancel:args[3],done:false};transfers.push(r);try{return await download(...args)}finally{r.done=true}};
 const facts=()=>observer.json('GET','/fixture/facts'),control=(action,extra={})=>observer.json('POST','/fixture/control',{action,...extra});
 let stage='small artifact preview',selected=Gio.File.new_for_path(ARGV[2]+'/download.bin'),choosers=0,pendingCopy,holdCopy=false;
 const save=Gtk.FileDialog.prototype.save,finish=Gtk.FileDialog.prototype.save_finish;
 Gtk.FileDialog.prototype.save=function(parent,cancel,callback){check(parent===win&&cancel instanceof Gio.Cancellable,'artifact chooser owner/cancel wrong');choosers++;GLib.idle_add(0,()=>{callback(this,null);return GLib.SOURCE_REMOVE})};Gtk.FileDialog.prototype.save_finish=()=>selected;
 const prototype=Object.getPrototypeOf(selected),copy=prototype.copy_async;
 prototype.copy_async=function(destination,flags,priority,cancel,progress,callback){return copy.call(this,destination,flags,priority,cancel,progress,(file,result)=>{if(holdCopy){holdCopy=false;pendingCopy=()=>callback(file,result)}else callback(file,result)})};
 const fileText=file=>{const [ok,bytes]=GLib.file_get_contents(file.get_path());check(ok,'file unreadable');return new TextDecoder().decode(bytes)};
 const sentinel=()=>GLib.file_set_contents(selected.get_path(),'KEEP EXISTING FILE');
 const cleanSiblings=()=>{const dir=selected.get_parent().enumerate_children('standard::name',Gio.FileQueryInfoFlags.NONE,null);try{let info;while((info=dir.next_file(null)))check(!info.get_name().startsWith('.ouroboros-download-'),'staging sibling leaked')}finally{dir.close(null)}};
 (async()=>{
  const f=await facts(),path=name=>'/api/tasks/'+f.task+'/artifacts/'+encodeURIComponent(name),open=name=>{reviews.artifactDocument(win,'Artifact '+name,name,path(name),f.identities[name]);return [...reviews.dialogs].at(-1)};
  let d=open('small.json');await until(()=>button(d,'Скачать материал…').sensitive,'small artifact pending');const buffer=all(d.get_child(),w=>w instanceof Gtk.TextView)[0].buffer;check(JSON.parse(buffer.get_text(buffer.get_start_iter(),buffer.get_end_iter(),false)).title==='Native <&> 🔧'&&text(d).includes(f.identities['small.json'].sha256),'native small preview/identity absent');click(d,'Скачать материал…');await until(()=>text(d).includes('Проверенный материал сохранён.'),'small artifact save failed');check(fileText(selected)===f.small,'small artifact bytes changed');d.force_close();
  stage='large artifact streams only after explicit download';const count=(await facts()).audit.length;d=open('large.bin');check((await facts()).audit.length===count&&text(d).includes('больше 1 МиБ')&&text(d).includes(f.identities['large.bin'].sha256),'large artifact eager fetch or missing identity');click(d,'Скачать материал…');button(d,'Скачать материал…').emit('clicked');await until(()=>text(d).includes('Проверенный материал сохранён.'),'large artifact save failed');let [,bytes]=GLib.file_get_contents(selected.get_path());check(bytes.length===f.identities['large.bin'].size&&GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256,bytes)===f.identities['large.bin'].sha256&&choosers===2,'large stream identity/duplicate chooser wrong');cleanSiblings();
  stage='wire corruption and size mismatch preserve existing destination';for(const mode of ['corrupt','short','long','fail']){await control('fault',{mode});sentinel();click(d,'Скачать материал…');await until(()=>button(d,'Скачать материал…').sensitive,'failed transfer stuck');check(!text(d).includes('Проверенный материал сохранён.')&&fileText(selected)==='KEEP EXISTING FILE','failed stream overwrote destination or claimed success '+mode);cleanSiblings()}await control('fault',{mode:''});
  stage='cancelled wire stream preserves existing destination';sentinel();await control('hold');const before=(await facts()).audit.length;click(d,'Скачать материал…');await until(async()=>{const a=(await facts()).audit;return a.length>before&&a.at(-1).sent>=65536},'held stream not started');const held=transfers.at(-1);d.force_close();await until(()=>held.done,'close did not settle stream before release');check(held.cancel.is_cancelled()&&fileText(selected)==='KEEP EXISTING FILE','cancelled stream changed destination');await control('release-all');cleanSiblings();
  stage='verified local copy commits only after completion';d=open('large.bin');sentinel();holdCopy=true;click(d,'Скачать материал…');await until(()=>pendingCopy,'local copy not held');check(fileText(selected)==='KEEP EXISTING FILE','local copy overwrote destination before commit');const local=transfers.at(-1);d.force_close();pendingCopy();pendingCopy=undefined;await until(()=>local.done,'local cancellation did not settle');check(local.cancel.is_cancelled()&&fileText(selected)==='KEEP EXISTING FILE','cancelled local copy changed original');cleanSiblings();
  stage='retry succeeds and invalid identity fails before HTTP';d=open('large.bin');click(d,'Скачать материал…');await until(()=>text(d).includes('Проверенный материал сохранён.'),'retry after cancellation failed');const requests=(await facts()).audit.length;let invalid=false;try{await gateway.download(path('large.bin'),selected,true,undefined,{size:1,sha256:'bad'})}catch{invalid=true}check(invalid&&(await facts()).audit.length===requests,'invalid identity reached server');cleanSiblings();check((await facts()).settings_unchanged&&(await facts()).audit.every(r=>r.method==='GET'),'artifact client mutated Settings');
  print('OK: native small/large task artifacts through actual immutable store and artifact handler; displayed identity, exact bytes, lazy large stream, SHA/short/long/HTTP faults preserve existing destination, cancellation before held wire release and after verified sibling copy, retry and staging cleanup; chooser/wire/copy timing controlled, local filesystem tested');
 })().catch(e=>{failed=true;logError(e);print('Stage: '+stage);for(const d of reviews.dialogs)print(text(d))}).finally(async()=>{await control('release-all').catch(()=>{});if(pendingCopy)pendingCopy();reviews.close();gateway.close();observer.close();prototype.copy_async=copy;Gtk.FileDialog.prototype.save=save;Gtk.FileDialog.prototype.save_finish=finish;win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
