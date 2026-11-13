import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {Skills}=await import(ARGV[0]+'skills.js');
const {SkillActionRefusalView,readSkillActionRefusal}=await import(ARGV[0]+'skill-action-refusal.js');
const {NativeI18n,useNativeI18n}=await import(ARGV[0]+'native-i18n.js');
const check=(v,m)=>{if(!v)throw new Error(m)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,m){for(let i=0;i<700;i++){if(await fn())return;await wait(20)}throw new Error(m)}
function all(w,p){let out=p(w)?[w]:[];for(let c=w.get_first_child?.();c;c=c.get_next_sibling())out.push(...all(c,p));return out}
const text=v=>all(v.widget.get_child(),w=>w instanceof Gtk.Label).map(w=>w.label).join('\n');
const button=(w,name)=>all(w,w=>w instanceof Gtk.Button&&w.label===name)[0];
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.SkillRefusalTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1000,default_height:900});win.present();const gateway=new Gateway(ARGV[1],'fixture-secret');let skills,catalog,standalone,stage='real installed extension';
 const facts=()=>gateway.json('GET','/fixture/facts');
 (async()=>{
  await gateway.json('POST','/api/ui/i18n/language',{language:'en'});catalog=new NativeI18n(gateway);useNativeI18n(catalog);await until(()=>catalog.language==='en','English unavailable');
  skills=new Skills(win,gateway);skills.show();await skills.refresh();const skill=skills.installed.find(s=>s.name==='response_fixture');check(skill&&skill.content_hash,'real installed skill absent');skills.open(skill);const detail=skills.detail;
  stage='native stale grant selection and actual preflight refusal';button(detail.body,'Выдать доступ…').emit('clicked');const form=[...skills.children].find(d=>d!==detail.dialog&&all(d.get_child(),w=>w instanceof Gtk.CheckButton).length);
  check(form,'native grant form absent');const choice=all(form.get_child(),w=>w instanceof Gtk.CheckButton&&w.label==='inject_chat')[0];check(choice,'native permission choice absent');choice.active=true;
  await gateway.json('POST','/fixture/control',{action:'grant-policy'});button(form.get_child(),'Разрешить').emit('clicked');await until(()=>!skills.writing.has(skill.name)&&detail.refusal.widget.visible,'real grant refusal not rendered');
  const receipt=detail.refusal;receipt.widget.expanded=true;check(text(receipt).includes('/api/skills/response_fixture/grants'),'request endpoint absent');check(text(receipt).includes('grant items must be requested by the current manifest')&&text(receipt).includes('Allowed permissions in this response · [')&&text(receipt).includes('"tool"')&&text(receipt).includes('Rejected items in this response · [')&&text(receipt).includes('"inject_chat"'),'refusal inventories lost '+text(receipt));
  let f=await facts();check(f.audit.filter(r=>r.path.endsWith('/grants')).length===1,'grant automatically replayed');const installed=skills.installed.find(s=>s.name===skill.name);check(!installed.enabled&&!(installed.grants?.granted_permissions??[]).includes('inject_chat'),'refused grant changed installed access');
  stage='response retained on reread and close/reopen';await skills.refresh();check(detail.refusal===receipt&&receipt.widget.expanded,'refresh replaced response/expansion');detail.dialog.force_close();skills.open(installed);check(text(skills.detail.refusal).includes('inject_chat'),'reopen lost operation response');
  stage='real revision refusal supersedes prior inventory';await skills.run(skill.name,'/api/skills/response_fixture/toggle',{expected_content_hash:'wrong',enabled:true});check(skills.detail.refusal.widget.visible&&!text(skills.detail.refusal).includes('Rejected items in this response'),'new request retained prior refusal inventories');check(!skills.installed.find(s=>s.name===skill.name).enabled,'revision refusal enabled skill');
  stage='native corrected grant succeeds without enabling extension';await gateway.json('POST','/fixture/control',{action:'grant-policy',restore:true});button(skills.detail.body,'Выдать доступ…').emit('clicked');
  const corrected=[...skills.children].find(d=>d!==skills.detail.dialog&&all(d.get_child(),w=>w instanceof Gtk.CheckButton).length);
  const tool=all(corrected.get_child(),w=>w instanceof Gtk.CheckButton&&w.label==='inject_chat')[0];check(tool,'corrected native permission choice absent');tool.active=true;button(corrected.get_child(),'Разрешить').emit('clicked');
  await until(()=>!skills.writing.has(skill.name)&&(skills.installed.find(s=>s.name===skill.name)?.grants?.granted_permissions??[]).includes('inject_chat'),'real corrected grant failed');
  check(!skills.detail.refusal.widget.visible&&!skills.refusals.has(skill.name)&&!skills.installed.find(s=>s.name===skill.name).enabled,'success retained refusal or enabled extension');
  stage='typed optional and malformed refusal reads';standalone=new SkillActionRefusalView(skill.name);standalone.update(undefined,503);check(standalone.widget.visible&&text(standalone).includes('could not be read'),'missing error body silently hidden');standalone.update({ok:false,error:'private refusal <&>',allowed_keys:[],allowed_permissions:[],rejected_items:[],enabled:false,review_stale:false,extension_action:null,review_gate:{future:true}},409);check(text(standalone).includes('[]')&&text(standalone).includes('false')&&text(standalone).includes('null'),'empty/false/null response lost');
  const valid={ok:false,error:'private refusal <&>',skill:skill.name};
  for(const bad of [null,[],{}, {...valid,skill:'other-skill'},{...valid,ok:true},{...valid,detail:[]},{...valid,allowed_keys:[3]},{...valid,allowed_permissions:{}},{...valid,rejected_items:null},{...valid,enabled:0},{...valid,review_gate:[]},{...valid,status_code:'409'}]){
   standalone.update(bad,409);check(!readSkillActionRefusal(bad,skill.name)&&text(standalone).includes('could not be read')&&!text(standalone).includes('private refusal'),'bad response reused trusted fields');
  }
  stage='future code, literal long values, locale and close';const privateValue='private response <&> Ω '+'x'.repeat(2048);standalone.update({...valid,code:'constructor',detail:privateValue,allowed_permissions:['future-permission']},409);standalone.widget.expanded=true;
  for(const label of all(standalone.widget.get_child(),w=>w instanceof Gtk.Label))check(!label.use_markup&&label.measure(Gtk.Orientation.HORIZONTAL,-1)[0]<680,'response markup/geometry unsafe');
  const imported=await gateway.json('POST','/api/ui/i18n/import',{language:'qaa',entries:{'Skill action response details':{text:'QAA response'},'Refusal detail · {value}':{text:'QAA detail · {value}'}}});await gateway.json('POST','/api/ui/i18n/language',{language:'qaa',profile:{direction:'rtl'}});catalog.frame({type:'ui_language_changed',language:'qaa'});catalog.frame({type:'ui_i18n_updated',language:'qaa',revision:imported.revision});await until(()=>standalone.widget.label==='QAA response'&&text(standalone).includes('QAA detail'),'live response locale absent');check(standalone.widget.expanded&&standalone.widget.get_direction()===Gtk.TextDirection.RTL&&text(standalone).includes(privateValue),'locale changed snapshot/direction/expansion');await until(async()=>(await facts()).audit.some(r=>r.path==='/api/ui/i18n/missing'&&r.body),'actual missing report absent');
  f=await facts();check(!f.audit.some(r=>r.path==='/api/ui/i18n/missing'&&JSON.stringify(r.body).includes('private response')),'response value became source key');
  const frozen=text(standalone),heading=standalone.widget.label;standalone.close();standalone.update(valid,400);await gateway.json('POST','/api/ui/i18n/language',{language:'en'});catalog.frame({type:'ui_language_changed',language:'en'});await until(()=>catalog.language==='en','English reset absent');check(text(standalone)===frozen&&standalone.widget.label===heading,'closed response accepted changes');
  print('OK: native installed Skills/grant selection through actual lifecycle handler and changed admission policy returns allowed/rejected permission inventories without writes/replay; operation response separate from fresh installed state, revision refusal replaces old inventory, corrected native grant saves the selected inject_chat permission without enabling extension and clears old response, reopen/expansion, optional zero-length/false/null fields, 12 malformed/mismatched responses, future code/literal long values, QAA/RTL/private keys and close ownership; no model/provider execution');
 })().catch(error=>{failed=true;logError(error);print('Stage: '+stage)}).finally(()=>{standalone?.close();skills?.close();catalog?.close();useNativeI18n();gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
