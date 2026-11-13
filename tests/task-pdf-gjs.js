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
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.PdfTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1100,default_height:1000});win.present();
 const gateway=new Gateway(ARGV[1],'fixture-secret'),observer=new Gateway(ARGV[1],'fixture-secret'),reviews=new TaskReviews(gateway),processes=[];
 const facts=()=>observer.json('GET','/fixture/facts'),control=(action,extra={})=>observer.json('POST','/fixture/control',{action,...extra});
 const spawn=Gio.SubprocessLauncher.prototype.spawnv;let hold=false,failRender=false,held,stage='real Poppler first page';
 Gio.SubprocessLauncher.prototype.spawnv=function(args){const tool=args[0].split('/').at(-1);let actual=args;if(hold&&tool==='pdfinfo'){hold=false;actual=[GLib.find_program_in_path('sleep'),'60']}if(failRender&&tool==='pdftoppm'){failRender=false;actual=[GLib.find_program_in_path('false')]}const p=spawn.call(this,actual);processes.push({tool,p});if(actual[1]==='60')held=p;return p};
 const picture=d=>all(d.get_child(),w=>w instanceof Gtk.Picture)[0];
 async function rendered(d,index){await until(()=>picture(d)?.get_paintable()&&picture(d).get_alternative_text()?.endsWith('страница '+index)&&button(d,'Перечитать PDF').sensitive,'page '+index+' did not render')}
 (async()=>{
  const f=await facts(),pdf=f.pdf,path=name=>'/api/tasks/'+pdf.task+'/artifacts/'+name,open=(name,identity=pdf.identities[name])=>{reviews.artifactPdf(win,name,path(name),identity);return [...reviews.dialogs].at(-1)};
  let d=open('preview.pdf');await rendered(d,1);check(text(d).includes('из 3')&&!button(d,'Назад').sensitive&&button(d,'Вперёд').sensitive,'page count/bounds wrong');let texture=picture(d).get_paintable();check(texture.get_height()===1600&&texture.get_width()<1600,'portrait raster dimensions wrong');click(d,'Вперёд');await rendered(d,2);texture=picture(d).get_paintable();check(texture.get_width()===1600&&texture.get_height()<1600,'landscape raster dimensions wrong');click(d,'Увеличить');check(!picture(d).can_shrink&&button(d,'Уместить'),'zoom state wrong');click(d,'Уместить');check(picture(d).can_shrink,'fit state wrong');
  stage='failed page render can retry without refetch';const requests=(await facts()).audit.length;failRender=true;click(d,'Вперёд');await until(()=>button(d,'Повторить страницу').visible&&button(d,'Перечитать PDF').sensitive,'failed page has no retry');check(!picture(d).get_paintable()&&!text(d).includes('Подготавливаю страницу'),'failed page kept old bitmap/busy state');click(d,'Повторить страницу');await rendered(d,3);check((await facts()).audit.length===requests&&!button(d,'Вперёд').sensitive,'page retry refetched or last boundary wrong');
  stage='selection changed during render eventually shows selected page';const page=all(d.get_child(),w=>w instanceof Gtk.SpinButton)[0];page.set_value(1);page.set_value(2);await rendered(d,2);check(page.get_value_as_int()===2,'spin and displayed page diverged');d.force_close();check(!picture(d).get_paintable(),'closed preview retained bitmap');
  stage='password and invalid PDF are explicit errors';d=open('locked.pdf');await until(()=>text(d).includes('Для чтения PDF нужен пароль.'),'locked PDF error missing');d.force_close();d=open('broken.pdf');await until(()=>text(d).includes('Poppler не смог прочитать PDF.'),'invalid PDF error missing');d.force_close();
  stage='known oversize is refused before GET';const count=(await facts()).audit.length;d=open('preview.pdf',{...pdf.identities['preview.pdf'],size:32*1024*1024+1});await until(()=>text(d).includes('Для просмотра PDF должен быть не больше'),'PDF size cap absent');check((await facts()).audit.length===count,'oversize PDF requested');d.force_close();
  stage='wire integrity checked before Poppler and reload recovers';await control('fault',{mode:'corrupt'});const processCount=processes.length;d=open('preview.pdf');await until(()=>text(d).includes('контрольная сумма'),'corrupt PDF not rejected');check(processes.length===processCount,'corrupt PDF reached Poppler');await control('fault',{mode:''});click(d,'Перечитать PDF');await rendered(d,1);
  stage='Poppler deadline restores reload';hold=true;click(d,'Перечитать PDF');await until(()=>text(d).includes('Подготовка страницы PDF заняла слишком много времени.')&&button(d,'Перечитать PDF').sensitive,'Poppler deadline did not stop held process');check(!held.get_successful(),'timed-out process succeeded');held=undefined;
  stage='close kills and reaps pending Poppler process';hold=true;click(d,'Перечитать PDF');await until(()=>held,'held pdfinfo process absent');const oldReload=button(d,'Перечитать PDF');d.force_close();let exited=false;held.wait_async(null,(p,r)=>{p.wait_finish(r);exited=true});await until(()=>exited,'closed PDF left Poppler running');check(!held.get_successful(),'held process unexpectedly succeeded');const before=processes.length,reads=(await facts()).audit.length;oldReload.emit('clicked');await wait(40);check(processes.length===before&&(await facts()).audit.length===reads,'closed reload started work');
  check((await facts()).settings_unchanged&&(await facts()).audit.every(r=>r.method==='GET'),'PDF preview mutated Settings');
  print('OK: native PDF through real immutable artifact endpoint and real pdfinfo/pdftoppm rasterization; three pages/portrait-landscape/zoom, render retry without GET, selection convergence, password/malformed/oversize/integrity errors, reload recovery, bitmap release and cancelled held subprocess exit; process failure/timing controlled, no WebView');
 })().catch(e=>{failed=true;logError(e);print('Stage: '+stage);for(const d of reviews.dialogs)print(text(d))}).finally(async()=>{reviews.close();for(const {p} of processes){try{p.force_exit()}catch{}}await control('release-all').catch(()=>{});gateway.close();observer.close();Gio.SubprocessLauncher.prototype.spawnv=spawn;win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
