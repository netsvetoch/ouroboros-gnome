import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {ChatPage}=await import(ARGV[0]+'chat.js');
const check=(value,message)=>{if(!value)throw new Error(message)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,message){for(let i=0;i<1000;i++){if(await fn())return;await wait(20)}throw new Error(message)}
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.WelcomeTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1000,default_height:850});win.present();const gateway=new Gateway(ARGV[1],'fixture-secret');let chat,stage='confirmed empty Main';
 const mode=mode=>gateway.json('POST','/fixture/mode',{mode});
 const prefs=(mode,text='')=>gateway.json('POST','/api/ui/preferences',{welcome:{mode,text}});
 (async()=>{
  chat=new ChatPage(win,gateway,{chatId:1,name:'Main'},()=>{});win.set_content(chat.widget);const welcome=chat.welcome.widget;
  check(!welcome.visible,'welcome appeared before a successful complete history read');await until(()=>welcome.visible,'default empty Main welcome missing: '+chat.historyError);
  check(welcome.label==='Ouroboros has awakened'&&!welcome.use_markup,'default welcome text/markup differs');
  stage='custom literal copy';const custom='  Привет <b>буквально</b> & 🔧\nСтрока  ';await prefs('custom',custom);await chat.readHistory();await until(()=>welcome.label===custom&&welcome.visible,'custom preference not rendered literally');check(!welcome.use_markup&&(await gateway.json('GET','/fixture/facts')).rows===0,'welcome became markup or chat history');
  if(!GLib.getenv('FLATPAK_ID')&&GLib.find_program_in_path('import')){await wait(80);Gio.Subprocess.new(['import','-window','root',ARGV[2]+'/welcome-custom.png'],Gio.SubprocessFlags.NONE).wait_check(null)}
  stage='pending/partial/failed history';await mode('delayed');const reading=chat.readHistory();check(!welcome.visible,'welcome remained during pending history');await reading;await until(()=>welcome.visible,'successful delayed history did not restore welcome');
  await mode('partial');await chat.readHistory();check(!welcome.visible,'partial empty history claimed confirmed emptiness');await mode('failed');await chat.readHistory();check(!welcome.visible&&chat.historyError,'failed history retained welcome');
  stage='preference read failure';await mode('preferences_failed');await chat.readHistory();await until(()=>welcome.visible,'failed preferences read lost last observed custom copy');check(welcome.label===custom,'failed preferences read replaced known copy');
  stage='hidden and room switch';await mode('normal');await prefs('hidden');await chat.readHistory();await until(()=>chat.welcome.copy===undefined,'hidden preference not read');check(!welcome.visible,'hidden welcome still mounted');
  await prefs('default');chat.setRoom({chatId:7,name:'Other'});await chat.readHistory();check(!welcome.visible,'welcome appeared outside Main');chat.setRoom({chatId:1,name:'Main'});await until(()=>welcome.visible,'returning to empty Main did not restore default');
  stage='live message withdraws welcome';await gateway.json('POST','/fixture/append',{});await until(()=>!welcome.visible&&chat.current.length>0,'live/history message did not withdraw welcome');await chat.readHistory();check(!welcome.visible&&(await gateway.json('GET','/fixture/facts')).rows===1,'welcome altered stored history');
  print('OK: real welcome preferences/history in native ChatPage; default/custom literal Unicode and whitespace, hidden, pending/partial/failed history, failed preferences retaining choice, Main-only display, live message withdrawal and no synthetic history row');
 })().catch(error=>{failed=true;logError(error);print('Stage: '+stage);if(chat)print(JSON.stringify({copy:chat.welcome.copy,visible:chat.welcome.widget.visible,complete:chat.welcome.complete,current:chat.current.length,after:chat.after,error:chat.historyError}))}).finally(async()=>{await chat?.close();gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
