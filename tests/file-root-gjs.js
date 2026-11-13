import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {FilesPage}=await import(ARGV[0]+'files.js');
const check=(v,m)=>{if(!v)throw new Error(m)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,m){for(let i=0;i<1000;i++){if(await fn())return;await wait(20)}throw new Error(m)}
function all(w,p){let out=p(w)?[w]:[];for(let c=w.get_first_child?.();c;c=c.get_next_sibling())out.push(...all(c,p));return out}
const text=w=>all(w,w=>w instanceof Gtk.Label).map(w=>w.label).join('\n');
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.FileRootTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1000,default_height:1000});win.present();const gateway=new Gateway(ARGV[1],'fixture-secret'),page=new FilesPage(win,gateway);win.set_content(page.widget);let stage='root-bound read';
 const control=body=>gateway.json('POST','/fixture/control',body),facts=()=>gateway.json('GET','/fixture/facts');
 const entry=()=>page.listing.entries.find(e=>e.name==='note.txt');
 const writes=async()=>(await facts()).audit.filter(r=>r.path==='/api/files/write').length;
 const open=()=>{page.openPreview(entry());return [...page.previews].at(-1)};
 const ready=p=>until(()=>p.baseline||text(p.dialog).includes('сведения')||text(p.dialog).includes('Корень файлов'),'preview not settled');
 (async()=>{
  check(await page.refresh(),'real listing unavailable');const initial=await facts(),root=page.listing.root_path;check(typeof root==='string','actual root absent');
  const initialListing=page.listing;await control({fault:'list-root'});check(!await page.refresh()&&page.listing===initialListing,'malformed list root replaced current listing');await control({fault:''});await page.refresh();
  for(const fault of ['read-root','read-root-missing']){
   await control({fault});const p=open();await until(()=>text(p.dialog).includes(fault==='read-path'?'другому пути':fault==='read-root'?'неполные сведения':'Корень файлов'),'bad identity not diagnosed');
   check(!p.baseline&&!p.edit.visible&&!p.text.editable,'bad identity enabled editing');p.close();await control({fault:''});
  }
  stage='real root change between list and preview';await control({action:'root',alternate:true});let p=open();await until(()=>text(p.dialog).includes('Корень файлов'),'root change before open accepted');check(!p.baseline&&!p.edit.visible,'wrong-root preview editable');p.close();await control({action:'root',alternate:false});
  stage='existing edit cannot write same bytes under another root';p=open();await until(()=>p.baseline,'normal preview absent');p.setEditing(true);const draft='Private draft <&> Ω\n';p.buffer.set_text(draft,-1);
  await control({action:'root',alternate:true});await p.saveEdit();check(text(p.dialog).includes('Корень файлов')&&p.draft()===draft&&await writes()===0,'changed root wrote or erased draft');
  let f=await facts();check(f.files['note.txt']===initial.files['note.txt']&&f.alternate_files['note.txt']===initial.alternate_files['note.txt'],'root mismatch modified either file');
  await control({action:'root',alternate:false});await control({fault:'read-path'});await p.saveEdit();check(text(p.dialog).includes('другому пути')&&await writes()===0,'foreign reread wrote');
  await control({fault:'read-root-missing'});await p.saveEdit();check(text(p.dialog).includes('Корень файлов')&&await writes()===0,'missing known root became compatible');await control({fault:''});
  await p.saveEdit();check(await writes()===1&&!p.buffer.get_modified()&&p.baseline.root_path===root&&(await facts()).content===draft,'restored root could not save exact draft');p.close();
  stage='new file checks current parent root even after target 404';await page.refresh();page.openPreview({name:'new.txt',path:'new.txt',type:'file'},true);p=[...page.previews].at(-1);await wait(20);p.buffer.set_text('New original-root file Ω\n',-1);
  await control({fault:'list-404'});await p.saveEdit();check(await writes()===1&&text(p.dialog).includes('fixture parent missing'),'parent 404 became target absence and allowed POST');await control({fault:''});
  await control({action:'root',alternate:true});await p.saveEdit();check(text(p.dialog).includes('Корень файлов')&&await writes()===1&&p.draft()==='New original-root file Ω\n','new file creation retargeted by 404');
  await control({action:'root',alternate:false});await p.saveEdit();check(await writes()===2&&!p.buffer.get_modified(),'original-root create failed');check(!(await facts()).alternate_files['new.txt'],'new file leaked to alternate root');p.close();
  stage='unknown write acknowledgement cannot reconcile against different root';await page.refresh();p=open();await until(()=>p.baseline,'second preview absent');p.setEditing(true);p.buffer.set_text('Unconfirmed write Ω\n',-1);await control({fault:'write-loss'});await p.saveEdit();check(p.blocked,'lost write did not remain unknown');await control({fault:''});await control({action:'root',alternate:true});await p.verifyEdit();check(p.blocked&&text(p.dialog).includes('Корень файлов')&&p.draft()==='Unconfirmed write Ω\n','readback accepted different root');
  await control({action:'root',alternate:false});await p.verifyEdit();check(!p.blocked&&!p.buffer.get_modified()&&(await facts()).content==='Unconfirmed write Ω\n','exact root readback did not reconcile actual write');p.close();
  stage='symlink lexical identity remains supported';await control({action:'symlink'});await page.refresh();page.openPreview(page.listing.entries.find(e=>e.name==='alias.txt'));p=[...page.previews].at(-1);await until(()=>p.baseline,'symlink preview refused');check(p.baseline.path==='note.txt'&&p.baseline.root_path===root&&p.edit.visible,'valid canonical alias rejected');p.setEditing(true);p.buffer.set_text('Do not write retargeted alias',-1);await control({action:'retarget-alias'});await p.saveEdit();check(text(p.dialog).includes('другому пути')&&await writes()===3&&p.draft()==='Do not write retargeted alias','retargeted symlink wrote another file');p.close();
  stage='legacy absent root remains readable';await control({fault:'legacy-root'});await page.refresh();p=open();await until(()=>p.baseline,'legacy rootless read refused');check(p.baseline.root_path===undefined&&p.edit.visible,'legacy rootless preview disabled');p.close();await control({fault:''});
  check((await facts()).audit.filter(r=>r.path==='/api/files/write').length===3,'extra writes or automatic retry');
  print('OK: native Files editor bound to actual declared root/path across preview, pre-write, new-file parent check and lost-ack readback; real root configuration switches between isolated same-content files never retarget writes, restored root allows exact save/create/readback, changed resolved path/malformed/missing root is readonly, canonical symlink target remains compatible; three actual writes, controlled malformed receipts/root timing, no atomic server CAS claim');
 })().catch(error=>{failed=true;logError(error);print('Stage: '+stage)}).finally(async()=>{await control({action:'root',alternate:false,fault:''}).catch(()=>{});page.close();gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
