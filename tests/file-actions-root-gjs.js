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
const button=(w,name)=>all(w,w=>w instanceof Gtk.Button&&w.label===name)[0];
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.FileActionsRootTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1000,default_height:1000});win.present();const gateway=new Gateway(ARGV[1],'fixture-secret'),pages=[];let page=new FilesPage(win,gateway);pages.push(page);win.set_content(page.widget);let stage='source and destination roots';
 const control=body=>gateway.json('POST','/fixture/control',body),facts=()=>gateway.json('GET','/fixture/facts');
 const mutations=async()=>(await facts()).audit.filter(r=>r.method==='POST');
 const select=name=>{const pair=[...page.entries].find(([,entry])=>entry.name===name);check(pair,'entry absent: '+name);page.list.select_row(pair[0])};
 const root=alternate=>control({action:'root',alternate});
 const originalPresent=Adw.AlertDialog.prototype.present;let confirmation;
 Adw.AlertDialog.prototype.present=function(parent){confirmation=this;originalPresent.call(this,parent)};
 const approve=async action=>{confirmation=undefined;const pending=action();await until(()=>confirmation,'confirmation absent');confirmation.emit('response','ok');confirmation.force_close();await pending};
 (async()=>{
  await control({action:'setup-actions'});await page.refresh();const initial=await facts(),origin=page.listing.root_path;
  select('note.txt');page.queueTransfer('copy');check(page.transfer.root===origin,'source root not captured');await root(true);await page.navigate('destination');await page.pasteEntry();
  check((await mutations()).length===0&&page.transferResult.state==='refused'&&page.transferResult.message.includes('одного подтверждённого корня'),'source selection crossed roots or became unknown');
  await root(false);await page.navigate('destination');await page.pasteEntry();check(page.transferResult.state==='confirmed'&&(await facts()).files['destination/note.txt'],'same-root copy did not recover');
  stage='root changes after destination read';await page.navigate('.');select('source-move.txt');page.queueTransfer('move');await page.navigate('destination');await root(true);await page.pasteEntry();check((await mutations()).length===1&&page.transferResult.state==='refused','late root change sent move');
  await root(false);await page.pasteEntry();let f=await facts();check(page.transferResult.state==='confirmed'&&!f.files['source-move.txt']&&f.files['destination/source-move.txt']&&f.alternate_files['source-move.txt'],'same-root move failed or modified alternate');
  stage='delete confirmation keeps original root';await page.navigate('.');select('note.txt');confirmation=undefined;let pending=page.remove();await until(()=>confirmation,'delete confirmation absent');await root(true);confirmation.emit('response','ok');confirmation.force_close();await pending;
  check((await mutations()).length===2&&page.status.label.includes('Корень файлов')&&(await facts()).files['note.txt']===initial.files['note.txt'],'confirmed delete crossed root');
  await root(false);await page.refresh();select('note.txt');await approve(()=>page.remove());f=await facts();check(!f.files['note.txt']&&f.alternate_files['note.txt']===initial.alternate_files['note.txt'],'delete did not affect exact original root');
  stage='mkdir form keeps root and draft';await page.refresh();page.create('dir');let dialog=[...page.dialogs].at(-1),name=all(dialog,w=>w instanceof Gtk.Entry)[0];name.text='Created folder <&>';await root(true);button(dialog,'Создать').emit('clicked');await until(()=>!page.mutating&&text(dialog).includes('Корень файлов'),'mkdir root failure absent');check((await mutations()).length===3&&name.text==='Created folder <&>','mkdir crossed root or lost name');
  await root(false);button(dialog,'Создать').emit('clicked');await until(()=>!page.mutating&&!page.dialogs.has(dialog),'mkdir recovery pending');check((await mutations()).length===4&&page.listing.entries.some(e=>e.name==='Created folder <&>'),'same-root mkdir failed');
  stage='new-file form root survives intervening navigation';page.create('file');dialog=[...page.dialogs].at(-1);all(dialog,w=>w instanceof Gtk.Entry)[0].text='Form file.txt';await root(true);await page.navigate('.');button(dialog,'Открыть редактор').emit('clicked');let preview=[...page.previews].at(-1);await until(()=>preview?.editing,'new-file editor absent');preview.buffer.set_text('Original form draft Ω\n',-1);await preview.saveEdit();check((await mutations()).length===4&&text(preview.dialog).includes('Корень файлов'),'new-file form took current root instead of captured root');
  await root(false);await preview.saveEdit();check((await mutations()).length===5&&(await facts()).files['Form file.txt']&&!(await facts()).alternate_files['Form file.txt'],'original form root did not recover');preview.close();
  stage='unknown transfer observations reject other root';await page.navigate('.');select('unknown.txt');page.queueTransfer('copy');await page.navigate('destination');await control({fault:'transfer-loss'});await page.pasteEntry();check(page.transferResult.state==='unknown','lost transfer receipt accepted');await control({fault:''});await root(true);await page.verifyTransfer();check(page.transferResult.state==='unknown'&&page.transferResult.observation.includes('корень файлов изменился')&&!page.transferResult.observation.includes('элемент найден')&&!page.transferResult.observation.includes('элемент отсутствует'),'readback reported foreign-root file facts');
  await root(false);await page.verifyTransfer();check(page.transferResult.observation.includes('элемент найден')&&(await mutations()).length===6,'original root readback missing or replayed transfer');
  stage='close cancels accepted root preflight';page.transfer=page.transferResult=undefined;await page.navigate('.');select('unknown.txt');page.queueTransfer('move');await page.navigate('destination');await control({hold:'list'});const before=(await facts()).audit.length;pending=page.pasteEntry();await until(async()=>(await facts()).audit.length>before,'root preflight not accepted');page.close();await pending;check((await mutations()).length===6,'closed preflight still posted transfer');await control({action:'release-all'});
  page=new FilesPage(win,gateway);pages.push(page);win.set_content(page.widget);await page.refresh();select('unknown.txt');confirmation=undefined;pending=page.remove();await until(()=>confirmation,'close delete confirmation absent');page.close();await pending;confirmation.emit('response','ok');confirmation.force_close();await wait(30);check((await mutations()).length===6,'closed confirmation sent delete');
  print('OK: native Files copy/move/delete/mkdir and new-file form retain original root through selection, navigation and owner confirmation; real configured-root swaps refuse before POST, original root recovers actual effects, lost transfer readback does not report foreign files or replay, close cancels preflight/confirmation; six actual mutations in isolated disk, no atomic server CAS claim');
 })().catch(error=>{failed=true;logError(error);print('Stage: '+stage)}).finally(async()=>{await control({action:'release-all',fault:''}).catch(()=>{});for(const p of pages)p.close();Adw.AlertDialog.prototype.present=originalPresent;gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
