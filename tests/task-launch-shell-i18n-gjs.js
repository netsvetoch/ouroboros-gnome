import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {TaskLaunch,renderAttachmentManifest}=await import(ARGV[0]+'task-launch.js');
const {NativeI18n,useNativeI18n}=await import(ARGV[0]+'native-i18n.js');
const check=(x,m)=>{if(!x)throw new Error(m)};
const wait=ms=>new Promise(r=>GLib.timeout_add(0,ms,()=>{r();return GLib.SOURCE_REMOVE}));
async function until(fn,m){for(let i=0;i<600;i++){if(await fn())return;await wait(20)}throw new Error(m)}
function all(w,p,seen=new Set()){if(!w||seen.has(w))return [];seen.add(w);let a=p(w)?[w]:[];for(let c=w.get_first_child?.();c;c=c.get_next_sibling())a.push(...all(c,p,seen));if(w instanceof Gtk.Expander)a.push(...all(w.get_child(),p,seen));return a}
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.LaunchShellI18nTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1100,default_height:950});win.present();
 const gateway=new Gateway(ARGV[1],'fixture-secret'),catalog=new NativeI18n(gateway);useNativeI18n(catalog);const launch=new TaskLaunch(win,gateway,()=>{},()=>{});let socket,stage='unconfirmed launch';
 const facts=()=>gateway.json('GET','/fixture/facts'),language=language=>gateway.json('POST','/api/ui/i18n/language',{language});
 const room={chatId:1,name:'Private shell room 819'};
 const open=id=>{launch.show(room);const form=launch.openDialog;form.editor.fields.get('description').set('Private shell description 821');form.editor.fields.get('task_id').set(id);return form};
 const stored=()=>{const [,bytes]=GLib.file_get_contents(launch.location);return new TextDecoder().decode(bytes)};
 (async()=>{
  socket=await gateway.connect('/ws',new Gio.Cancellable());socket.connect('message',(_s,t,b)=>{if(t===1)catalog.frame(JSON.parse(new TextDecoder().decode(b.get_data())))});await until(()=>catalog.language!==undefined,'language missing');let form=open('gtk-before');
  check(form.dialog.title==='New task'&&form.submit.label==='Launch'&&form.serverPath.placeholder_text==='File path on gateway','English shell missing');form.submit.emit('clicked');await until(()=>!form.busy,'unconfirmed launch pending');check(form.pending&&!form.retry&&!form.submit.visible&&form.status.label.startsWith('Launch unconfirmed'),'lost result displayed as confirmed/retry');
  const body=JSON.stringify(form.pending.body),disk=stored();
  const pairs={'New task':'QAA New task','Launch':'QAA Launch','Retry with the same ID':'QAA Retry','Upload file…':'QAA Upload','Cancel upload':'QAA Cancel upload','Check gateway receipt':'QAA Check','Leave without retrying':'QAA Leave','Open task':'QAA Open','Add path':'QAA Add','Remove':'QAA Remove','File path on gateway':'QAA File path','Attachment label (optional)':'QAA Attachment label','Saved request · {room}':'QAA Saved {room}','Launch outcome unknown · {id}':'QAA Unknown {id}','Launch unconfirmed · {id} · {detail}':'QAA Unconfirmed {id} {detail}','No saved record yet · {id}. You can retry the original request.':'QAA Missing {id}','Gateway confirmed launch · {id}{state}{detail}':'QAA Confirmed {id}{state}{detail}','Attachment intake · {n} rejected':'QAA Intake {n} rejected','{item} · Staged{detail}':'{item} · QAA Staged{detail}','{item} · Rejected{detail}':'{item} · QAA Rejected{detail}','Preparing · {bytes} of {total}':'QAA Prepare {bytes}/{total}','Uploading · {bytes} of {total}':'QAA Upload {bytes}/{total}','File sent. Waiting for gateway confirmation…':'QAA Waiting receipt','Private shell room 819':'DO NOT TRANSLATE ROOM'};
  const pack=()=>({language:'qaa',entries:Object.fromEntries(Object.entries(pairs).map(([k,text])=>[k,{text}]))});
  await gateway.json('POST','/api/ui/i18n/import',pack());await language('qaa');await until(()=>form.dialog.title==='QAA New task'&&form.status.label.startsWith('QAA Unconfirmed'),'unconfirmed shell not repainted');
  check(form.check.label==='QAA Check'&&form.discard.label==='QAA Leave'&&!form.submit.visible&&JSON.stringify(form.pending.body)===body&&stored()===disk,'locale changed retry/durable request');
  form.dialog.force_close();launch.show(room);form=launch.openDialog;check(form.status.label==='QAA Unknown gtk-before'&&JSON.stringify(form.pending.body)===body&&all(form.content,w=>w instanceof Gtk.Label&&w.label==='QAA Saved Private shell room 819').length,'reopen failed to preserve pending identity/heading');
  form.check.emit('clicked');await until(()=>!form.busy,'absence check pending');check(form.retry&&form.submit.visible&&form.submit.label==='QAA Retry'&&form.status.label==='QAA Missing gtk-before','404 did not offer original request');
  pairs['No saved record yet · {id}. You can retry the original request.']='QAA Revised missing {id}';await gateway.json('POST','/api/ui/i18n/import',pack());await until(()=>form.status.label==='QAA Revised missing gtk-before','retry status revision not applied');check(JSON.stringify(form.pending.body)===body&&stored()===disk,'revision changed persisted request');
  form.submit.emit('clicked');await until(()=>!form.busy,'retry pending');let data=await facts();check(form.confirmed==='gtk-before'&&form.openTask.label==='QAA Open'&&form.status.label.startsWith('QAA Confirmed'),'retry not confirmed/localized');const attempts=data.requests.filter(x=>x.task_id==='gtk-before');check(attempts.length===2&&attempts.every(x=>JSON.stringify(x)===body)&&data.pending.filter(x=>x.id==='gtk-before').length===1,'locale changed exact replay or duplicated work');form.dialog.force_close();
  stage='progress and actual attachment manifest';form=open('gtk-shell-partial');const fixture=await facts();
  form.progress({phase:'preparing',bytes:128,total:256});check(form.status.label.startsWith('QAA Prepare'),'prepare progress untranslated');form.progress({phase:'sending',bytes:256,total:256});check(form.status.label.startsWith('QAA Upload'),'upload progress untranslated');form.progress({phase:'confirming',bytes:256,total:256});check(form.status.label==='QAA Waiting receipt','confirming progress untranslated');
  const add=(path,name)=>{form.serverPath.text=path;form.serverLabel.text=name;all(form.editor.attachments,w=>w instanceof Gtk.Button&&w.label==='QAA Add')[0].emit('clicked')};add(fixture.source,'Private staged label 822');add(fixture.missing,'Private rejected label 823');
  check(all(form.attachmentList,w=>w instanceof Gtk.Button&&w.label==='QAA Remove').length===2,'attachment actions untranslated');form.submit.emit('clicked');await until(()=>!form.busy,'partial launch pending');check(form.confirmed==='gtk-shell-partial','partial launch refused');
  check(all(form.receipt,w=>w instanceof Gtk.Expander&&w.label==='QAA Intake 1 rejected').length&&all(form.receipt,w=>w instanceof Gtk.Label&&w.label.includes('Private staged label 822 · QAA Staged')).length&&all(form.receipt,w=>w instanceof Gtk.Label&&w.label.includes('Private rejected label 823 · QAA Rejected')).length,'manifest labels/statuses untranslated or owner data changed');
  await language('en');await until(()=>form.dialog.title==='New task'&&all(form.receipt,w=>w instanceof Gtk.Expander&&w.label==='Attachment intake · 1 rejected').length,'live manifest not reverted');check(form.confirmed==='gtk-shell-partial','locale changed accepted task');
  await language('qaa');await until(async()=>(await facts()).i18n_audit.length,'missing report absent');const wire=JSON.stringify((await facts()).i18n_audit);check(!['Private shell','Private staged','Private rejected','gtk-before','gtk-shell-partial',fixture.source].some(x=>wire.includes(x)),'private data used as missing source');
  print('OK: native task shell language/revision preserves persisted unknown launch and exact same-ID replay through real primary admission; reopen/404/accepted receipts, progress captions, actual partial attachment manifest live status/data isolation and missing reports verified');
 })().catch(e=>{failed=true;logError(e);print('Stage: '+stage)}).finally(()=>{launch.close();catalog.close();socket?.close(1000,null);gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
