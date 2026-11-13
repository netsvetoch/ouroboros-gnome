import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {TaskReviews}=await import(ARGV[0]+'task-reviews.js');
const {NativeI18n,useNativeI18n}=await import(ARGV[0]+'native-i18n.js');
const check=(x,m)=>{if(!x)throw new Error(m)};
const wait=ms=>new Promise(r=>GLib.timeout_add(0,ms,()=>{r();return GLib.SOURCE_REMOVE}));
async function until(fn,m){for(let i=0;i<700;i++){if(await fn())return;await wait(20)}throw new Error(m)}
function all(w,p){let a=p(w)?[w]:[];for(let c=w.get_first_child?.();c;c=c.get_next_sibling())a.push(...all(c,p));return a}
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.PdfI18nTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1100,default_height:1000});win.present();
 const gateway=new Gateway(ARGV[1],'fixture-secret'),catalog=new NativeI18n(gateway),reviews=new TaskReviews(gateway);useNativeI18n(catalog);
 let stage='language bootstrap',hold=false,held,dialog;
 const spawn=Gio.SubprocessLauncher.prototype.spawnv;
 Gio.SubprocessLauncher.prototype.spawnv=function(args){const block=hold&&args.some(x=>x.endsWith('/pdf-render-worker.js'));if(block)hold=false;const p=spawn.call(this,block?[GLib.find_program_in_path('sleep'),'60']:args);if(block)held=p;return p};
 const facts=()=>gateway.json('GET','/fixture/facts'),labels=()=>all(dialog.get_child(),w=>w instanceof Gtk.Label).map(w=>w.label).join('\n');
 const language=async language=>{await gateway.json('POST','/api/ui/i18n/language',{language});catalog.frame({type:'ui_language_changed',language});await until(()=>catalog.language===language,'language not read '+language)};
 const pairs={'PDF password':'QAA password','Open PDF with password':'QAA open','Reload PDF':'QAA reload','_Page':'QAA _page','Previous':'QAA previous','Next':'QAA next','Zoom in':'QAA zoom','Fit page':'QAA fit','A password is required to read this PDF.':'QAA password needed','Incorrect PDF password. Try again.':'QAA wrong password','Opening password-protected PDF…':'QAA opening','Preparing page {page}…':'QAA preparing {page}','of {pages}':'QAA total {pages}','{name} · page {page}':'QAA {name} / {page}'};
 const pack=()=>({language:'qaa',entries:Object.fromEntries(Object.entries(pairs).map(([k,text])=>[k,{text}]))});
 const imported=async()=>{const result=await gateway.json('POST','/api/ui/i18n/import',pack());catalog.frame({type:'ui_i18n_updated',language:'qaa',revision:result.revision});catalog.refresh()};
 (async()=>{
  await language('en');const data=await facts(),pdf=data.pdf,name='private-filename-Ω-726.pdf';
  reviews.artifactPdf(win,name,'/api/tasks/'+pdf.task+'/artifacts/locked.pdf',pdf.identities['locked.pdf']);dialog=[...reviews.dialogs].at(-1);
  await until(()=>labels().includes('A password is required to read this PDF.'),'English password state absent');
  const input=all(dialog.get_child(),w=>w instanceof Adw.PasswordEntryRow)[0],buttons=all(dialog.get_child(),w=>w instanceof Gtk.Button),find=s=>buttons.find(w=>w.label===s),unlock=find('Open PDF with password'),reload=find('Reload PDF'),next=find('Next'),zoom=find('Zoom in'),spin=all(dialog.get_child(),w=>w instanceof Gtk.SpinButton)[0],picture=all(dialog.get_child(),w=>w instanceof Gtk.Picture)[0];
  const reads=()=>facts().then(d=>d.audit.filter(x=>x.path.includes('/artifacts/')).length),count=await reads();
  input.text='private-unsent-password-483';await imported();await language('qaa');await until(()=>unlock.label==='QAA open','QAA controls absent');
  check(input.title==='QAA password'&&input.text==='private-unsent-password-483'&&unlock.sensitive&&labels().includes('QAA password needed')&&(await reads())===count,'locale altered password draft/read/state');
  await until(async()=>(await facts()).audit.some(x=>x.path==='/api/ui/i18n/missing'),'initial missing source audit not flushed');
  stage='revision preserves exact native password row';pairs['Open PDF with password']='QAA revised open';await imported();await until(()=>unlock.label==='QAA revised open','revision not applied');check(all(dialog.get_child(),w=>w instanceof Adw.PasswordEntryRow)[0]===input&&input.text==='private-unsent-password-483','revision rebuilt or cleared entry');
  input.text='wrong-private-password';unlock.emit('clicked');await until(()=>labels().includes('QAA wrong password'),'translated wrong password absent');check(input.text==='','submitted password retained');await language('en');await until(()=>labels().includes('Incorrect PDF password. Try again.'),'error did not repaint');
  stage='actual password render and locale preserve page/zoom';input.text='fixture-password';unlock.emit('clicked');await until(()=>picture.get_paintable()&&reload.sensitive,'actual protected first page absent');next.emit('clicked');await until(()=>picture.get_alternative_text()===name+' · page 2'&&reload.sensitive,'second page absent');zoom.set_active(true);const texture=picture.get_paintable();await language('qaa');await until(()=>picture.get_alternative_text()==='QAA '+name+' / 2','accessible page description absent');check(picture.get_paintable()===texture&&spin.get_value_as_int()===2&&zoom.active&&zoom.label==='QAA fit'&&labels().includes('QAA total 3')&&(await reads())===count,'locale rerendered/refetched/changed navigation');
  stage='missing accessible template excludes filename value';delete pairs['{name} · page {page}'];await imported();await until(()=>picture.get_alternative_text()===name+' · page 2','missing template fallback absent');await until(async()=>(await facts()).audit.some(x=>x.path==='/api/ui/i18n/missing'&&x.body.items.some(i=>i.key==='{name} · page {page}'&&i.context.params.includes('name'))),'template missing key not queued');check(picture.get_paintable()===texture&&(await reads())===count,'missing translation rerendered or fetched');
  stage='pending worker and close release bindings';reload.emit('clicked');await until(()=>labels().includes('QAA password needed'),'reload did not request password');hold=true;input.text='fixture-password';unlock.emit('clicked');await until(()=>held,'held worker absent');await language('en');await until(()=>labels().includes('Opening password-protected PDF…'),'busy caption did not repaint');check(!reload.sensitive&&!unlock.sensitive&&input.text==='','locale unlocked pending operation');dialog.force_close();const caption=unlock.label;await language('qaa');await wait(1200);check(unlock.label===caption&&input.text===''&&!picture.get_paintable(),'closed PDF bindings repainted or retained contents');
  await until(async()=>(await facts()).audit.some(x=>x.path==='/api/ui/i18n/missing'),'missing source audit not flushed');
  const audit=(await facts()).audit,missing=audit.filter(x=>x.path==='/api/ui/i18n/missing');check(missing.length,'no missing source audit');const wire=JSON.stringify(missing);check(![name,'private-unsent-password-483','wrong-private-password','fixture-password'].some(x=>wire.includes(x)),'private data entered translation queue');check(audit.filter(x=>x.path.includes('/artifacts/')).every(x=>x.method==='GET'),'preview changed artifact state');
  print('OK: native PDF live i18n through primary language/import/memory/missing API; English/QAA/revision preserve password row/draft, actual Poppler pages/zoom/texture and download count; errors/accessibility/total/busy labels repaint; close releases bindings; private filename/password excluded from missing sources. Revision/language frames delivered directly; no generator or portal.');
 })().catch(e=>{failed=true;logError(e);print('Stage: '+stage);if(dialog)print(labels())}).finally(()=>{reviews.close();if(held)try{held.force_exit()}catch{}catalog.close();gateway.close();Gio.SubprocessLauncher.prototype.spawnv=spawn;win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
