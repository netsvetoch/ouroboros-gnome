import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {SchedulesPage}=await import(ARGV[0]+'schedules.js');
const check=(x,m)=>{if(!x)throw new Error(m)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,message){for(let i=0;i<700;i++){if(await fn())return;await wait(20)}throw new Error(message)}
function all(w,p){let out=p(w)?[w]:[];for(let c=w.get_first_child?.();c;c=c.get_next_sibling())out.push(...all(c,p));return out}
const text=d=>all(d.get_child(),w=>w instanceof Gtk.Label).map(w=>w.get_text()).join('\n');
const button=(d,caption)=>all(d.get_child(),w=>w instanceof Gtk.Button&&w.label===caption)[0];
const click=(d,caption)=>{const b=button(d,caption);check(b?.is_sensitive(),'missing/disabled button '+caption);b.emit('clicked')};
const reason=d=>all(d.get_child(),w=>w instanceof Adw.EntryRow&&w.title==='Причина')[0];
const choice=d=>all(d.get_child(),w=>w instanceof Gtk.DropDown)[0];
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.ScheduleHoldsTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const gateway=new Gateway(ARGV[1],'fixture-secret');const win=new Adw.ApplicationWindow({application:app,default_width:1050,default_height:900});let page,stage='initial observed restriction';const opened=[];
 const facts=()=>gateway.json('GET','/fixture/facts');const control=body=>gateway.json('POST','/fixture/control',body);
 const actionRows=async()=>((await facts()).audit).filter(r=>r.method==='POST'&&r.path.endsWith('/action'));
 const latest=()=>[...page.dialogs].at(-1);
 const action=(item)=>{page.action(item,{label:'Снять удержание',action:'restore',hold:item.followup_hold.hold_id});return latest()};
 (async()=>{
  page=new SchedulesPage(win,gateway,()=>({name:'Main',chatId:1}),()=>[],id=>opened.push(id));win.set_content(page.widget);win.present();await page.refresh();
  check(page.rows.size===4,'followup rows not returned');let item=page.rows.get('related-followup');
  check(item.status==='held'&&item.hold_persisted===false&&item.relation==='unknown','read fabricated a persisted hold or relationship');
  page.details(item);let d=latest();check(!button(d,'Снять удержание…'),'unpersisted observed restriction can be released');check(text(d).includes('ещё не подтвердил запись удержания'),'unpersisted hold not explained');d.force_close();
  check((await actionRows()).length===0,'read-only observation sent a lifecycle action');
  stage='persisted hold and unknown relationship guard';await control({action:'persist'});await page.refresh();item=page.rows.get('related-followup');check(item.hold_persisted===true,'real hold not persisted');
  d=action(item);click(d,'Снять удержание');check(text(d).includes('Укажите причину.'),'empty reason accepted');reason(d).text='Reviewed original work <&>';click(d,'Снять удержание');check(text(d).includes('Укажите связь'),'unknown relation accepted without decision');check((await actionRows()).length===0,'guarded form sent action');
  choice(d).set_selected(1);click(d,'Снять удержание');await until(()=>!page.dialogs.has(d),'related release did not close confirmed form');await page.refresh();
  let state=await facts();let row=state.store.tasks.find(r=>r.id===item.id);check(!row.followup_hold&&row.followup_relation.kind==='related','release did not record related relation');
  check(JSON.stringify(row.followup_relation.billing_group)===JSON.stringify(state.binding)&&row.followup_relation.deadline_at==='2099-01-01T00:00:00+00:00','related release changed original wallet/deadline');check(row.enabled===true&&state.pending.length===0,'release changed enablement or launched work');
  let receipt=(await actionRows()).at(-1);check(receipt.body.expected_hold_id===item.followup_hold.hold_id&&receipt.body.relation==='related'&&receipt.body.reason==='Reviewed original work <&>'&&receipt.reply.status==='hold_released','related action did not carry exact observed hold/decision');
  page.details(page.rows.get(item.id));d=latest();check(text(d).includes('10 USD')&&text(d).includes('2099')&&button(d,'Открыть исходную задачу'),'related authority not shown');click(d,'Открыть исходную задачу');check(opened.at(-1)==='schedule-origin','origin task navigation wrong');d.force_close();
  stage='independent decision';item=page.rows.get('independent-followup');d=action(item);reason(d).text='Independent owner work';choice(d).set_selected(2);click(d,'Снять удержание');await until(()=>!page.dialogs.has(d),'independent release not confirmed');await page.refresh();state=await facts();row=state.store.tasks.find(r=>r.id===item.id);check(row.followup_relation.kind==='independent'&&!row.followup_relation.billing_group&&!row.followup_hold,'independent work inherited original wallet or retained hold');
  stage='stale hold before submission';item=page.rows.get('racing-followup');d=action(item);reason(d).text='Old observed hold';choice(d).set_selected(1);const before=(await actionRows()).length;await control({action:'stop'});click(d,'Снять удержание');await until(()=>text(d).includes('Состояние расписания изменилось'),'old hold not rejected by fresh read');check((await actionRows()).length===before,'stale hold submitted despite fresh preflight');d.force_close();await page.refresh();
  stage='hold changes after preflight and before action commit';item=page.rows.get('racing-followup');d=action(item);reason(d).text='Race after observed preflight';choice(d).set_selected(1);await control({action:'hold'});click(d,'Снять удержание');await until(async()=>(await facts()).held,'action request not held after preflight');await control({action:'stop'});await control({action:'release'});
  await until(()=>text(d).includes('Удержание изменилось'),'server stale_hold refusal not shown');state=await facts();row=state.store.tasks.find(r=>r.id===item.id);receipt=(await actionRows()).at(-1);
  check(receipt.body.expected_hold_id===item.followup_hold.hold_id&&receipt.reply.status==='stale_hold'&&row.followup_hold&&row.followup_hold.hold_id!==item.followup_hold.hold_id,'late race released wrong hold');check(page.dialogs.has(d)&&button(d,'Проверить запись на шлюзе')&&!button(d,'Снять удержание').sensitive,'stale action form closed or became blindly reusable');d.force_close();
  await page.refresh();item=page.rows.get('racing-followup');d=action(item);reason(d).text='Fresh reviewed hold';choice(d).set_selected(1);click(d,'Снять удержание');await until(()=>!page.dialogs.has(d),'fresh race recovery not confirmed');
  stage='lost response after committed release';await page.refresh();item=page.rows.get('loss-followup');d=action(item);reason(d).text='One explicit independent release';choice(d).set_selected(2);const beforeLoss=(await actionRows()).length;await control({action:'lose'});click(d,'Снять удержание');
  await until(()=>text(d).includes('Результат действия неизвестен'),'lost release response treated as confirmed');check(!button(d,'Снять удержание').sensitive,'unknown release can be blindly replayed');state=await facts();row=state.store.tasks.find(r=>r.id===item.id);check(!row.followup_hold&&row.followup_relation.kind==='independent','fixture did not commit before lost receipt');
  click(d,'Проверить запись на шлюзе');await until(()=>button(d,'Открыть прочитанную запись…')?.visible,'lost result not recoverable by native readback');await wait(200);check((await actionRows()).length===beforeLoss+1,'readback automatically repeated a lifecycle action');d.force_close();
  state=await facts();check(state.pending.length===0,'held controls admitted work');check(state.audit.every(r=>r.method==='GET'||r.path.endsWith('/action')),'hold controls rewrote a schedule definition');
  print('OK: real followup schedule observation/durable holds, native reason/relationship guards, exact related and independent release with original billing/deadline, origin navigation, stale preflight and post-preflight Stop races, server refusal/readback and fresh recovery, lost committed response without automatic replay; no task admitted or executed');
 })().catch(e=>{failed=true;logError(e);print('Stage: '+stage)}).finally(()=>{page?.close();gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
