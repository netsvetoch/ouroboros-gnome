import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
function all(widget,predicate){let result=predicate(widget)?[widget]:[];for(let child=widget.get_first_child?.();child;child=child.get_next_sibling())result.push(...all(child,predicate));return result}
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,message){for(let i=0;i<700;i++){if(fn())return;await wait(20)}throw new Error(message)}
const texts=widget=>all(widget,w=>w instanceof Gtk.TextView||w instanceof Gtk.Label).map(w=>w instanceof Gtk.Label?w.get_text():w.buffer.get_text(w.buffer.get_start_iter(),w.buffer.get_end_iter(),false)).join('\n');
function screenshot(win,name){
 if(GLib.getenv('FLATPAK_ID')||!GLib.find_program_in_path('import'))return;
 GLib.mkdir_with_parents(GLib.getenv('XDG_STATE_HOME'),0o700);
 Gio.Subprocess.new(['import','-window','root',GLib.getenv('XDG_STATE_HOME')+'/'+name],Gio.SubprocessFlags.NONE).wait_check(null);
}
async function projectRoute(win){
 win.get_visible_dialog()?.force_close();await wait(300);
 const composer=all(win,w=>w instanceof Gtk.Entry&&w.get_name()==='chat-composer')[0];
 if(!composer)throw new Error('main composer missing');composer.text='Main: черновик всего приложения';
 let choice,index;
 await until(()=>{for(const candidate of all(win,w=>w instanceof Gtk.DropDown)){const model=candidate.model;if(!model?.get_string)continue;for(let i=0;i<model.get_n_items();i++){if(model.get_string(i).startsWith('Проект <&>')){choice=candidate;index=i;return true}}}return false},'project room not loaded into native selector');
 choice.selected=index;
 await until(()=>win.get_visible_dialog()?.title==='Проект <&>','project selector did not open native panel');
 const dialog=win.get_visible_dialog();
 await until(()=>texts(dialog).includes('Общее сообщение 71 <&>'),'native project panel did not load canonical history');
 const project=all(dialog,w=>w instanceof Gtk.Entry&&w.get_name()==='chat-composer')[0];
 if(!project||project===composer)throw new Error('project reused Main composer');
 project.text='Проект: черновик всего приложения';
 if(composer.text!=='Main: черновик всего приложения')throw new Error('project changed Main draft');
 await wait(300);screenshot(win,'application-project.png');dialog.force_close();
 await until(()=>!win.get_visible_dialog(),'project panel did not close');
 if(composer.text!=='Main: черновик всего приложения')throw new Error('closing project lost Main draft');
 print('OK: actual main-gjs project selection opens independent native chat/history and returns to preserved Main draft');
}
let checks=0,failed=true;
GLib.timeout_add(GLib.PRIORITY_DEFAULT,100,()=>{
 const windows=Gtk.Window.get_toplevels();let win;
 for(let i=0;i<windows.get_n_items();i++){const candidate=windows.get_item(i);if(candidate instanceof Adw.ApplicationWindow){win=candidate;break}}
 if(!win)return ++checks<150?GLib.SOURCE_CONTINUE:GLib.SOURCE_REMOVE;
 const sidebar=all(win,w=>w instanceof Adw.ViewSwitcherSidebar)[0];
 const ready=sidebar?.get_stack().get_pages().get_n_items()===6&&texts(win).includes('Общее сообщение 71 <&>');
 if(!ready&&++checks<150)return GLib.SOURCE_CONTINUE;
 const app=win.get_application();
 (async()=>{
  if(!ready)throw new Error('actual application did not render real history; sidebar='+Boolean(sidebar)+' text='+texts(win).slice(-4000));
  print('OK: actual main-gjs application mounted native navigation and asynchronously rendered real chat history');
  await projectRoute(win);failed=false;await wait(300);screenshot(win,'application.png');
 })().catch(error=>logError(error)).finally(()=>{
  win.get_visible_dialog()?.force_close();win.close();GLib.timeout_add(GLib.PRIORITY_DEFAULT,500,()=>{app.quit();return GLib.SOURCE_REMOVE});
 });
 return GLib.SOURCE_REMOVE;
});
await import(ARGV[0]+'../main-gjs.js');
exit(failed?1:0);
