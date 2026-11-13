import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {ChatPage}=await import(ARGV[0]+'chat.js');
const {RoomReads}=await import(ARGV[0]+'room-reads.js');
const {OwnerQuestions}=await import(ARGV[0]+'owner-questions.js');
const check=(value,message)=>{if(!value)throw new Error(message)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,message){for(let i=0;i<650;i++){if(await fn())return;await wait(20)}throw new Error(message)}
function all(widget,predicate){let result=predicate(widget)?[widget]:[];for(let child=widget.get_first_child?.();child;child=child.get_next_sibling())result.push(...all(child,predicate));return result}
function response(dialog,caption){const button=all(dialog,w=>w instanceof Gtk.Button&&(w.label===caption||all(w,l=>l instanceof Gtk.Label&&l.label===caption).length))[0];check(button,'native confirmation missing: '+caption);button.emit('clicked')}
const digest=value=>GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256,value,-1);
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.SecretQuestionTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1150,default_height:950});
 const gateway=new Gateway(ARGV[1],'fixture-secret');let main,reads,questions,stage='protected canonical form';
 const facts=()=>gateway.json('GET','/fixture/facts');
 const control=body=>gateway.json('POST','/fixture/control',body);
 const task=q=>q==='late'?'secret-late':'secret-asker';
 const id=q=>`quiz:${task(q)}:${q}`;
 const entry=q=>questions.forms.entries.get(id(q));
 const stored=async q=>(await facts()).quizzes[task(q)][q];
 const values=['  φΩ~ fill-token / space  ','region·Ω+east','conflict-old·φ','conflict-attempt·Ω','conflict-new·λ','lost·☀~','before-one·φ','before-two·Ω','cancel-kept·φ','never-save-cancel·Ω','late·☀φ','interrupted·Ω'];
 const close=async q=>{const form=entry(q).dialog;form.close();await until(()=>!form.dialog.get_parent(),'secret question not closed')};
 (async()=>{
  questions=new OwnerQuestions(gateway,win,()=>reads.refresh());
  reads=new RoomReads(gateway,()=>{},(snapshot,at)=>questions.observe(snapshot,at));
  main=new ChatPage(win,gateway,{chatId:1,name:'Main'},()=>reads.refresh(),undefined,undefined,()=>reads.refresh(),undefined,undefined,undefined,undefined,reads,undefined,undefined,questions);
  win.set_content(main.widget);win.present();await until(()=>questions.complete&&questions.list().length===9,'secret question census not complete');
  const open=async(q,scope=()=>true)=>{const issue=await questions.open({task_id:task(q),quiz_id:q},{chatId:1},scope,()=>true);check(!issue,'secret room proof refused: '+issue);await until(()=>entry(q)?.dialog?.secret&&!entry(q).dialog.secret.busy,'secret status not loaded');return entry(q).dialog.secret};
  let form=await open('fill');let data=await facts();
  check(form.inputs.size===2&&[...form.inputs.values()].every(row=>row instanceof Adw.PasswordEntryRow&&row.text===''),'secret fields are not empty native password rows');
  check(form.consumers.label.includes(data.fields.fillToken)&&form.consumers.label.includes(data.fields.fillRegion),'native form omits which keys installed skills read');
  form.inputs.get('fillToken').text=values[0];check(!form.save.sensitive,'partial multi-field secret enabled');form.inputs.get('fillRegion').text=values[1];
  if(!GLib.getenv('FLATPAK_ID')&&GLib.find_program_in_path('import')){win.queue_draw();await new Promise(resolve=>{let frames=0;win.add_tick_callback(()=>{if(++frames<3)return GLib.SOURCE_CONTINUE;resolve();return GLib.SOURCE_REMOVE})});await wait(80);Gio.Subprocess.new(['import','-window','root',ARGV[2]+'/secret-form.png'],Gio.SubprocessFlags.NONE).wait_check(null)}
  const inputs=[...form.inputs.values()];form.save.emit('clicked');check(inputs.every(row=>row.text==='')&&form.inputs.size===0,'submitted values retained by native fields');
  await until(()=>!form.busy&&form.latest?.state==='answered','secret save not confirmed');data=await facts();
  check(data.digests[data.fields.fillToken]===digest(values[0])&&data.digests[data.fields.fillRegion]===digest(values[1]),'protected writer changed values');
  check(data.unrelated==='keep'&&data.quizzes['secret-asker'].fill.secret_outcome.event==='secret_filled','secret save changed unrelated Settings or outcome');
  check(data.quizzes['secret-asker'].fill.secret_outcome.consumers.every(c=>!(c.granted||[]).length),'save granted skill access');
  check(!data.leaks.length,'synthetic secret reached non-Settings data');await close('fill');

  stage='stale empty state refuses replacement until explicit new save';form=await open('conflict');
  await control({action:'set',field:'conflictToken',value:values[2]});form.inputs.get('conflictToken').text=values[3];form.save.emit('clicked');
  await until(()=>!form.busy&&form.inputs.size===1&&form.save.label==='Заменить существующие значения','conflicting key state not reconciled');
  data=await facts();check(data.digests[data.fields.conflictToken]===digest(values[2]),'stale empty form overwrote saved value');
  const refused=data.audit.find(a=>a.decision_id===id('conflict')&&a.action==='save');check(refused.reply?.saved===false&&refused.reply?.reason_code==='secret_key_state_changed','actual key-state conflict not returned');
  check(form.inputs.get('conflictToken').text==='','refused value retained after status read');form.inputs.get('conflictToken').text=values[4];form.save.emit('clicked');
  await until(()=>!form.busy&&form.latest?.state==='answered','explicit replacement not saved');data=await facts();
  check(data.digests[data.fields.conflictToken]===digest(values[4])&&form.status.label.includes('conflictToken'),'replacement or replaced-field disclosure missing');await close('conflict');

  stage='lost replies never replay submitted values';form=await open('lost');await control({action:'loss',id:id('lost')});form.inputs.get('lostToken').text=values[5];form.save.emit('clicked');
  await until(()=>!form.busy&&form.latest?.state==='answered','status did not recover accepted save');data=await facts();
  check(data.digests[data.fields.lostToken]===digest(values[5])&&data.audit.filter(a=>a.decision_id===id('lost')&&a.action==='save').length===1,'accepted secret was repeated or not saved');await close('lost');
  form=await open('before');await control({action:'loss',id:id('before'),before:true});form.inputs.get('beforeToken').text=values[6];form.save.emit('clicked');
  await until(()=>!form.busy&&form.inputs.size===1,'status did not recover unknown pre-write result');data=await facts();check(!data.digests[data.fields.beforeToken]&&form.inputs.get('beforeToken').text==='','pre-write failure saved or retained a value');
  form.inputs.get('beforeToken').text=values[7];form.save.emit('clicked');await until(()=>!form.busy&&form.latest?.state==='answered','fresh explicit save not accepted');
  data=await facts();const attempts=data.audit.filter(a=>a.decision_id===id('before')&&a.action==='save');check(attempts.length===2&&attempts[0].request_id!==attempts[1].request_id&&data.digests[data.fields.beforeToken]===digest(values[7]),'unknown attempt id reused');await close('before');

  stage='cancellation owns its confirmation and preserves existing keys';await control({action:'set',field:'cancelToken',value:values[8]});let current=true;form=await open('cancel',()=>current);
  form.cancel.emit('clicked');await until(()=>win.get_visible_dialog() instanceof Adw.AlertDialog,'secret cancel confirmation missing');const orphan=win.get_visible_dialog();
  current=false;questions.forms.withdraw();await until(()=>!orphan.get_parent()&&!entry('cancel').dialog,'closing secret form left cancel confirmation open');
  check((await stored('cancel')).state==='open','withdrawal cancelled a secret request');form=await open('cancel');form.inputs.get('cancelToken').text=values[9];
  form.cancel.emit('clicked');await until(()=>win.get_visible_dialog() instanceof Adw.AlertDialog,'second secret confirmation missing');response(win.get_visible_dialog(),'Не отменять');await until(()=>win.get_visible_dialog()===entry('cancel').dialog.dialog,'declined cancellation not closed');
  check((await stored('cancel')).state==='open','decline cancelled request');form.cancel.emit('clicked');await until(()=>win.get_visible_dialog() instanceof Adw.AlertDialog,'accepted secret confirmation missing');response(win.get_visible_dialog(),'Отменить запрос');
  await until(()=>!form.busy&&form.latest?.state==='closed','cancel was not confirmed');data=await facts();check(data.digests[data.fields.cancelToken]===digest(values[8])&&form.inputs.size===0,'cancellation changed existing secret or retained draft');check(form.status.label.includes('Кто закрыл · Владелец')&&form.status.label.includes(data.quizzes['secret-asker'].cancel.closed_at)&&form.status.label.includes(data.quizzes['secret-asker'].cancel.closed_request_id),'secret cancellation lost closure provenance');
  const cancelled=data.audit.find(a=>a.decision_id===id('cancel')&&a.action==='cancel');check(cancelled&&Object.keys(cancelled.value_digests).length===0&&!Object.hasOwn(cancelled,'observed'),'cancellation sent draft values or save-only metadata');await close('cancel');

  stage='late save and interrupted-save cancellation';form=await open('late');check(form.status.label.includes('не возобновляет'),'late secret form omits work continuation semantics');form.inputs.get('lateToken').text=values[10];form.save.emit('clicked');
  await until(()=>!form.busy&&form.latest?.state==='answered','late secret save failed');data=await facts();check(data.quizzes['secret-late'].late.secret_outcome.late===true&&data.inbox_size===0&&JSON.stringify(data.pending)===JSON.stringify(['secret-asker']),'late secret resumed work or became an owner turn');await close('late');
  await control({action:'claim',value:values[11]});form=await open('unknown');check(form.latest.save_unconfirmed===true&&form.status.label.includes('неизвестен'),'interrupted attempt hidden by key state');
  form.cancel.emit('clicked');await until(()=>win.get_visible_dialog() instanceof Adw.AlertDialog,'unknown-save cancellation missing');response(win.get_visible_dialog(),'Отменить запрос');
  await until(()=>!form.busy&&form.latest?.state==='closed','unknown-save cancellation failed');data=await facts();
  const uncertain=data.audit.findLast(a=>a.decision_id===id('unknown')&&a.action==='cancel');check(uncertain.reply.saved===null&&form.latest.secret_outcome.interrupted_save&&form.status.label.includes('неизвестен')&&data.digests[data.fields.unknownToken]===digest(values[11]),'cancel fabricated certainty about an interrupted save');await close('unknown');

  stage='unreadable Settings and newer WS terminal fact';form=await open('damaged');await control({action:'damage'});form.reload.emit('clicked');await until(()=>!form.busy&&form.latest?.keys_unknown===true,'torn Settings not disclosed');
  check(!form.save.visible&&form.inputs.size===0,'unreadable Settings exposed save as an empty document');await control({action:'repair'});form.reload.emit('clicked');await until(()=>!form.busy&&form.inputs.size===1,'repaired Settings not recovered');await close('damaged');
  form=await open('terminal');await control({action:'hold',id:id('terminal')});form.reload.emit('clicked');await until(async()=>(await facts()).held,'old status not held');
  await gateway.json('POST','/api/decisions/secret',{decision_id:id('terminal'),request_id:'other-client-cancel',action:'cancel'});
  await until(()=>form.latest?.state==='closed'&&form.busy,'newer secret closure did not arrive over WS during status read');await control({action:'release'});
  await until(()=>!form.busy,'old failed status not finished');check(form.latest?.state==='closed'&&form.status.label.includes('отменён')&&!form.cancel.visible,'failed old status erased newer terminal fact');check(form.status.label.includes('Кто закрыл · Владелец')&&form.status.label.includes('other-client-cancel'),'WS secret closure lost actor/request');await close('terminal');
  data=await facts();check(!data.leaks.length&&data.unrelated==='keep','synthetic values escaped Settings or unrelated setting changed');
  const publicText=JSON.stringify({audit:data.audit,quizzes:data.quizzes,mail:data.mail,frames:data.frames})+all(win,w=>w instanceof Gtk.Label).map(w=>w.label).join('\n');
  check(values.every(value=>!publicText.includes(value)),'secret value leaked into public metadata or labels');
  const scan=directory=>{const file=Gio.File.new_for_path(directory);if(!file.query_exists(null))return;const children=file.enumerate_children('standard::name,standard::type',Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,null);let info;while((info=children.next_file(null))){const child=file.get_child(info.get_name());if(info.get_file_type()===Gio.FileType.DIRECTORY)scan(child.get_path());else {const[,bytes]=child.load_contents(null);const text=new TextDecoder().decode(bytes);check(values.every(value=>!text.includes(value)),'client state persisted a secret')}}children.close(null)};
  scan(ARGV[2]+'/client-state');
  print('OK: native protected secret forms over real manifest/quiz/census/task proof/Settings/secret decisions/mail/WS; multi-field fill, reader keys, explicit replacement after observed-state conflict, lost reply readback without resending values, new id after unknown attempt, owned cancellation confirmation, late save without new work, interrupted-save uncertainty, unreadable Settings and newer WS terminal fact; no synthetic values outside Settings, no skill/model execution');
 })().catch(error=>{failed=true;logError(error);print('Stage: '+stage)}).finally(async()=>{await main?.close();reads?.close();gateway.close();win.get_visible_dialog()?.force_close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
