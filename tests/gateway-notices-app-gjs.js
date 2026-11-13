import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const observer=new Gateway(GLib.getenv('OUROBOROS_URL'),'fixture-secret');
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,message){for(let i=0;i<1000;i++){if(await fn())return;await wait(20)}throw new Error(message)}
function all(w,p){let out=p(w)?[w]:[];for(let c=w.get_first_child?.();c;c=c.get_next_sibling())out.push(...all(c,p));return out}
const texts=w=>all(w,w=>w instanceof Gtk.Label||w instanceof Gtk.TextView).map(w=>w instanceof Gtk.Label?w.label:w.buffer.text).join('\n');
const shown=[],original=Adw.ToastOverlay.prototype.add_toast;
Adw.ToastOverlay.prototype.add_toast=function(toast){toast.timeout=0;shown.push(toast);original.call(this,toast)};
let checks=0,failed=true;
GLib.timeout_add(GLib.PRIORITY_DEFAULT,100,()=>{
 const windows=Gtk.Window.get_toplevels();let win;
 for(let i=0;i<windows.get_n_items();i++){const candidate=windows.get_item(i);if(candidate instanceof Adw.ApplicationWindow){win=candidate;break}}
 if(!win||!all(win,w=>w instanceof Gtk.Entry&&w.get_name()==='chat-composer').length)return ++checks<200?GLib.SOURCE_CONTINUE:GLib.SOURCE_REMOVE;
 const app=win.get_application();
 (async()=>{
  await until(async()=>(await observer.json('GET','/fixture/facts')).notice_peers>0,'actual Main WebSocket unavailable');
  win.get_visible_dialog()?.force_close();await wait(300);
  if(!(win.get_content() instanceof Adw.ToastOverlay))throw new Error('actual root is missing native ToastOverlay');
  const body='Actual main incident <&> Ω\nFull details from the real gateway bridge';
  const emit=()=>observer.json('POST','/fixture/notice',{incident:'fixture-app',once:'app-entry-toast',text:body,tone:'info'});
  await emit();await until(()=>{
   // Startup setup may finish its asynchronous GET after the window appears.
   win.get_visible_dialog()?.force_close();
   return shown.some(t=>texts(t.custom_title).includes(body));
  },'actual primary chat did not deliver native incident; captured='+shown.length);
  const toast=shown.find(t=>texts(t.custom_title).includes(body));toast.emit('button-clicked');
  await until(()=>win.get_visible_dialog()&&all(win.get_visible_dialog(),w=>w instanceof Gtk.TextView&&w.buffer.text===body).length,'actual app details did not preserve full source');
  const detail=win.get_visible_dialog(),open=all(detail,w=>w instanceof Gtk.Button&&['Open task','Открыть задачу'].includes(w.label))[0];
  if(!open?.sensitive)throw new Error('actual app missing native task navigation');open.emit('clicked');
  await until(()=>win.get_visible_dialog()!==detail&&texts(win.get_visible_dialog()??win).includes('main-asker'),'notice did not open actual native TaskDetail');
  await emit();await wait(200);if(shown.length!==1)throw new Error('actual application duplicated one-shot notice');
  print('OK: actual main-gjs root ToastOverlay receives real primary WS incident, opens full native details and real TaskDetail for exact task, suppresses duplicate');
  win.get_visible_dialog()?.force_close();await wait(100);
  const reminderText='Actual main scheduled reminder <&> Ω';await observer.json('POST','/fixture/reminder',{action:'seed',text:reminderText});
  await until(()=>shown.some(t=>texts(t.custom_title).includes(reminderText)),'actual primary chat did not notify scheduled reminder');
  const reminder=shown.find(t=>texts(t.custom_title).includes(reminderText));reminder.emit('button-clicked');
  await until(()=>win.get_visible_dialog()&&all(win.get_visible_dialog(),w=>w instanceof Gtk.TextView&&w.buffer.text.endsWith(reminderText)).length,'actual reminder details absent');
  const signed=(await observer.json('GET','/fixture/facts')).frames.find(frame=>frame.system_type==='reminder').content;
  if(!all(win.get_visible_dialog(),w=>w instanceof Gtk.TextView&&w.buffer.text===signed).length||all(win.get_visible_dialog(),w=>w instanceof Gtk.Button&&['Open task','Открыть задачу'].includes(w.label)).length)throw new Error('actual reminder changed full signature or offered task action');
  print('OK: actual main-gjs primary socket presents consumed schedule reminder as native Toast/full signed details without task action');failed=false;
 })().catch(error=>logError(error)).finally(()=>{
  Adw.ToastOverlay.prototype.add_toast=original;observer.close();win.get_visible_dialog()?.force_close();win.close();GLib.timeout_add(0,500,()=>{app.quit();return GLib.SOURCE_REMOVE});
 });return GLib.SOURCE_REMOVE;
});
await import(ARGV[0]+'../main-gjs.js');
exit(failed?1:0);
