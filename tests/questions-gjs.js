import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {ChatPage}=await import(ARGV[0]+'chat.js');
const {ChatIngress}=await import(ARGV[0]+'chat-ingress.js');
const {ProjectPanel}=await import(ARGV[0]+'project-panel.js');
const {RoomReads}=await import(ARGV[0]+'room-reads.js');
const {OwnerQuestions}=await import(ARGV[0]+'owner-questions.js');
const check=(value,message)=>{if(!value)throw new Error(message)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,message){for(let i=0;i<600;i++){if(await fn())return;await wait(20)}throw new Error(message)}
function all(widget,predicate){let result=predicate(widget)?[widget]:[];for(let child=widget.get_first_child?.();child;child=child.get_next_sibling())result.push(...all(child,predicate));return result}
function response(dialog,caption){const button=all(dialog,w=>w instanceof Gtk.Button&&(w.label===caption||all(w,l=>l instanceof Gtk.Label&&l.label===caption).length))[0];check(button,'native confirmation button missing: '+caption);button.emit('clicked')}
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.QuestionTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1150,default_height:950});
 const gateway=new Gateway(ARGV[1],'fixture-secret');let main,panel,reads,questions,stage='real question census and detail';
 const facts=()=>gateway.json('GET','/fixture/facts');
 const stored=async(task,id)=>(await facts()).quizzes[task]?.[id];
 const entry=(task,id)=>questions.forms.entries.get(`quiz:${task}:${id}`);
 const comment=(form,text)=>{if(form.comment instanceof Gtk.TextView)form.comment.buffer.set_text(text,-1);else form.comment.text=text};
 const closeForm=async form=>{form.close();await until(()=>!form.dialog.get_parent(),'question dialog not closed')};
 (async()=>{
  questions=new OwnerQuestions(gateway,win,()=>reads.refresh());
  reads=new RoomReads(gateway,()=>{},(snapshot,at)=>questions.observe(snapshot,at));
  const ingress=new ChatIngress(gateway.base);
  const host=room=>room.projectId?panel.open(room):(panel.active&&panel.hide(),main.setRoom(room),main);
  main=new ChatPage(win,gateway,{chatId:1,name:'Main'},()=>reads.refresh(),undefined,undefined,undefined,undefined,undefined,undefined,undefined,reads,undefined,undefined,questions,undefined,undefined,{ingress,hostRoom:host});
  panel=new ProjectPanel(win,gateway,room=>new ChatPage(win,gateway,room,()=>{},undefined,undefined,undefined,undefined,undefined,undefined,undefined,reads,undefined,undefined,questions,undefined,undefined,{ingress,hostRoom:host,ownsSharedControllers:false,managesConnection:false}),()=>{});
  win.set_content(main.widget);win.present();
  await until(()=>questions.complete&&questions.list().length===10,'real question census not available: '+JSON.stringify({loaded:questions.loaded,complete:questions.complete,list:questions.list()}));
  const open=async(task,id,room={chatId:1},scope=()=>true)=>{
   const issue=await questions.open({task_id:task,quiz_id:id},room,scope,()=>true);check(!issue,'canonical question not opened: '+issue);
   await until(()=>entry(task,id)?.dialog?.dialog.get_mapped(),'native question dialog not mapped');return entry(task,id).dialog;
  };
  let form=await open('main-asker','verbatim');
  const words='  Вариант 🧭 <&>\nвторая строка  ';
  const second=all(form.choices,w=>w instanceof Gtk.CheckButton&&w.label.startsWith('Второй'))[0];check(second,'recommended option not shown');second.active=true;
  comment(form,words);check(form.answer.sensitive,'non-empty option/comment disabled');
  if(!GLib.getenv('FLATPAK_ID')&&GLib.find_program_in_path('import')){win.queue_draw();await new Promise(resolve=>{let frames=0;win.add_tick_callback(()=>{if(++frames<3)return GLib.SOURCE_CONTINUE;resolve();return GLib.SOURCE_REMOVE})});await wait(80);Gio.Subprocess.new(['import','-window','root',ARGV[2]+'/question-answer.png'],Gio.SubprocessFlags.NONE).wait_check(null)}
  form.answer.emit('clicked');
  await until(async()=>!entry('main-asker','verbatim').sending&&(await stored('main-asker','verbatim')).state==='answered','native answer not recorded');
  check((await stored('main-asker','verbatim')).comment===words,'native answer changed verbatim whitespace/newlines');
  check((await stored('main-asker','verbatim')).answered_index===1,'native option target changed');await closeForm(form);

  stage='code point limit without truncation and comment-only answer';form=await open('main-asker','limits');
  comment(form,' \n ');check(!form.answer.sensitive,'blank custom answer enabled');
  const countBefore=(await facts()).audit.length;comment(form,'🧭'.repeat(2001));
  check(!form.answer.sensitive&&form.comment.buffer.get_char_count()===2001,'over-limit text silently truncated or enabled');
  check((await facts()).audit.length===countBefore,'over-limit comment sent a decision');
  comment(form,'🧭'.repeat(2000));check(form.answer.sensitive,'2000 Unicode code points refused');form.answer.emit('clicked');
  await until(async()=>!entry('main-asker','limits').sending&&(await stored('main-asker','limits')).state==='answered','comment-only answer not saved');
  let data=await facts();check(data.quizzes['main-asker'].limits.comment==='🧭'.repeat(2000),'Unicode comment changed');
  check(!Object.hasOwn(data.audit.find(a=>a.body.decision_id==='quiz:main-asker:limits').body,'option_index'),'custom answer selected an offered option');await closeForm(form);

  stage='identical native retry before and after durable acceptance';form=await open('main-asker','retry');
  const retryText='  Повторяемый ответ\n🧭  ';comment(form,retryText);
  await gateway.json('POST','/fixture/lose',{id:'quiz:main-asker:retry',before:true});form.answer.emit('clicked');
  await until(()=>!entry('main-asker','retry').sending&&Boolean(entry('main-asker','retry').pending),'unavailable pre-writer response did not retain answer');
  check((await stored('main-asker','retry')).state==='open','pre-writer fixture committed answer');await closeForm(form);
  form=await open('main-asker','retry');check(form.retry.visible&&!form.form.visible,'reopening lost pending action');
  await gateway.json('POST','/fixture/lose',{id:'quiz:main-asker:retry'});form.retry.emit('clicked');
  await until(async()=>!entry('main-asker','retry').sending&&(await stored('main-asker','retry')).state==='answered','lost accepted answer not retained');
  await until(()=>entry('main-asker','retry').quiz.state==='answered'&&entry('main-asker','retry').quiz.question_delivery?.kind==='answer','live answer delivery did not replace the publication receipt');
  check(entry('main-asker','retry').pending,'owed answer was presented as delivered');await closeForm(form);
  form=await open('main-asker','retry');form.retry.emit('clicked');
  await until(async()=>!entry('main-asker','retry').sending&&(await facts()).audit.filter(a=>a.body.decision_id==='quiz:main-asker:retry').length===3,'same answer retry missing');
  data=await facts();const tries=data.audit.filter(a=>a.body.decision_id==='quiz:main-asker:retry');
  check(tries.every(a=>JSON.stringify(a.body)===JSON.stringify(tries[0].body))&&tries[2].reply.duplicate===true,'retry changed request id/body or lost canonical duplicate');
  check(data.mail['main-asker'].filter(m=>m.msg_id==='quiz_answer:main-asker:retry').length===1,'duplicate recipient mail');
  await gateway.json('POST','/fixture/read',{task:'main-asker',quiz:'retry'});
  await until(()=>!entry('main-asker','retry').pending&&form.state.label.includes('Доставка подтверждена'),'actual WS read settlement did not update native form');await closeForm(form);

  stage='newer read receipt wins over delayed HTTP answer';form=await open('main-asker','settle-race');comment(form,'Уже прочитанный ответ');form.answer.emit('clicked');
  await until(()=>!entry('main-asker','settle-race').sending&&entry('main-asker','settle-race').quiz.state==='answered','delayed HTTP answer did not complete');
  check(entry('main-asker','settle-race').quiz.question_delivery?.state==='delivered'&&!entry('main-asker','settle-race').pending&&!form.retry.visible,'older HTTP response regressed newer WS read receipt');await closeForm(form);

  stage='verbatim closure and scope withdrawal';form=await open('main-asker','close');form.closeQuestion.emit('clicked');
  await until(()=>form.closing?.get_mapped(),'close-with-reason dialog missing');
  const reason=all(form.closing,w=>w instanceof Gtk.TextView)[0];check(reason,'closure reason must support multiline text');
  const closeButton=all(form.closing,w=>w instanceof Gtk.Button&&w.label==='Закрыть вопрос')[0];
  reason.buffer.set_text('🧭'.repeat(2001),-1);check(!closeButton.sensitive&&reason.buffer.get_char_count()===2001,'over-limit closure reason truncated or enabled');
  const reasonText='  Причина 🧭 <&>\nбез одобрения  ';reason.buffer.set_text(reasonText,-1);
  closeButton.emit('clicked');
  await until(async()=>!entry('main-asker','close').sending&&(await stored('main-asker','close')).state==='closed','native closure not recorded');
  check((await stored('main-asker','close')).closed_reason===reasonText,'native closure changed owner reason');await closeForm(form);
  let current=true;form=await open('main-asker','scope',{chatId:1},()=>current);form.closeQuestion.emit('clicked');
  await until(()=>form.closing?.get_mapped(),'scope closure dialog missing');const child=form.closing;const before=(await facts()).audit.length;
  current=false;questions.forms.withdraw();await until(()=>!child.get_parent()&&!form.dialog.get_parent(),'withdrawal left nested closure dialog open');
  check((await facts()).audit.length===before&&(await stored('main-asker','scope')).state==='open','scope withdrawal changed canonical question');
  form=await open('main-asker','scope');form.closeQuestion.emit('clicked');await until(()=>form.closing?.get_mapped(),'optional closure reason dialog missing');
  all(form.closing,w=>w instanceof Gtk.Button&&w.label==='Закрыть вопрос')[0].emit('clicked');
  await until(async()=>!entry('main-asker','scope').sending&&(await stored('main-asker','scope')).state==='closed','one-tap closure without reason not saved');
  check((await stored('main-asker','scope')).closed_reason==='Closed by the owner without an answer.','optional reason did not retain gateway default');await closeForm(form);

  stage='late answer and unknown-delivery dismissal';form=await open('late-asker','late');
  check(form.state.label.includes('Задача закончилась'),'terminal question not offered as late answer');
  const lateText='  Поздний ответ\nпо существу 🧭  ';comment(form,lateText);form.answer.emit('clicked');
  await until(async()=>!entry('late-asker','late').sending&&(await stored('late-asker','late')).state==='answered','late answer not accepted');
  data=await facts();check(data.quizzes['late-asker'].late.answered_after_terminal===true,'late answer provenance missing');
  const lateRows=data.inbox.filter(row=>row.client_message_id==='quiz_late_answer:late-asker:late');
  check(data.quizzes['late-asker'].late.comment===lateText,'late quiz comment changed');
  check(lateRows.length===1&&data.accepted_late?.ingress_accepted===true&&lateRows[0].text===data.accepted_late.text,'late dispatch differs from the canonical named-ingress row');await closeForm(form);
  let deliveryScope=true;form=await open('late-asker','unknown',{chatId:1},()=>deliveryScope);check(form.dismiss.visible,'unknown delivery has no dismiss control');
  form.dismiss.emit('clicked');await until(()=>win.get_visible_dialog() instanceof Adw.AlertDialog,'scoped dismiss confirmation missing');
  const orphan=win.get_visible_dialog();deliveryScope=false;questions.forms.withdraw();
  await until(()=>!orphan.get_parent()&&!form.dialog.get_parent(),'scope withdrawal left dismiss confirmation open');
  check(!(await stored('late-asker','unknown')).delivery.dismissed_at,'withdrawal dismissed unknown delivery');
  form=await open('late-asker','unknown');
  form.dismiss.emit('clicked');await until(()=>win.get_visible_dialog() instanceof Adw.AlertDialog,'dismiss confirmation missing');response(win.get_visible_dialog(),'Отмена');await until(()=>win.get_visible_dialog()===form.dialog,'cancelled dismiss confirmation not closed');
  check(!(await stored('late-asker','unknown')).delivery.dismissed_at,'cancel hid unknown delivery');
  form.dismiss.emit('clicked');await until(()=>win.get_visible_dialog() instanceof Adw.AlertDialog,'second dismiss confirmation missing');response(win.get_visible_dialog(),'Скрыть');
  await until(async()=>Boolean((await stored('late-asker','unknown')).delivery.dismissed_at),'dismiss was not recorded');
  check((await stored('late-asker','unknown')).delivery.state==='owed','dismiss fabricated delivery success');await closeForm(form);

  stage='project pointer and shared questions in native project chat';data=await facts();
  await main.openProject(data.project.id,data.project.chat_id);await until(()=>panel.chat?.ownerQuestionsPanel,'project question panel not mounted');
  reads.refresh();await until(()=>questions.list({chatId:data.project.chat_id,projectId:data.project.id}).some(q=>q.quiz_id==='project'),'project pointer census not scoped');
  panel.chat.ownerQuestionsPanel.widget.expanded=true;
  const openProject=all(panel.chat.ownerQuestionsPanel.widget,w=>w instanceof Gtk.Button&&w.label==='Открыть вопрос…')[0];check(openProject?.sensitive,'project question button not enabled');openProject.emit('clicked');
  await until(()=>entry('project-asker','project')?.dialog?.dialog.get_mapped(),'project pointer did not hydrate canonical form');
  form=entry('project-asker','project').dialog;comment(form,'  Ответ проекта\n<&>  ');form.answer.emit('clicked');
  await until(async()=>!entry('project-asker','project').sending&&(await stored('project-asker','project')).state==='answered','project question answer not saved');
  check((await stored('project-asker','project')).comment==='  Ответ проекта\n<&>  ','project answer changed');await closeForm(form);
  panel.hide();await until(()=>!win.get_visible_dialog(),'project panel not dismissed');
  stage='another client wins via real WS lifecycle update';form=await open('main-asker','race');comment(form,'Мой черновик');form.closeQuestion.emit('clicked');
  await until(()=>form.closing?.get_mapped(),'racing closure dialog missing');const losingClosure=form.closing;
  await gateway.json('POST','/api/decisions',{decision_id:'quiz:main-asker:race',request_id:'other-owner-client',option_index:1,comment:'Ответ другого клиента'});
  await until(()=>entry('main-asker','race').quiz.state==='answered'&&!form.form.visible&&!losingClosure.get_parent(),'WS answer from another client left editable native form or closure');
  check((await stored('main-asker','race')).request_id==='other-owner-client','native draft replaced winning answer');await closeForm(form);
  print('OK: real quiz publication/census/task proof/decisions/mail and WS in native Main/project forms; verbatim multiline option/custom/closure answers, 2000 Unicode code points without truncation, stable retries before/after acceptance, one mailbox delivery and read settlement, newer WS receipt before delayed HTTP response, withdrawn nested dialogs, late named ingress, cancelled/confirmed unknown-delivery dismissal and another-client winner; models never execute');
 })().catch(error=>{failed=true;logError(error);print('Stage: '+stage)}).finally(async()=>{await panel?.close();await main?.close();reads?.close();gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
