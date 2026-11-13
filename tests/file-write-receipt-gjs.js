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
function all(w,p){let out=p(w)?[w]:[];for(let c=w.get_first_child?.();c;c=c.get_next_sibling())out.push(...all(c,p));return out}
const button=(d,s)=>all(d.get_child(),w=>w instanceof Gtk.Button&&w.label===s)[0];
const text=d=>all(d.get_child(),w=>w instanceof Gtk.Label).map(w=>w.label).join('\n');
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.FileWriteReceiptTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1100,default_height:900});win.present();
 const gateway=new Gateway(ARGV[1],''),page=new FilesPage(win,gateway);win.set_content(page.widget);let dialog,stage='initial listing';
 const facts=()=>gateway.json('GET','/fixture/facts'),control=b=>gateway.json('POST','/fixture/control',b),writes=()=>facts().then(d=>d.audit.filter(r=>r.method==='POST'&&r.path==='/api/files/write').length);
 const open=async()=>{await control({fault:''});page.openPreview({name:'note.txt',path:'note.txt',type:'file'});dialog=[...page.dialogs].at(-1);await until(()=>button(dialog,'Редактировать').visible,'native editor missing');button(dialog,'Редактировать').emit('clicked');return all(dialog.get_child(),w=>w instanceof Gtk.TextView&&w.editable)[0].buffer};
 const draft=b=>b.get_text(b.get_start_iter(),b.get_end_iter(),true);
 (async()=>{
  await page.refresh();
  for(const mode of ['missing','negative','string','boolean','fraction','short','long','path','ok','loss']){
   stage='actual write with malformed '+mode+' receipt';const buffer=await open(),value='  Native '+mode+' Ω 🧭\n<&> trailing  \n';buffer.set_text(value,-1);const before=await writes();await control({fault:'write-'+mode});const save=button(dialog,'Сохранить на шлюзе');save.emit('clicked');save.emit('clicked');await until(()=>text(dialog).includes('Итог записи неизвестен'),'bad receipt marked confirmed '+mode);check(draft(buffer)===value&&buffer.get_modified()&&!save.sensitive&&button(dialog,'Проверить содержимое на шлюзе').visible,'bad receipt cleared/unlocked draft '+mode);check((await facts()).content===value&&(await writes())===before+1,'write did not land once '+mode);
   save.emit('clicked');await wait(30);check((await writes())===before+1,'unknown receipt replayed '+mode);await control({fault:''});button(dialog,'Проверить содержимое на шлюзе').emit('clicked');await until(()=>text(dialog).includes('Содержимое на шлюзе совпадает с черновиком.'),'readback did not recover '+mode);check(!buffer.get_modified()&&button(dialog,'Редактировать').visible&&(await writes())===before+1,'readback repeated write or kept dirty flag '+mode);dialog.force_close();
  }
  stage='valid exact Unicode and empty byte receipts';for(const value of [' Ω 🧭\n<&>  \n','']){const buffer=await open();buffer.set_text(value,-1);const before=await writes();button(dialog,'Сохранить на шлюзе').emit('clicked');await until(()=>text(dialog).includes('Шлюз подтвердил запись.'),'valid receipt not accepted');check((await facts()).content===value&&!buffer.get_modified()&&(await writes())===before+1,'valid exact write wrong');dialog.force_close()}
  stage='changed remote version after unknown write';const buffer=await open(),value='Retained private draft Ω\n';buffer.set_text(value,-1);await control({fault:'write-short'});button(dialog,'Сохранить на шлюзе').emit('clicked');await until(()=>text(dialog).includes('Итог записи неизвестен'),'unknown conflict setup absent');await control({fault:''});await gateway.json('POST','/api/files/write',{path:'note.txt',content:'Concurrent actual writer\n'});const count=await writes();button(dialog,'Проверить содержимое на шлюзе').emit('clicked');await until(()=>text(dialog).includes('Содержимое файла на шлюзе изменилось.'),'readback conflict not shown');check(draft(buffer)===value&&buffer.get_modified()&&!button(dialog,'Сохранить на шлюзе').sensitive&&(await facts()).content==='Concurrent actual writer\n'&&(await writes())===count,'conflict overwrote remote or draft');dialog.force_close();
  print('OK: native file editor through actual primary read/content/write and temporary disk; missing/negative/string/boolean/fractional/short/long size, wrong path, malformed ok and lost acknowledgement retain dirty draft, block replay and recover by GET without duplicate write; valid Unicode/empty receipts accepted, concurrent remote change remains conflict. Response faults controlled; no user files or portal.');
 })().catch(e=>{failed=true;logError(e);print('Stage: '+stage);if(dialog)print(text(dialog))}).finally(async()=>{await control({action:'release-all'}).catch(()=>{});page.close();gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
