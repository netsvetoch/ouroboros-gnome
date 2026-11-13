import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {SecretQuestion}=await import(ARGV[0]+'secrets.js');
const {sheet,column}=await import(ARGV[0]+'ui.js');
const check=(x,m)=>{if(!x)throw new Error(m)};
const wait=ms=>new Promise(r=>GLib.timeout_add(0,ms,()=>{r();return GLib.SOURCE_REMOVE}));
async function until(fn,m){for(let i=0;i<500;i++){if(await fn())return;await wait(20)}throw new Error(m)}
function all(w,p){let a=p(w)?[w]:[];for(let c=w.get_first_child?.();c;c=c.get_next_sibling())a.push(...all(c,p));return a}
const digest=s=>GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256,s,-1);
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.SecretLifetimeTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1100,default_height:950});win.present();
 const gateway=new Gateway(ARGV[1],'fixture-secret'),observer=new Gateway(ARGV[1],'fixture-secret');const forms=[],requests=[];let root,dialog,stage='held initial status';
 const original=gateway.json.bind(gateway);gateway.json=async(...args)=>{const r={method:args[0],path:args[1],action:args[2]?.action,cancel:args[5],done:false};requests.push(r);try{return await original(...args)}finally{r.done=true}};
 const facts=()=>observer.json('GET','/fixture/facts'),control=b=>observer.json('POST','/fixture/control',b);
 const create=async(q,parent=win)=>{const request=(await facts()).quizzes['secret-asker'][q].secret_request;const form=new SecretQuestion(parent,gateway,`quiz:secret-asker:${q}`,request,()=>{});forms.push(form);return form};
 const open=async(q)=>{const form=await create(q);win.set_content(form.widget);await until(()=>!form.busy&&form.latest,'initial status pending');return form};
 const hold=(q,operation='status')=>control({action:'hold',id:`quiz:secret-asker:${q}`,operation,fail:false});
 const held=()=>until(async()=>(await facts()).held,'primary request not accepted/held');
 const cancelled=async(r)=>{await until(()=>r.done,'request did not settle before server release');check(r.cancel?.is_cancelled(),'request lacked cancelled Gio.Cancellable')};
 (async()=>{
  await hold('before');let old=await create('before');win.set_content(old.widget);await held();const initial=requests.at(-1);old.close();await cancelled(initial);check(old.disposed&&old.inputs.size===0,'closed initial form retained fields');
  let current=await open('before');check(current.latest.state==='open'&&current.inputs.size===1&&!current.requestCancel.is_cancelled(),'reopened status did not have a fresh lifetime');await control({action:'release'});await wait(40);check(current.latest.state==='open','old status affected reopened form');current.close();
  stage='accepted save cancels without retry and reopening reads landed write';old=await open('fill');const first=old.inputs.get('fillToken'),second=old.inputs.get('fillRegion');const values=['lifetime-token-private-Ω-681','lifetime-region-private-🧭-682'];first.text=values[0];second.text=values[1];
  await hold('fill','save');old.save.emit('clicked');await held();const saving=requests.at(-1);check(saving.action==='save'&&first.text===''&&second.text==='','submitted values retained');old.close();await cancelled(saving);
  current=await open('fill');check(current.latest.state==='answered'&&current.inputs.size===0,'reopened form failed to read accepted save');let data=await facts();check(data.digests[data.fields.fillToken]===digest(values[0])&&data.digests[data.fields.fillRegion]===digest(values[1]),'accepted save changed values');
  let writes=data.audit.filter(x=>x.decision_id==='quiz:secret-asker:fill'&&x.action==='save');check(writes.length===1&&writes[0].observed.fillToken===false&&writes[0].observed.fillRegion===false,'save repeated or observed state changed');
  let count=requests.length;old.save.emit('clicked');old.reload.emit('clicked');old.cancel.emit('clicked');await wait(30);check(requests.length===count,'closed save form sent another request');await control({action:'release'});await wait(30);check(current.latest.state==='answered'&&!current.busy,'late save changed reopened form');current.close();
  stage='accepted cancellation closes transport without changing configured secret';await control({action:'set',field:'cancelToken',value:'lifetime-configured-private-695'});old=await open('cancel');const input=old.inputs.get('cancelToken');input.text='unsent-lifetime-private-696';old.cancel.emit('clicked');const confirmation=old.confirmation;await until(()=>confirmation.get_mapped(),'confirmation not mapped');
  await hold('cancel','cancel');const button=all(confirmation,w=>w instanceof Gtk.Button&&(w.label==='Отменить запрос'||all(w,l=>l instanceof Gtk.Label&&l.label==='Отменить запрос').length))[0];check(button,'native cancel button missing');button.emit('clicked');await held();const cancelling=requests.at(-1);old.close();await cancelled(cancelling);check(input.text==='','cancelled form retained input');
  current=await open('cancel');data=await facts();check(current.latest.state==='closed'&&data.digests[data.fields.cancelToken]===digest('lifetime-configured-private-695'),'reopened cancel failed or changed configured key');count=requests.length;confirmation.emit('response','ok');await wait(30);check(requests.length===count,'old confirmation submitted twice');await control({action:'release'});current.close();
  stage='parent dialog closes its pending status';const content=column();dialog=sheet('Secret lifetime fixture',content);dialog.present(win);await hold('damaged');old=await create('damaged',dialog);content.append(old.widget);await held();const nested=requests.at(-1);dialog.force_close();await cancelled(nested);check(old.disposed,'dialog did not retire secret controller');await control({action:'release'});
  stage='parent window closes its pending status';root=new Adw.ApplicationWindow({application:app,default_width:700,default_height:500});root.present();await hold('conflict');old=await create('conflict',root);root.set_content(old.widget);await held();const rooted=requests.at(-1);root.close();await cancelled(rooted);check(old.disposed&&!old.parentSignal,'root did not retire/disconnect secret controller');await control({action:'release'});
  data=await facts();check(!data.leaks.length&&data.unrelated==='keep','synthetic credential leaked or unrelated settings changed');check(requests.every(r=>r.cancel instanceof Gio.Cancellable),'secret request omitted lifetime cancellation');
  print('OK: actual primary secret status/save/cancel requests settle on native close before held response release; fresh reopen reads landed save/cancel without retry, exact configured values preserved, fields cleared, stale callbacks inert, dialog/window lifecycle cancellation and non-Settings canary scan verified');
 })().catch(e=>{failed=true;logError(e);print('Stage: '+stage)}).finally(async()=>{for(const f of forms)f.close();await control({action:'release'}).catch(()=>{});dialog?.force_close();root?.close();gateway.close();observer.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
