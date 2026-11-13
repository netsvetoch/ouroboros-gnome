import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {NativeI18n,useNativeI18n,chrome}=await import(ARGV[0]+'native-i18n.js');
const {Navigation}=await import(ARGV[0]+'navigation.js');
const {ChatPage}=await import(ARGV[0]+'chat.js');
const {GatewayTranslations}=await import(ARGV[0]+'translations.js');
const check=(value,message)=>{if(!value)throw new Error(message)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,message){for(let i=0;i<700;i++){if(await fn())return;await wait(20)}throw new Error(message)}
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.NativeI18nTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const gateway=new Gateway(ARGV[1],'fixture-secret');const win=new Adw.ApplicationWindow({application:app,default_width:1200,default_height:950});
 const catalog=new NativeI18n(gateway);useNativeI18n(catalog);let chat,nav,forward=true,stage='English fallback and explicit chrome bindings';
 const facts=()=>gateway.json('GET','/fixture/facts');const control=body=>gateway.json('POST','/fixture/control',body);
 (async()=>{
  const stack=new Adw.ViewStack();chat=new ChatPage(win,gateway,{chatId:1,name:'Main'},frame=>{if(forward)catalog.frame(frame)},undefined,undefined,()=>catalog.reconnect());
  const page=chrome(stack.add_titled_with_icon(chat.widget,'chat','Чат','mail-message-new-symbolic'),'title','Chat');
  chrome(stack.add_titled_with_icon(new Gtk.Label({label:'Owner Files'}),'files','Файлы','folder-symbolic'),'title','Files');
  const content=new Gtk.Box({orientation:Gtk.Orientation.VERTICAL});content.append(stack);
  const authored=new Gtk.Label({label:'Save'});content.append(authored);
  const input=new Gtk.Entry({text:'Save'});content.append(input);
  const source=new Gtk.TextView({editable:false,monospace:true});source.buffer.text='Save';content.append(source);
  const count=chrome(new Gtk.Label({label:'count'}),'label','{n} items',{n:102});content.append(count);
  const privateName='owner-private-name-718';const composed=chrome(new Gtk.Label({label:'composed'}),'label','Create {name}',{name:privateName});content.append(composed);
  const overridden=chrome(new Gtk.Label({label:'override'}),'label','Save');content.append(overridden);overridden.label='owner-private-override-934';
  nav=new Navigation(gateway,stack,content,blocked=>chat.setReadingBlocked(blocked));win.set_content(nav.widget);win.present();
  await until(()=>catalog.language!==undefined&&chat.socket.online,'native language bootstrap not ready');
  check(page.title==='Chat'&&chat.send.label==='Send'&&nav.save.label==='Save','English default was not applied');
  check(authored.label==='Save'&&input.text==='Save'&&source.buffer.text==='Save'&&overridden.label==='owner-private-override-934','unmarked data changed');

  stage='real language write and WS update';
  await gateway.json('POST','/api/ui/i18n/language',{language:'qaa',profile:{direction:'rtl'},
    plural_select:{period:100,map:{'0':'other','1':'one','2':'few'}},plural_categories:['one','few','other']});
  await until(()=>catalog.language==='qaa'&&page.title==='QAA Chat'&&chat.send.label==='QAA Send','real language frame did not update live native chrome');
  check(nav.save.label==='QAA Save'&&chat.composer.placeholder_text==='QAA Message…','native width controls/composer placeholder not translated');
  check(count.label==='102 several','stored periodic plural map not used');
  check(Gtk.Widget.prototype.get_direction.call(chat.send)===Gtk.TextDirection.RTL,'translated widget did not take declared direction');
  check(authored.label==='Save'&&input.text==='Save'&&source.buffer.text==='Save'&&overridden.label==='owner-private-override-934','dictionary changed authored content or an unmarked override');
  check(composed.label==='Create '+privateName,'fallback lost authored parameter');
  await until(async()=>Boolean((await facts()).pending.items?.['Create {name}']),'missing chrome not reported through real API');
  let data=await facts();const missing=data.audit.filter(a=>a.path.endsWith('/missing'));
  check(missing.length>0&&missing.every(a=>a.body.items.length<=200),'missing batch is invalid');
  check(!JSON.stringify(missing).includes(privateName)&&!JSON.stringify(missing).includes('owner-private-override-934'),'owner data entered missing reports');

  stage='dictionary import updates live bindings and stale read is discarded';
  await control({action:'hold'});catalog.refresh();await until(async()=>(await facts()).held,'old dictionary read not held');
  const updated=await gateway.json('POST','/api/ui/i18n/import',{language:'qaa',entries:{'Chat':{text:'QAA New Chat'},'Send':{text:'QAA New Send'}}});
  await until(()=>catalog.revisions.get('qaa')>=updated.revision,'revision frame not received');
  await control({action:'release'});await until(()=>catalog.revision>=updated.revision&&page.title==='QAA New Chat'&&chat.send.label==='QAA New Send','import did not repaint live widgets after stale read');
  check(overridden.label==='owner-private-override-934','import overwrote an unmarked writer');

  stage='last confirmed memory survives read failure';
  await control({action:'hold',fail:true});catalog.refresh();await until(async()=>(await facts()).held,'failing read not held');await control({action:'release'});
  await until(()=>!catalog.reading,'failed read not finished');check(page.title==='QAA New Chat'&&chat.send.label==='QAA New Send','failed read erased verified language');
  stage='native language editor notifies runtime without relying on WS';
  forward=false;
  const translations=new GatewayTranslations(gateway,(dialog,parent)=>dialog.present(parent),()=>{});translations.show(win);
  await until(()=>translations.view?.ready,'native language editor not ready');const editor=translations.view;editor.language.text='en';await editor.chooseLanguage();
  await until(()=>catalog.language==='en'&&page.title==='Chat'&&chat.send.label==='Send','native language editor did not switch runtime back to English');editor.dialog.force_close();
  check(count.label==='102 items'&&Gtk.Widget.prototype.get_direction.call(chat.send)===Gtk.TextDirection.LTR,'English fallback/plural/direction not restored');
  if(!GLib.getenv('FLATPAK_ID')&&GLib.find_program_in_path('import')){win.queue_draw();await new Promise(resolve=>{let frames=0;win.add_tick_callback(()=>{if(++frames<3)return GLib.SOURCE_CONTINUE;resolve();return GLib.SOURCE_REMOVE})});await wait(80);Gio.Subprocess.new(['import','-window','root',ARGV[2]+'/native-language.png'],Gio.SubprocessFlags.NONE).wait_check(null)}
  const before=(await facts()).audit.filter(a=>a.path.endsWith('/missing')).length;await wait(1200);check((await facts()).audit.filter(a=>a.path.endsWith('/missing')).length===before,'English language reported translation misses');
  print('OK: native live chrome from actual i18n memory/API/WS; English fallback, language choice, titles/buttons/placeholders, explicit plural map and widget direction, authored data and unmarked override isolation, bounded missing reports without owner parameters, imported revision/stale read, failed read retention and native editor switch; remaining UI call sites still need migration');
 })().catch(error=>{failed=true;logError(error);print('Stage: '+stage)}).finally(async()=>{catalog.close();await chat?.close();nav?.close();gateway.close();win.get_visible_dialog()?.force_close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
