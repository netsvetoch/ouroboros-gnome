import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {TaskLaunch}=await import(ARGV[0]+'task-launch.js');
const {NativeI18n,useNativeI18n}=await import(ARGV[0]+'native-i18n.js');
const check=(x,m)=>{if(!x)throw new Error(m)};
const wait=ms=>new Promise(r=>GLib.timeout_add(0,ms,()=>{r();return GLib.SOURCE_REMOVE}));
async function until(fn,m){for(let i=0;i<600;i++){if(await fn())return;await wait(20)}throw new Error(m)}
function all(w,p,seen=new Set()){if(!w||seen.has(w))return [];seen.add(w);let a=p(w)?[w]:[];for(let c=w.get_first_child?.();c;c=c.get_next_sibling())a.push(...all(c,p,seen));if(w instanceof Gtk.Expander)a.push(...all(w.get_child(),p,seen));return a}
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.LaunchI18nTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1100,default_height:950});win.present();
 const gateway=new Gateway(ARGV[1],'fixture-secret'),catalog=new NativeI18n(gateway);useNativeI18n(catalog);const launch=new TaskLaunch(win,gateway,()=>{},()=>{});let socket,stage='initial fields';
 const facts=()=>gateway.json('GET','/fixture/facts');
 const language=language=>gateway.json('POST','/api/ui/i18n/language',{language});
 (async()=>{
  socket=await gateway.connect('/ws',new Gio.Cancellable());socket.connect('message',(_s,t,b)=>{if(t===1)catalog.frame(JSON.parse(new TextDecoder().decode(b.get_data())))});await until(()=>catalog.language!==undefined,'language missing');
  launch.show({chatId:1,name:'Private room draft 481'});const form=launch.openDialog,editor=form.editor,fields=editor.fields,options=editor.options,fixture=await facts();
  const entry=key=>all(editor.widget,w=>w.get_name?.()==='task-launch-'+key)[0];
  check(entry('title').title==='Title','English title missing');const titleRow=entry('title'),descriptionView=entry('description');
  const literals={title:'Private launch title 482',description:'Private task description 483',context:'  Private context <&>\nLine Ω\n',expected_output:'  Private expected 484\n',constraints:'Private constraints 485',workspace_root:fixture.workspace,memory_mode:'empty'};
  for(const [key,value] of Object.entries(literals))if(fields.has(key))fields.get(key).set(value);
  fields.get('task_id').set('gtk-localized');fields.get('execution_timeout_sec').set('7,5');fields.get('metadata').set('{"private_owner_key":"private-metadata-value-486"}');
  options.get('memory_mode').widget.selected=options.get('memory_mode').values.indexOf('empty');options.get('reasoning_effort').widget.selected=options.get('reasoning_effort').values.indexOf('high');options.get('executor.type').widget.selected=options.get('executor.type').values.indexOf('local');fields.get('executor.id').set('private-executor-487');fields.get('executor.workspace_host_path').set(fixture.workspace);fields.get('executor.workspace_backend_path').set(fixture.workspace);
  editor.atomic.active=true;editor.ownBody.active=true;const models=[...options.values()].map(({widget})=>widget.get_model()),before=editor.request('unused','a'.repeat(32),[]);
  const pairs={'Title':'QAA Title','Task description':'QAA Description','Workspace, memory and limits':'QAA Runtime','Executor type':'QAA Executor','Local':'QAA Local','Docker':'QAA Docker','Memory':'QAA Memory','Empty':'QAA Empty','Starting effort':'QAA Effort','High':'QAA High','Require all attachments':'QAA All attachments','Request agent self-description documents':'QAA Self docs','Private launch title 482':'DO NOT TRANSLATE TITLE','private-executor-487':'DO NOT TRANSLATE EXECUTOR'};
  const pack=()=>({language:'qaa',entries:Object.fromEntries(Object.entries(pairs).map(([k,text])=>[k,{text}]))});
  await gateway.json('POST','/api/ui/i18n/import',pack());await language('qaa');await until(()=>titleRow.title==='QAA Title'&&options.get('executor.type').widget.get_model().get_string(1)==='QAA Local','fields/choices not translated');
  check(entry('title')===titleRow&&entry('description')===descriptionView&&editor.executor.visible,'locale replaced editor or hid active executor');check([...options.values()].every(({widget},i)=>widget.get_model()===models[i]),'locale replaced combo models');
  check(JSON.stringify(editor.request('unused','a'.repeat(32),[]))===JSON.stringify(before),'locale changed technical request or private text');
  check(editor.atomic.title==='QAA All attachments'&&editor.ownBody.title==='QAA Self docs','switch titles untranslated');
  pairs.Local='QAA Revised local';pairs.Title='QAA Revised title';await gateway.json('POST','/api/ui/i18n/import',pack());await until(()=>titleRow.title==='QAA Revised title'&&options.get('executor.type').widget.get_model().get_string(1)==='QAA Revised local','revision did not repaint');check(JSON.stringify(editor.request('unused','a'.repeat(32),[]))===JSON.stringify(before),'revision changed draft');
  stage='actual task admission retains machine values after locale';form.submit.emit('clicked');await until(()=>!form.busy,'task submit pending');check(form.confirmed==='gtk-localized','localized task was refused: '+form.status.label);
  const data=await facts(),body=data.requests[0];check(data.requests.length===1&&body.executor_ref.type==='local'&&body.executor_ref.id==='private-executor-487'&&body.memory_mode==='empty'&&body.reasoning_effort==='high','localized caption used as API value');
  for(const key of ['title','description','context','expected_output','constraints'])check(body[key]===literals[key],'private text changed in API: '+key);check(body.execution_timeout_sec===7.5&&body.metadata.private_owner_key==='private-metadata-value-486'&&body.allow_partial_attachments===false&&body.context_requires_self_body_docs===true,'typed options changed');
  stage='missing source isolation and closed editor lifecycle';await until(async()=>(await facts()).i18n_audit.length,'missing source report absent');const wire=JSON.stringify((await facts()).i18n_audit);check(!['Private launch','Private task','Private context','private-executor','private_owner_key','private-metadata-value'].some(x=>wire.includes(x)),'owner data reported as translation source');
  form.dialog.force_close();check(editor.disposed&&editor.stops.length===0,'closed editor retained locale watchers');await language('en');await until(()=>catalog.language==='en','English not restored');let rejected=false;try{editor.request('unused','b'.repeat(32),[])}catch{rejected=true}check(rejected,'closed editor still created request');
  print('OK: native task launch field/section/switch/combo i18n through actual language/revision WS preserves widgets/models/private drafts and exact request; real task admission uses local/empty/high IDs and verbatim text, missing sources exclude owner data, closed editor releases watchers');
 })().catch(e=>{failed=true;logError(e);print('Stage: '+stage)}).finally(()=>{launch.close();catalog.close();socket?.close(1000,null);gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
