import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {ChatPage}=await import(ARGV[0]+'chat.js');
const {NestedTasks}=await import(ARGV[0]+'nested-tasks.js');
const check=(value,message)=>{if(!value)throw new Error(message)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,message){for(let i=0;i<1000;i++){if(await fn())return;await wait(20)}throw new Error(message)}
function all(widget,predicate){let result=predicate(widget)?[widget]:[];for(let child=widget.get_first_child?.();child;child=child.get_next_sibling())result.push(...all(child,predicate));return result}
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.NestedTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1000,default_height:850});win.present();const gateway=new Gateway(ARGV[1],'fixture-secret');let chat,opened,stage='native grouped history';
 const pref=value=>gateway.json('POST','/api/ui/preferences',{nested_subagents_expanded:value});
 (async()=>{
  await pref(true);chat=new ChatPage(win,gateway,{chatId:1,name:'Main'},()=>{},id=>{opened=id});win.set_content(chat.widget);
  const panel=id=>all(chat.list,w=>w instanceof Gtk.Expander&&w.label==='Субагент · '+id)[0];
  await until(()=>panel('child')?.expanded&&panel('grandchild')?.expanded,'saved expanded preference did not reach native groups: '+chat.historyError);
  check(all(chat.list,w=>w instanceof Gtk.Expander&&w.label.startsWith('Субагент ·')).length===2,'one task split into repeated disclosure groups');
  const child=panel('child'),grand=panel('grandchild');check(all(child.get_child(),w=>w===grand).length===1,'grandchild not nested under its recorded parent');
  const texts=all(child.get_child(),w=>w instanceof Gtk.TextView||w instanceof Gtk.Label).map(w=>w instanceof Gtk.Label?w.get_text():w.buffer.get_text(w.buffer.get_start_iter(),w.buffer.get_end_iter(),false)).join('\n');
  check(texts.includes('Ответ помощника один')&&texts.includes('Ответ помощника два')&&texts.includes('Ответ вложенного помощника'),'grouping dropped child text');
  await until(()=>!chat.reading,'initial history not settled');check(chat.current.length>0&&!chat.status.label.includes('История пуста'),'loaded nested history still reported empty: '+JSON.stringify({rows:chat.current.length,status:chat.status.label}));
  if(!GLib.getenv('FLATPAK_ID')&&GLib.find_program_in_path('import')){win.queue_draw();await new Promise(resolve=>{let frames=0;win.add_tick_callback(()=>{if(++frames<3)return GLib.SOURCE_CONTINUE;resolve();return GLib.SOURCE_REMOVE})});await wait(80);Gio.Subprocess.new(['import','-window','root',ARGV[2]+'/nested-history.png'],Gio.SubprocessFlags.NONE).wait_check(null)}
  all(grand.get_child(),w=>w instanceof Gtk.Button&&w.label==='Открыть подзадачу')[0].emit('clicked');check(opened==='grandchild','nested task navigation changed target');
  stage='manual choice survives refresh';child.expanded=false;await chat.readHistory();check(panel('child')&&!panel('child').expanded,'history refresh reset explicit collapsed choice');
  stage='native saved default preserves manual choice';await until(()=>chat.nestedReady,'native preference control not ready');const menu=all(chat.widget,w=>w instanceof Gtk.MenuButton&&w.label==='Подзадачи')[0];check(menu,'native task menu missing');menu.popup();await until(()=>chat.nestedPreference.get_mapped(),'native preference checkbox not exposed');chat.nestedPreference.active=false;await until(()=>!chat.nestedSaving&&chat.nestedReady&&!chat.nestedExpanded,'native saved preference not applied');check((await gateway.json('GET','/api/ui/preferences')).nested_subagents_expanded===false,'native toggle did not persist global preference');check(!panel('child').expanded,'new default reset explicit choice');menu.popdown();
  chat.close();chat=new ChatPage(win,gateway,{chatId:1,name:'Main'},()=>{},id=>{opened=id});win.set_content(chat.widget);await until(()=>panel('child'),'new client did not load task groups');check(!panel('child').expanded,'new client ignored saved collapsed default');
  panel('child').expanded=true;await chat.readHistory();check(panel('child').expanded,'explicit expanded choice did not survive refresh');
  stage='anchor reveals collapsed ancestors';panel('child').expanded=false;await chat.jumpToHistory('task:grandchild',true,undefined,1);check(chat.anchored&&panel('child')?.expanded&&panel('grandchild')?.expanded,'exact history navigation did not reveal nested target');
  stage='inconsistent lineage remains visible';const box=new Gtk.Box({orientation:Gtk.Orientation.VERTICAL});const grouped=new NestedTasks(box,[{task_id:'a',parent_task_id:'b'},{task_id:'b',parent_task_id:'a'}],false,new Map());grouped.append('a',new Gtk.Label({label:'Cycle A'}));grouped.append('b',new Gtk.Label({label:'Cycle B'}));check(all(box,w=>w instanceof Gtk.Label).length===2&&!all(box,w=>w instanceof Gtk.Expander).length,'cyclic lineage hid rows or recursed');
  print('OK: real history/task lineage/preferences in native ChatPage; one nested group per child, ancestry and complete text, exact task navigation, saved expansion default, sticky manual choices across refresh, recreation, anchor revelation and cyclic-lineage fallback; no model execution');
 })().catch(error=>{failed=true;logError(error);print('Stage: '+stage)}).finally(async()=>{await chat?.close();gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
