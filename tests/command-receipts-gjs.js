import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {ChatPage}=await import(ARGV[0]+'chat.js');
const {RuntimeCommands}=await import(ARGV[0]+'commands.js');
const {Skills}=await import(ARGV[0]+'skills.js');
const {startSetupConsciousness}=await import(ARGV[0]+'onboarding-receipt.js');
const {commandAccepted}=await import(ARGV[0]+'command-receipt.js');
const check=(v,m)=>{if(!v)throw new Error(m)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,m){for(let i=0;i<700;i++){if(await fn())return;await wait(20)}throw new Error(m)}
function all(w,p){let a=p(w)?[w]:[];for(let c=w.get_first_child?.();c;c=c.get_next_sibling())a.push(...all(c,p));return a}
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.CommandReceiptsTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1100,default_height:950}),gateway=new Gateway(ARGV[1],'fixture-secret'),observer=new Gateway(ARGV[1],'fixture-secret'),commands=new RuntimeCommands(win,gateway,()=>undefined);let chat,skills,stage='bootstrap';
 const facts=()=>observer.json('GET','/fixture/facts'),control=reply=>observer.json('POST','/fixture/control',{action:'command-reply',reply}),posts=async()=>(await facts()).audit.filter(x=>x.method==='POST'&&x.path==='/api/command');
 (async()=>{
  commands.observeBoot((await facts()).boot);chat=new ChatPage(win,gateway,{chatId:1,name:'Main'},()=>{},undefined,commands);win.set_content(chat.widget);win.present();await until(()=>chat.socket.online&&!chat.draft.recovering,'chat not ready');chat.composer.text='Private quoted command source Ω';chat.send.emit('clicked');await until(()=>!chat.draft.pending&&chat.composer.text==='','source not sent');chat.refresh();await until(()=>chat.current.some(x=>x.text==='Private quoted command source Ω'&&x.row_address),'source history missing');let source=chat.current.find(x=>x.text==='Private quoted command source Ω').row_address;const replyButton=all(chat.list,w=>w instanceof Gtk.Button&&w.label==='Ответить')[0];replyButton.emit('clicked');check(chat.draft.reply===source,'native quote missing');
  stage='malformed command admission receipts retain native draft and quote';
  const bad=[null,[],{},{status:'ok',ok:false},{status:'ok',accepted:false},{status:'ok',ok:'true'},{status:'ok',deduped:'false'},{status:'ok',accepted:'true'},{status:'ok',task_id:[]},{status:'ok',reason_code:{}},{status:'ok',error:'post-admission problem'},{status:'changed'},{ok:true,deduped:true,task_id:'foreign-id'},{status:'ok',ok:true,deduped:true,task_id:'foreign-id'}];
  const startCount=(await posts()).length,inboxBefore=(await facts()).inbox.length;
  for(const [i,body] of bad.entries()){
   stage='malformed runtime receipt '+i;await control({body});chat.composer.text='/review';chat.send.emit('clicked');await until(()=>!chat.draft.commandPending,'command pending');check(chat.composer.text==='/review'&&chat.draft.reply===source,'malformed positive command cleared draft/quote');check(chat.sendStatus.label.includes('не подтвердил'),'malformed receipt shown accepted');check((await posts()).length===startCount+i+1,'malformed receipt automatically replayed');
  }
  check((await facts()).inbox.length===inboxBefore+bad.length,'fault preceded actual command admission');
  for(const [i,body] of [{accepted:false,error:[],reason_code:'boot_changed'},{accepted:false,error:'problem',reason_code:[]},{accepted:false,error:'problem',status:'ok'},{accepted:'false',error:'problem'},{accepted:false,error:'   '}].entries()){
   stage='malformed HTTP refusal '+i;await control({status:409,body});const r=await commands.send('/status');check(!r.accepted&&r.uncertain===true&&r.message.includes('неизвестен'),'malformed refusal claimed definite non-admission');check(commands.boot===(await facts()).boot,'malformed refusal invalidated known boot');
  }
  stage='server error cannot prove pre-admission refusal';await control({status:503,body:{accepted:false,error:'problem'}});let r=await commands.send('/status');check(!r.accepted&&r.uncertain,'503 accepted=false claimed definite refusal');
  stage='real boot refusal and valid optional/additive success';await control(null);const f=await facts(),inbox=f.inbox.length;commands.observeBoot('wrong-boot-for-receipt');r=await commands.send('/status');check(!r.accepted&&!r.uncertain&&(await facts()).inbox.length===inbox&&commands.boot===undefined,'real boot refusal not definite or boot not invalidated');commands.observeBoot(f.boot);for(const body of [undefined,{status:'ok',additional:{future:true}},{status:'ok',ok:true,deduped:false}]){await control(body?{body}:null);chat.send.emit('clicked');await until(()=>!chat.draft.commandPending,'valid command pending');check(chat.composer.text===''&&chat.draft.reply===undefined,'valid minimal/additive receipt rejected');chat.composer.text='/review';}
  stage='native skill repair uses selected payload and exact correlation receipt';await control(null);await chat.close();skills=new Skills(win,gateway,()=>{throw new Error('repair correlation became task navigation')});skills.show();await until(()=>skills.installed.some(x=>x.name==='command-receipt-fixture'),'real installed script fixture absent');let skill=skills.installed.find(x=>x.name==='command-receipt-fixture');skills.open(skill);await until(()=>skills.detail?.skill.name===skill.name,'native skill detail absent');
  const originalPresent=Adw.AlertDialog.prototype.present;let confirmation;
  Adw.AlertDialog.prototype.present=function(parent){confirmation=this;originalPresent.call(this,parent)};
  const repair=async(response)=>{
   await control(response);const count=(await posts()).length;confirmation=undefined;const b=all(skills.detail.body,w=>w instanceof Gtk.Button&&w.label==='Попросить исправить…')[0];check(b?.sensitive,'native repair button absent');b.emit('clicked');await until(()=>confirmation!==undefined,'repair confirmation absent');confirmation.emit('response','ok');confirmation.close();await until(async()=>(await posts()).length===count+1&&!skills.writing.size,'repair not settled');
   const last=(await posts()).at(-1);check(last.body.visible_task_id.startsWith('skill_repair_')&&last.body.task_constraint.skill_name===skill.name&&last.body.task_constraint.payload_root===skill.payload_root&&last.body.task_constraint.allow_enable===false&&last.body.task_constraint.allow_review===true,'repair lost selected payload constraint/correlation');return last;
  };
  try {
   for(const body of [{status:'ok',ok:'true'},{ok:true,deduped:true},{ok:true,deduped:true,task_id:'foreign-id'},{status:'ok',task_id:'foreign-id'},{status:'ok',accepted:false}]){await repair({body});check(skills.detail.feedback.label.includes('не подтверждён'),'malformed repair receipt accepted');}
   let last=await repair(null);check(last.reply.status==='ok'&&skills.detail.feedback.label.includes('принял запрос'),'normal repair receipt rejected');const beforeDedup=(await facts()).inbox.length;last=await repair({replay:true});check(last.replayed_reply.ok===true&&last.replayed_reply.deduped===true&&last.replayed_reply.task_id===last.body.visible_task_id&&skills.detail.feedback.label.includes('принял запрос')&&(await facts()).inbox.length===beforeDedup+1,'actual dedup receipt correlation rejected or duplicated admission');check(commandAccepted(last.replayed_reply,last.body.visible_task_id)&&!commandAccepted(last.replayed_reply,'different-submission')&&!commandAccepted(last.replayed_reply),'dedup identity not required');
  } finally {Adw.AlertDialog.prototype.present=originalPresent}
  skills.close();await until(()=>!skills.dialog,'skill dialog not closed');
  stage='setup background helper rejects contradictory admission before state confirmation';
  for(const body of [{status:'ok',ok:false},{status:'ok',accepted:false},{status:'ok',task_id:[]},{ok:true,deduped:true,task_id:'unsolicited'}]){
   await control({body});const prior=(await facts()).audit.filter(x=>x.path==='/api/state').length,messages=[];await startSetupConsciousness(gateway,(await facts()).boot,()=>true,m=>messages.push(m));check(messages.at(-1)==='Шлюз не подтвердил приём команды фоновой активности.'&&(await facts()).audit.filter(x=>x.path==='/api/state').length===prior,'malformed setup admission started confirmation or claimed success');
  }
  stage='setup server error cannot prove pre-admission refusal';await control({status:503,body:{accepted:false,error:'problem'}});const messages=[];await startSetupConsciousness(gateway,(await facts()).boot,()=>true,m=>messages.push(m));check(messages.at(-1).includes('Итог запуска фоновой активности неизвестен'),'503 setup refusal fabricated definite non-admission');
  stage='setup genuine accepted command starts bounded state read, cancellation keeps Gateway';await control(null);const cancel=new Gio.Cancellable(),prior=(await facts()).audit.filter(x=>x.path==='/api/state').length;let done=false;const starting=startSetupConsciousness(gateway,(await facts()).boot,()=>true,()=>{},cancel).then(()=>{done=true});await until(async()=>(await facts()).audit.filter(x=>x.path==='/api/state').length>prior,'genuine setup admission not confirmed through state read');cancel.cancel();await until(()=>done,'setup cancellation did not settle');await starting;const last=(await posts()).at(-1);check(last.body.cmd==='/bg start'&&last.body.if_boot===(await facts()).boot,'setup command/boot changed');check((await gateway.json('GET','/api/health')).ok!==false,'shared Gateway closed');
  print('OK: real command admission/boot refusal with controlled malformed positive/refusal receipts; native chat draft/quote retained, no automatic replay, minimal/optional/additive positives accepted; native repair exact payload/constraint/correlation, actual primary dedup with one inbox admission and no fabricated task navigation; setup helper rejects malformed admission before state read and accepts genuine command then cancels observation. Inert workers, no repair/supervisor/model execution.');
 })().catch(e=>{failed=true;logError(e);print('Stage: '+stage)}).finally(async()=>{await control(null).catch(()=>{});skills?.close();await chat?.close();commands.close();gateway.close();observer.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
