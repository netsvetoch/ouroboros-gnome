import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {GatewayTranslations}=await import(ARGV[0]+'translations.js');
const check=(value,message)=>{if(!value)throw new Error(message)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,message){for(let i=0;i<1000;i++){if(await fn())return;await wait(20)}throw new Error(message)}
function all(widget,predicate){let result=predicate(widget)?[widget]:[];for(let child=widget.get_first_child?.();child;child=child.get_next_sibling())result.push(...all(child,predicate));return result}
const text=root=>all(root,w=>w instanceof Gtk.Label).map(w=>w.label).join('\n');
const press=(root,caption)=>{const button=all(root,w=>w instanceof Gtk.Button&&w.label===caption)[0];check(button?.is_sensitive(),'button unavailable: '+caption);button.emit('clicked')};
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.TranslationTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1000,default_height:850});win.present();const gateway=new Gateway(ARGV[1],'fixture-secret');let changed=0,stage='native language write';
 const translations=new GatewayTranslations(gateway,(dialog,parent)=>dialog.present(parent??win),()=>{changed++});
 const facts=()=>gateway.json('GET','/fixture/facts');
 const methods={open:Gtk.FileDialog.prototype.open,open_finish:Gtk.FileDialog.prototype.open_finish,save:Gtk.FileDialog.prototype.save,save_finish:Gtk.FileDialog.prototype.save_finish};
 for(const method of ['open','save'])Gtk.FileDialog.prototype[method]=function(parent,_cancel,callback){check(parent===win,'translation chooser parent differs');GLib.idle_add(0,()=>{callback(this,null);return GLib.SOURCE_REMOVE})};
 Gtk.FileDialog.prototype.open_finish=()=>Gio.File.new_for_path(ARGV[2]+'/import.json');Gtk.FileDialog.prototype.save_finish=()=>Gio.File.new_for_path(ARGV[2]+'/export.json');
 const present=Adw.AlertDialog.prototype.present;let response;
 Adw.AlertDialog.prototype.present=function(parent){present.call(this,parent);check(response,'unexpected translation confirmation');const answer=response;response=undefined;GLib.idle_add(0,()=>{this.emit('response',answer);this.close();return GLib.SOURCE_REMOVE})};
 (async()=>{
  translations.show(win);const view=translations.view;await until(()=>view.ready,'initial translation snapshot unavailable');for(const expander of all(view.dialog.get_child(),w=>w instanceof Gtk.Expander))expander.expanded=true;
  check(view.snapshot.language===''&&!view.snapshot.chosen&&view.snapshot.english,'unchosen language not represented as English source');
  view.language.text='fr';view.languageLabel.text='Français';view.instruction.text='Français simple';view.direction.selected=1;view.choose.emit('clicked');await until(()=>view.ready&&!view.busy&&view.snapshot.language==='fr','native language choice failed');let state=await facts();
  check(state.settings.OUROBOROS_UI_LANGUAGE==='fr'&&view.snapshot.profile.label==='Français'&&view.snapshot.plural_select.map['1']==='one'&&view.snapshot.plural_select.map['2']==='other'&&changed===1,'language/profile/plural rules not persisted');
  view.stored.selected=view.languages.findIndex(row=>row.language==='ru');view.useStored.emit('clicked');await until(()=>view.ready&&view.snapshot.language==='ru','stored language selection failed');
  stage='paged entries and filters';check(all(view.entries,w=>w instanceof Gtk.Expander).length===60,'initial dictionary page size incorrect');press(view.entries,'Показать ещё');check(all(view.entries,w=>w instanceof Gtk.Expander).length===66,'dictionary rows lost after paging');view.provenance.selected=1;check(all(view.entries,w=>w instanceof Gtk.Expander).length===1,'owner provenance filter failed');view.provenance.selected=0;
  stage='native import/export';response='ok';await view.importMemory();await until(()=>view.ready&&!view.reading,'import snapshot not ready');state=await facts();check(state.ru.entries.Settings.text==='Настройки владельца'&&state.ru.shadow.Settings.text==='Импортированный вариант'&&state.ru.entries.Skills.provenance==='imported','import overwrote owner or lost shadow/imported layer');
  await view.exportMemory();const [,exported]=GLib.file_get_contents(ARGV[2]+'/export.json');const document=JSON.parse(new TextDecoder().decode(exported));check(document.language==='ru'&&document.entries.Settings.provenance==='owner'&&document.shadow.Settings.text==='Импортированный вариант','native export changed owner/shadow memory');
  stage='missing strings';view.missing.buffer.set_text('New interface line\nAnother interface line\nNew interface line',-1);view.context.text='fixture-page';await view.reportMissing();await until(()=>view.ready&&!view.reading,'missing snapshot not ready');state=await facts();check(state.pending===2&&view.feedback.label.includes('Принято · 2')&&view.missing.buffer.get_char_count()===0,'missing keys not deduplicated/queued');
  stage='regenerate confirmation';response='cancel';await view.regenerateMemory();await until(()=>view.ready&&!view.reading,'cancelled regeneration did not recover');state=await facts();check(Object.values(state.ru.entries).filter(row=>row.provenance==='generated').length===65,'cancelled regeneration changed memory');
  response='ok';await view.regenerateMemory();await until(()=>view.ready&&!view.reading,'regeneration snapshot not ready');state=await facts();check(Object.values(state.ru.entries).every(row=>row.provenance!=='generated')&&state.ru.entries.Settings.provenance==='owner'&&state.ru.entries.Skills.provenance==='imported'&&view.feedback.label.includes('Удалено сгенерированных строк · 65'),'regeneration removed owner/imported translations or retained generated layer');
  stage='revision notification coherence';const revision=view.snapshot.revision;translations.frame({type:'ui_i18n_updated',language:'ru',revision:revision+1});await until(()=>!view.reading,'stale snapshot check stalled');check(!view.ready&&!view.controls.is_sensitive()&&view.snapshot.revision===revision,'revision notification accepted an old snapshot or left writes enabled');
  await gateway.json('POST','/fixture/advance',{});await view.refresh();await until(()=>view.ready&&view.snapshot.revision===revision+1,'new revision did not recover native translation controls');check(view.snapshot.entries['Native updated'].text==='Обновлённый перевод','new revision lost owner translation');
  stage='English and reset';await view.chooseLanguage('en');await until(()=>view.ready&&view.snapshot.language==='en','English switch failed');check(!view.report.is_sensitive(),'English still offers missing translation submission');await view.chooseLanguage('');await until(()=>view.ready&&!view.snapshot.chosen,'language reset failed');state=await facts();check(state.settings.OUROBOROS_UI_LANGUAGE===''&&state.ru.entries.Settings.text==='Настройки владельца','reset removed saved memory');
  for(const [method,path] of [['GET','/api/ui/i18n'],['POST','/api/ui/i18n/language'],['POST','/api/ui/i18n/import'],['GET','/api/ui/i18n/export'],['POST','/api/ui/i18n/missing'],['POST','/api/ui/i18n/regenerate']])check(state.audit.some(row=>row.method===method&&row.path===path&&row.status===200),'successful route missing: '+path);
  check(!all(view.dialog.get_child(),w=>String(w.constructor.name).includes('WebView')).length,'browser mounted in native translation settings');
  print('OK: real six i18n API routes through native language/profile/plurals, paged/filterable dictionary, import/export owner-shadow layers, missing-key queue, cancelled/accepted regeneration, revision-notification snapshot coherence, English/reset preserving memory; no generator/model execution');
 })().catch(error=>{failed=true;logError(error);print('Stage: '+stage)}).finally(()=>{translations.view?.dialog.force_close();gateway.close();for(const [name,method] of Object.entries(methods))Gtk.FileDialog.prototype[name]=method;Adw.AlertDialog.prototype.present=present;win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
