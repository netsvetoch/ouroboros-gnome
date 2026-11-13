import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {renderPlanReview}=await import(ARGV[0]+'plan-review.js');
const check=(value,message)=>{if(!value)throw new Error(message)};
function all(widget,predicate){let result=predicate(widget)?[widget]:[];for(let child=widget.get_first_child?.();child;child=child.get_next_sibling())result.push(...all(child,predicate));return result}
const text=root=>all(root,w=>w instanceof Gtk.Label).map(w=>w.label).join('\n');
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.PlanObjectionsTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1000,default_height:900});win.present();const gateway=new Gateway(ARGV[1],'fixture-secret');let stage='real standing fold';
 const read=()=>gateway.json('GET','/api/tasks/plan-objection-root'),step=action=>gateway.json('POST','/fixture/objection',{action});
 const render=data=>{const root=new Gtk.Box({orientation:Gtk.Orientation.VERTICAL});renderPlanReview(root,data,()=>{throw new Error('fixture has no source selector')});win.set_content(root);for(let i=0;i<5;i++)for(const widget of all(root,w=>w instanceof Gtk.Expander))widget.expanded=true;return root};
 (async()=>{
  let data=await read(),root=render(data);const before=data.plan_objections;
  check(data.status==='completed'&&before.open_objections['owner-seat'][0].holds===true&&before.open_objections['advisor-seat'][0].holds===false,'real fold did not distinguish holding/advisory');
  check(text(root).includes('Owner-marked risk <&>')&&text(root).includes('Advisory concern <&>')&&text(root).includes('Может удерживать решение')&&text(root).includes('Замечание без удержания')&&!text(root).includes('Открытых возражений нет.'),'native standing missing or implied clean');
  await step('silence');data=await read();root=render(data);check(data.plan_objections.open_objections['owner-seat'][0].not_adjudicated===true&&text(root).includes('Решение не зафиксировано'),'silence was treated as withdrawal');
  await step('withdraw-owner');data=await read();root=render(data);check(!data.plan_objections.open_objections['owner-seat']&&text(root).includes('Отозванные участниками')&&text(root).includes('Resolved <&>')&&text(root).includes('Advisory concern <&>')&&!text(root).includes('Открытых возражений нет.'),'one withdrawal hid the other seat');
  await step('withdraw-advisor');data=await read();root=render(data);check(data.status==='completed'&&Object.keys(data.plan_objections.open_objections).length===0&&data.plan_objections.withdrawn.length===2&&text(root).includes('Открытых возражений нет.'),'actual empty fold not represented');
  stage='invalid open roster never means no objections';
  const row={id:'risk',text:'Readable concern <&>',holds:true,revision:1};
  const bad=[null,[],{open_objections:true},{open_objections:[null]},{open_objections:[{}]},{open_objections:{seat:{}}},
    {open_objections:[{...row,text:42}]},{open_objections:[{...row,holds:'false'}]},{open_objections:[{...row,revision:-1}]},
    {open_objections:[{...row,not_adjudicated:1}]},{open_objections:[{...row,legacy:[]}]},{open_objections:{seat:[null]}}];
  for(const projection of bad){root=render({...data,plan_objections:projection});check(!text(root).includes('Открытых возражений нет.')&&text(root).includes('Отсутствие возражений не подтверждено.'),'invalid fold became clean: '+JSON.stringify(projection));}
  stage='partial healthy facts and nullable legacy flags';root=render({...data,plan_objections:{open_objections:{seat:[row,null]},withdrawn:[]}});
  check(text(root).includes(row.text)&&text(root).includes('Может удерживать решение')&&text(root).includes('прочитан не полностью'),'partial failure erased healthy objection');
  root=render({...data,plan_objections:{open_objections:[{seat_id:'legacy',id:'old',text:'Legacy <&>',revision:null,holds:null,not_adjudicated:null,legacy:null,future:{key:true}}],withdrawn:[]}});
  check(text(root).includes('Legacy <&>')&&!text(root).includes('не подтверждено.')&&!text(root).includes('Может удерживать решение'),'nullable legacy values were invented or rejected');
  root=render({...data,plan_objections:{open_objections:JSON.parse('{"__proto__":[{"id":"risk","text":"Prototype seat <&>"}]}'),withdrawn:[]}});check(text(root).includes('Prototype seat <&>')&&!text(root).includes('Открытых возражений нет.'),'seat key lost through prototype lookup');
  stage='legacy read gap qualifies empty fold';root=render({...data,plan_objections:{open_objections:{},withdrawn:[],legacy_unreadable:{source:'author_plan',error:'Fixture read unavailable'}}});
  check(text(root).includes('Прежняя запись недоступна')&&text(root).includes('В доступной части открытых возражений нет.')&&!text(root).includes('Открытых возражений нет.'),'legacy gap became a complete clean state');
  stage='withdrawn list is independently readable';root=render({...data,plan_objections:{open_objections:{},withdrawn:[{id:'ok',why:'Valid withdrawal <&>'},null]}});
  check(text(root).includes('Valid withdrawal <&>')&&text(root).includes('Часть сведений об отозванных возражениях недоступна.')&&text(root).includes('Открытых возражений нет.'),'withdrawal gap erased valid open census or healthy history');
  root=render({...data,plan_objections:{unreadable:'PlanRecordInvalid: fixture'}});check(text(root).includes('Шлюз не смог прочитать запись плана')&&!text(root).includes('Открытых возражений нет.'),'unreadable source became no objection');
  check(all(root,w=>w instanceof Gtk.Label).every(w=>!w.use_markup),'plan facts interpreted markup');
  print('OK: native plan objections from real plan writer/fold/detail, holding versus advisory, silence remains open/not adjudicated, same-seat withdrawals and confirmed empty independent of completed task; 12 malformed open rosters never claim clean, partial/legacy/nullable/future/prototype compatibility, qualified legacy gap and independent withdrawal history; no model or worker');
 })().catch(error=>{failed=true;logError(error);print('Stage: '+stage)}).finally(()=>{gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
