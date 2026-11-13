import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {Skills}=await import(ARGV[0]+'skills.js');
const {NativeI18n,useNativeI18n}=await import(ARGV[0]+'native-i18n.js');
const canonical=v=>JSON.stringify(v,(key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value);
const check=(v,m)=>{if(!v)throw new Error(m)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,m){for(let i=0;i<1500;i++){if(await fn())return;await wait(20)}throw new Error(m)}
function all(w,p){let out=p(w)?[w]:[];if(w instanceof Gtk.Expander){const c=w.get_child();return c?[...out,...all(c,p)]:out}for(let c=w.get_first_child?.();c;c=c.get_next_sibling())out.push(...all(c,p));return out}
const button=(w,t)=>all(w,w=>w instanceof Gtk.Button&&w.label===t)[0];
const text=w=>all(w,w=>w instanceof Gtk.Label).map(w=>w.label).join('\n');
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.SkillContinuationTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1000,default_height:1000});win.present();const gateway=new Gateway(ARGV[1],'fixture-secret');const skills=new Skills(win,gateway);let catalog,stage='real stopped wave';
 const facts=()=>gateway.json('GET','/fixture/facts');
 const chooser=()=>[...skills.children].find(w=>['Продолжить проверку','Continue review','QAA review'].includes(w.title));
 const review=()=>skills.detail.skill.skill_review.history.find(r=>r.record_id&&r.continuable_seats?.length);
 const choose=()=>{button(skills.detail.body,'Продолжить остановленную проверку…').emit('clicked');return chooser()};
 (async()=>{
  skills.show();skills.openInstalled('weather');await until(()=>skills.detail?.skill?.name==='weather'&&review(),'native stopped review absent');
  let f=await facts();check(f.posts.length===2&&review().continuable_seats.length===2,'two real stopped seats missing');const recordId=review().record_id,contentHash=review().content_hash;
  stage='empty selection and cancellation';let dialog=choose(),submit=button(dialog,'Продолжить выбранных');const checks=all(dialog,w=>w instanceof Gtk.CheckButton);
  check(dialog&&checks.length===2&&checks.every(w=>!w.active)&&!submit.sensitive,'selector defaults selected or permits empty choice');
  submit.emit('clicked');check((await facts()).posts.length===2,'empty submission started session');checks[0].active=true;button(dialog,'Отмена').emit('clicked');submit.emit('clicked');check((await facts()).posts.length===2,'cancelled chooser started session');
  stage='malformed offers never dispatch';const source=review(),skill=skills.detail.skill;
  for(const offers of [[{seat_id:'s'}],[{seat_id:'s',operation_id:'o'},{seat_id:'s',operation_id:'q'}],[null],[{seat_id:'s',operation_id:' ',cause:'x'}],[{seat_id:'s',operation_id:'o',run_id:42}]]){
   skills.continueReview(skill,{...source,continuable_seats:offers},skills.detail.dialog);check(!chooser(),'malformed offer opened chooser');
  }
  check((await facts()).posts.length===2,'malformed offers sent work');
  stage='one chosen seat continues its retained run';dialog=choose();const selections=all(dialog,w=>w instanceof Gtk.CheckButton);const expected=source.continuable_seats[1];selections[1].active=true;
  button(dialog,'Продолжить выбранных').emit('clicked');
  await until(async()=>(await facts()).posts.length===3&&!skills.writing.size&&!skills.pending.size,'one-seat continuation did not settle');await skills.refresh();
  f=await facts();const sent=f.audit.filter(r=>r.method==='POST'&&r.path==='/api/skills/weather/review');
  check(sent.length===1&&JSON.stringify(sent[0].body)==JSON.stringify({review_reference:{record_id:recordId,content_hash:contentHash},continue_seats:[{seat_id:expected.seat_id,operation_id:expected.operation_id}]}),'request did not name exact selected seat/reference');
  const continued=f.posts[2];check(continued.request.continueFrom===expected.run_id,'continued wrong original run');
  const original=f.posts.find(p=>p.run_id===expected.run_id);check(Object.keys({...original.request,...continued.request}).filter(k=>canonical(original.request[k])!==canonical(continued.request[k])).every(k=>['prompt','maxSeconds','continueFrom'].includes(k)),'continuation changed retained request: '+JSON.stringify(Object.keys({...original.request,...continued.request}).filter(k=>canonical(original.request[k])!==canonical(continued.request[k]))));
  check(review().record_id===recordId&&review().continuable_seats.length===1&&review().continuable_seats[0].seat_id!==expected.seat_id,'other stopped reviewer was continued or record changed: '+JSON.stringify(skills.detail.skill.skill_review.history));
  stage='remaining seat explicit continuation';dialog=choose();all(dialog,w=>w instanceof Gtk.CheckButton)[0].active=true;button(dialog,'Продолжить выбранных').emit('clicked');
  await until(async()=>(await facts()).posts.length===4&&!skills.writing.size&&!skills.pending.size,'remaining continuation pending');await skills.refresh();
  f=await facts();check(skills.detail.skill.review_status==='clean'&&!button(skills.detail.body,'Продолжить остановленную проверку…')&&f.record.rows.every(r=>r.status==='responded'),'answered seats still offered or projection not clean');
  stage='stale revision and close guards';const oldSkill=skills.detail.skill,oldReview={...source};skills.continueReview(oldSkill,oldReview,skills.detail.dialog);dialog=chooser();all(dialog,w=>w instanceof Gtk.CheckButton)[0].active=true;const staleSubmit=button(dialog,'Продолжить выбранных');
  await gateway.json('POST','/fixture/control',{action:'change-payload'});await skills.refresh();staleSubmit.emit('clicked');await wait(40);check((await facts()).posts.length===4&&!chooser(),'stale revision continued old work');
  stage='selector language, literal identity and close';
  await gateway.json('POST','/api/ui/i18n/language',{language:'en'});catalog=new NativeI18n(gateway);useNativeI18n(catalog);await until(()=>catalog.language==='en','English unavailable');
  const current=skills.detail.skill,privateSeat='private-seat <&> Ω '+ 'x'.repeat(2048);
  skills.continueReview(current,{...oldReview,content_hash:current.content_hash,continuable_seats:[{...oldReview.continuable_seats[0],seat_id:privateSeat}]},skills.detail.dialog);dialog=chooser();
  const localeCheck=all(dialog,w=>w instanceof Gtk.CheckButton)[0];localeCheck.active=true;const closedSubmit=button(dialog,'Continue selected reviewers');
  check(text(dialog).includes(privateSeat)&&all(dialog,w=>w instanceof Gtk.Label&&w.label.includes(privateSeat)).every(w=>!w.use_markup&&w.measure(Gtk.Orientation.HORIZONTAL,-1)[0]<=640),'private identity was parsed/truncated or broke geometry');
  const translated=await gateway.json('POST','/api/ui/i18n/import',{language:'qaa',entries:{'Continue review':{text:'QAA review'},'Continue selected reviewers':{text:'QAA selected'}}});
  await gateway.json('POST','/api/ui/i18n/language',{language:'qaa',profile:{direction:'rtl'}});catalog.frame({type:'ui_language_changed',language:'qaa'});catalog.frame({type:'ui_i18n_updated',language:'qaa',revision:translated.revision});
  await until(()=>dialog.title==='QAA review'&&closedSubmit.label==='QAA selected','live selector translation absent');
  check(localeCheck.active&&closedSubmit.sensitive&&text(dialog).includes(privateSeat)&&dialog.get_direction()===Gtk.TextDirection.RTL,'locale replaced choice/private identity/direction');
  await until(async()=>(await facts()).audit.some(r=>r.path==='/api/ui/i18n/missing'),'missing report absent');
  check(!JSON.stringify((await facts()).audit.filter(r=>r.path==='/api/ui/i18n/missing')).includes('private-seat'),'private identity entered missing registry');
  skills.close();closedSubmit.emit('clicked');await wait(30);
  const frozenTitle=dialog.title,frozenSubmit=closedSubmit.label;await gateway.json('POST','/api/ui/i18n/language',{language:'en'});catalog.frame({type:'ui_language_changed',language:'en'});await until(()=>catalog.language==='en','language reset pending');
  check(dialog.title===frozenTitle&&closedSubmit.label===frozenSubmit,'closed selector retained chrome bindings');
  f=await facts();check(f.posts.length===4&&f.audit.filter(r=>r.method==='POST'&&r.path==='/api/skills/weather/review').length===2&&!skills.children.size,'closed chooser sent another request');
  print('OK: native Skills stopped-review seat selector through real review lifecycle, ledger/custody, frozen skill payload and continuation collector; two scripted engine stops, exact chosen subset starts one retained successor, other seat stays stopped until explicit selection, same record and original request fields, clean final projection; empty/cancelled/malformed/stale/closed guards without POST; physical engine scripted, no external model/provider');
 })().catch(error=>{failed=true;logError(error);print('Stage: '+stage)}).finally(()=>{skills.close();catalog?.close();useNativeI18n();gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
