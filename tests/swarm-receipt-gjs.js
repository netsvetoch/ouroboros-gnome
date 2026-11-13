import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {TasksPage}=await import(ARGV[0]+'tasks.js');
const {renderSwarmReceipt}=await import(ARGV[0]+'swarm-receipt.js');
const check=(v,m)=>{if(!v)throw new Error(m)};
const wait=ms=>new Promise(r=>GLib.timeout_add(0,ms,()=>{r();return GLib.SOURCE_REMOVE}));
async function until(fn,m){for(let i=0;i<600;i++){if(fn())return;await wait(20)}throw new Error(m)}
function all(w,p,seen=new Set()){if(!w||seen.has(w))return [];seen.add(w);const out=p(w)?[w]:[];for(let c=w.get_first_child?.();c;c=c.get_next_sibling())out.push(...all(c,p,seen));if(w instanceof Gtk.Expander)out.push(...all(w.get_child(),p,seen));return out}
const texts=w=>all(w,x=>x instanceof Gtk.Label).map(x=>x.label).join('\n');
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.SwarmReceiptTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{const win=new Adw.ApplicationWindow({application:app,default_width:1000,default_height:900}),gateway=new Gateway(ARGV[1],'fixture-secret');win.present();let tasks,stage='actual receipt fold';
 (async()=>{
  const [,bytes]=Gio.File.new_for_path(ARGV[2]+'/swarm-cases.json').load_contents(null),cases=JSON.parse(new TextDecoder().decode(bytes));
  await gateway.json('POST','/fixture/retention',{task_id:'swarm-audit',promotion:{status:'complete',pending_count:0,problem_count:0,promoted_ref_count:0,promoted_source_handle_count:0}});
  tasks=new TasksPage(win,gateway,()=>({name:'Main',chatId:1}),()=>{});win.set_content(tasks.widget);
  let detail;
  for(const item of cases){stage=item.name;
   await gateway.json('POST','/fixture/receipt',{rules:[{task_id:'swarm-audit',action:'detail',patch:item.detail}]});
   if(!detail){tasks.show('swarm-audit');detail=tasks.openDetails.get('swarm-audit');await until(()=>detail.task?.swarm_receipt?.revision===7,'task detail not loaded')}else await detail.refresh();
   const panel=all(detail.summary,w=>w instanceof Gtk.Expander&&w.label==='Отчёт о работе роя')[0];check(panel,'native report absent '+stage);panel.expanded=true;const shown=texts(panel);
   check(shown.includes('Запрошено субагентов · 3'),'request lost '+stage);
   check(all(panel,w=>w instanceof Gtk.Label).every(w=>!w.use_markup),'report parsed markup');
   check(!shown.includes('[object Object]')&&!shown.includes('function Object'),'object coerced to text');
   if(stage==='known')for(const expected of ['Ревизия отчёта · 7','Подтверждённый причинный путь, с · 12','Подтверждённая известная часть · 0,125 USD','Полная стоимость · 0,125 USD','Model <&> Ω','profile <&>','Literal comparison <&> Ω','observed_intervals_not_productivity','32000'])check(shown.includes(expected),'known receipt fact absent '+expected);
   if(stage==='partial'){for(const expected of ['Ожидают подтверждения · 1','Отклонено запусков · 1','No route <&>','wait Ω','missing_usage','Полная стоимость · неизвестно','Сеансы подписки · 1','Полная длительность причинного пути неизвестна.'])check(shown.includes(expected),'partial receipt lost uncertainty/fact '+expected);check(!shown.includes('Подтверждённый причинный путь, с'),'partial path promoted to complete')}
   if(stage==='parallel')check(shown.includes('Подтверждённая известная часть · 0 USD')&&shown.includes('Полная стоимость · неизвестно')&&shown.includes('Пересечение интервалов, с · 5')&&shown.includes('Полная длительность причинного пути неизвестна.'),'parallel overlap inferred causal path');
   if(stage==='malformed')check(shown.includes('Часть сведений отчёта прочитать не удалось.')&&!shown.includes('999'),'bad receipt crashed/invented path');
   if(stage==='foreign')check(shown.includes('Принадлежность и структура отчёта не подтверждены.')&&!shown.includes('Model <&>'),'foreign root exposed measurements');
   if(stage==='known'){check(shown.includes('Записано запусков с подтверждённым началом · 1'),'requested count became started count');const coverage=all(panel,w=>w instanceof Gtk.Expander&&w.label==='Покрытие измерений')[0];coverage.expanded=true;await gateway.json('POST','/fixture/receipt',{rules:[{task_id:'swarm-audit',action:'detail',patch:item.detail}]});await detail.refresh();const fresh=all(detail.summary,w=>w instanceof Gtk.Expander&&w.label==='Отчёт о работе роя')[0];check(fresh.expanded&&all(fresh,w=>w instanceof Gtk.Expander&&w.label==='Покрытие измерений')[0].expanded,'refresh collapsed receipt sections');await gateway.json('POST','/fixture/receipt',{rules:[{task_id:'swarm-audit',action:'detail',status:503,body:{error:'Fixture receipt read unavailable'}}]});await detail.refresh();check(texts(fresh).includes('Literal comparison <&> Ω'),'failed read erased receipt')}
   if(stage==='absent')check(shown.includes('пока не вернул')&&!shown.includes('0 USD'),'absent receipt fabricated money');
  }
  stage='root scope';for(const patch of [{parent_task_id:'parent'},{metadata:{subagents_mode:'swarm',parent_task_id:'parent'}},{metadata:{subagents_mode:'off'}}])check(!renderSwarmReceipt({...cases[0].detail,...patch},'swarm-audit'),'child/non-swarm got root measurements');
  const facts=await gateway.json('GET','/fixture/facts');check(facts.calls.length===0,'receipt view created control actions');
  print('OK: actual pinned fold_tree receipts through real task HTTP detail and native TasksPage; coverage, intervals/waits/edges, causal uncertainty vs overlap, cost scope/unknown/zero, account/context facts and authored comparison, requested vs recorded starts, refusal/pending/session dedupe, malformed/foreign/absent receipts and root-only scope; no worker/model/control writes');
 })().catch(e=>{failed=true;logError(e);print('Stage '+stage)}).finally(()=>{tasks?.close();gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
