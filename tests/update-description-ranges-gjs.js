import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {Updates}=await import(ARGV[0]+'updates.js');
const {RuntimeCommands}=await import(ARGV[0]+'commands.js');
const check=(v,m)=>{if(!v)throw new Error(m)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,m){for(let i=0;i<1200;i++){if(await fn())return;await wait(20)}throw new Error(m)}
function all(w,p){let out=p(w)?[w]:[];for(let c=w.get_first_child?.();c;c=c.get_next_sibling())out.push(...all(c,p));return out}
const button=(w,name)=>all(w,w=>w instanceof Gtk.Button&&w.label===name)[0];
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.DescriptionRangesTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1100,default_height:1000});win.present();const gateway=new Gateway(ARGV[1],'fixture-secret'),observer=new Gateway(ARGV[1],'fixture-secret'),commands=new RuntimeCommands(win,gateway,()=>undefined),view=new Updates(win,gateway,commands,()=>{});let response,stage='first saved description';
 const facts=()=>observer.json('GET','/fixture/facts'),control=(action,extra={})=>observer.json('POST','/fixture/control',{action,...extra}),requests=async()=>(await facts()).audit.filter(r=>r.path==='/api/update/description');
 const original=Adw.AlertDialog.prototype.present;Adw.AlertDialog.prototype.present=function(parent){original.call(this,parent);check(response,'unexpected confirmation');const answer=response;response=undefined;GLib.idle_add(0,()=>{this.emit('response',answer);this.close();return GLib.SOURCE_REMOVE})};
 const idle=()=>until(()=>!view.busy&&!view.reading,'update operation pending');
 const click=name=>{const b=button(view.dialog.get_child(),name);check(b?.sensitive,'button unavailable: '+name);b.emit('clicked')};
 const finish=async text=>{await control('finish-description',{text});await view.refresh(true)};
 (async()=>{
  view.show();await idle();await view.check();await idle();let f=await facts();const base=f.base,first=f.target;
  response='ok';click('Запросить описание обновления…');await idle();check((await requests()).length===1&&view.status.letter.request.key.target_sha===first,'first real admission failed');await finish('# First saved range\n\nOriginal wording.');
  check(button(view.dialog.get_child(),'Переписать описание…')&&!button(view.dialog.get_child(),'Переписать сохранённое описание…'),'single range duplicated');
  stage='new offer retains saved-range rewrite choice';await control('release',{version:'7.10.2'});await view.check();await idle();f=await facts();const second=f.target;
  check(second!==first&&view.status.letter.checked_key.target_sha===second&&view.status.letter.key.target_sha===first,'two actual ranges not retained');
  const saved=button(view.dialog.get_child(),'Переписать сохранённое описание…'),latest=button(view.dialog.get_child(),'Запросить описание обновления…');check(saved?.sensitive&&latest?.sensitive&&saved.get_tooltip_text().includes(first)&&latest.get_tooltip_text().includes(second),'native range choices or exact tooltips missing');
  response='cancel';saved.emit('clicked');await idle();check((await requests()).length===1,'declined saved-range rewrite sent request');
  stage='saved-range rewrite with lost receipt reconciles its own range';await control('fault',{values:{description:'lost'}});response='ok';click('Переписать сохранённое описание…');await idle();let rows=await requests();check(rows.length===2&&rows[1].body.mode==='rewrite'&&rows[1].body.base_sha===base&&rows[1].body.target_sha===first,'rewrite silently targeted new offer');
  check(!view.letterSubmission&&view.status.letter.request.key.target_sha===first&&view.status.letter.checked_key.target_sha===second,'lost saved-range receipt not reconciled independently');check(!button(view.dialog.get_child(),'Запросить описание обновления…').sensitive&&!button(view.dialog.get_child(),'Переписать сохранённое описание…').sensitive,'one live description allowed a competing request');await wait(50);check((await requests()).length===2,'lost receipt auto replayed');
  await finish('# Rephrased saved range\n\nStill the first range.');check(view.status.letter.key.target_sha===first&&view.status.letter.checked_key.target_sha===second&&view.status.letter.text.includes('Rephrased saved range'),'actual saved rewrite relabelled old text with new range');
  stage='latest range stays explicitly selectable';response='ok';click('Запросить описание обновления…');await idle();rows=await requests();check(rows.length===3&&rows[2].body.mode==='write'&&rows[2].body.target_sha===second,'new offer cannot be selected after saved rewrite');await finish('# Second saved range\n\nLatest range text.');check(view.status.letter.key.target_sha===second&&!button(view.dialog.get_child(),'Переписать сохранённое описание…')&&button(view.dialog.get_child(),'Переписать описание…'),'equal ranges did not deduplicate');
  stage='preflight rejects saved range removed by another writer';await control('release',{version:'7.10.3'});await view.check();await idle();const third=(await facts()).target,stale=button(view.dialog.get_child(),'Переписать сохранённое описание…');check(stale?.sensitive,'third range choice absent');
  const external=await observer.json('POST','/api/update/description',{mode:'write',base_sha:base,target_sha:third});check(external.status==='queued','other owner request not admitted');await control('finish-description',{text:'# Third saved range\n\nWritten by another explicit request.'});
  const before=(await requests()).length;response='ok';stale.emit('clicked');await idle();check((await requests()).length===before&&view.feedback.includes('Предлагаемый диапазон')&&!view.letterSubmission,'stale saved-range choice was posted after fresh read');
  stage='closed saved-range action remains inert';await control('release',{version:'7.10.4'});await view.check();await idle();const closed=button(view.dialog.get_child(),'Переписать сохранённое описание…');view.close();closed.emit('clicked');await wait(30);f=await facts();check((await requests()).length===before&&f.settings_unchanged&&f.head===base&&!f.applies.length&&!f.commands.length,'closed action sent work or viewer applied update/changed Settings');
  print('OK: native independent latest-offer Write and saved-range Rewrite through real description admission/store writer/local Git check; exact pins, declined confirmation, lost saved-range receipt readback without replay, both actions blocked by one live request, same-range deduplication, fresh preflight rejects another writer replacing saved range, closed action inert; no model worker/apply/restart');
 })().catch(error=>{failed=true;logError(error);print('Stage: '+stage)}).finally(async()=>{await control('release-all').catch(()=>{});view.close();commands.close();Adw.AlertDialog.prototype.present=original;gateway.close();observer.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
