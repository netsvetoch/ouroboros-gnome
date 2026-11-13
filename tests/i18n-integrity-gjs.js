import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {NativeI18n,useNativeI18n,chrome}=await import(ARGV[0]+'native-i18n.js');
const check=(x,m)=>{if(!x)throw new Error(m)};
const wait=ms=>new Promise(r=>GLib.timeout_add(0,ms,()=>{r();return GLib.SOURCE_REMOVE}));
async function until(fn,m){for(let i=0;i<600;i++){if(await fn())return;await wait(20)}throw new Error(m)}
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.I18nIntegrityTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const gateway=new Gateway(ARGV[1],'fixture-secret'),observer=new Gateway(ARGV[1],'fixture-secret'),catalog=new NativeI18n(gateway);useNativeI18n(catalog);const win=new Adw.ApplicationWindow({application:app,default_width:700,default_height:450}),box=new Gtk.Box({orientation:Gtk.Orientation.VERTICAL});win.set_content(box);win.present();let stage='';
 const chat=chrome(new Gtk.Label(),'label','Chat'),send=chrome(new Gtk.Button(),'label','Send'),count=chrome(new Gtk.Label(),'label','{n} items',{n:102});for(const w of [chat,send,count])box.append(w);
 const facts=()=>observer.json('GET','/fixture/facts'),control=body=>observer.json('POST','/fixture/control',body);
 const read=async()=>{const n=(await facts()).audit.filter(x=>x.method==='GET').length;catalog.refresh();await until(async()=>(await facts()).audit.filter(x=>x.method==='GET').length>n&&!catalog.reading&&!catalog.timer,'dictionary read did not settle')};
 (async()=>{
  stage='initial valid dictionary';await until(()=>catalog.language!==undefined,'initial language absent');await gateway.json('POST','/api/ui/i18n/language',{language:'qaa',profile:{direction:'rtl'},plural_select:{period:100,map:{'1':'one','2':'few'}},plural_categories:['one','few','other']});catalog.frame({type:'ui_language_changed',language:'qaa'});await until(()=>catalog.language==='qaa'&&chat.label==='QAA Chat'&&count.label==='102 several','valid qaa dictionary not painted');const revision=catalog.revision;
  stage='whole snapshot failure retains all widgets, revision and direction';for(const mode of ['entry','forms','profile','plural','stats','languages','generator','error']){await control({action:'fault',mode});await read();check(catalog.revision===revision&&chat.label==='QAA Chat'&&send.label==='QAA Send'&&count.label==='102 several'&&Gtk.Widget.prototype.get_direction.call(send)===Gtk.TextDirection.RTL,'partial/poisoned dictionary applied '+mode);check(!catalog.missing.size,'malformed snapshot generated false missing translations '+mode)}
  stage='malformed inflated revision does not poison later valid read';await control({action:'fault',mode:''});const imported=await gateway.json('POST','/api/ui/i18n/import',{language:'qaa',entries:{Chat:{text:'Verified later Chat'},Send:{text:'Verified later Send'}}});catalog.frame({type:'ui_i18n_updated',language:'qaa',revision:imported.revision});await until(()=>catalog.revision===imported.revision&&chat.label==='Verified later Chat'&&send.label==='Verified later Send','invalid high revision poisoned recovery');
  stage='valid English switch remains possible after faults';await gateway.json('POST','/api/ui/i18n/language',{language:'en'});catalog.frame({type:'ui_language_changed',language:'en'});await until(()=>chat.label==='Chat'&&send.label==='Send'&&count.label==='102 items','English recovery failed');check(Gtk.Widget.prototype.get_direction.call(send)===Gtk.TextDirection.LTR,'English direction not restored');
  print('OK: NativeI18n through real primary dictionary API/memory: malformed entry/forms/profile/plural/stats/languages/generator and memory_error atomically retain verified text/count/direction/revision; inflated invalid revision cannot poison valid import or English recovery; no model/generator');
 })().catch(e=>{failed=true;logError(e);print('Stage: '+stage)}).finally(()=>{catalog.close();gateway.close();observer.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
