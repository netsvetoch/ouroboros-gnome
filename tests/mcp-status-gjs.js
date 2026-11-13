import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {McpSettings}=await import(ARGV[0]+'mcp.js');
const check=(x,m)=>{if(!x)throw new Error(m)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,m){for(let i=0;i<1200;i++){if(await fn())return;await wait(20)}throw new Error(m)}
function all(w,p){let out=p(w)?[w]:[];for(let c=w.get_first_child?.();c;c=c.get_next_sibling())out.push(...all(c,p));return out}
const texts=w=>all(w,x=>x instanceof Gtk.Label).map(x=>x.get_text()).join('\n');
const button=(w,s)=>all(w,x=>x instanceof Gtk.Button&&x.label===s)[0];
const click=(w,s)=>{const b=button(w,s);check(b?.is_sensitive(),'button unavailable '+s);b.emit('clicked')};
async function expand(w){for(let pass=0;pass<2;pass++){for(const e of all(w,x=>x instanceof Gtk.Expander))e.expanded=true;await wait(30)}}
const metadata=w=>all(w,x=>x instanceof Gtk.TextView&&x.get_name()==='mcp-tool-metadata');
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.McpStatusTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const gateway=new Gateway(ARGV[1],'fixture-secret');const win=new Adw.ApplicationWindow({application:app,default_width:1100,default_height:950});win.present();const dialogs=[],active=new Set();let settings,stage='passive status before listing',applied=0;
 const present=(d,p)=>{dialogs.push(d);active.add(d);d.connect('closed',()=>active.delete(d));d.present(p??win)};
 const facts=()=>gateway.json('GET','/fixture/facts'),control=b=>gateway.json('POST','/fixture/control',b);
 (async()=>{
  const saved=await gateway.json('GET','/api/settings');settings=new McpSettings(gateway,present);settings.show(saved,saved,()=>{applied++});const d=dialogs.at(-1);await until(()=>settings.snapshot?.servers?.length===1,'initial status not ready');check(settings.snapshot.servers[0].tool_count===0&&(await facts()).wire.length===0,'passive status initiated listing');
  stage='real refresh publishes saved catalog';click(d.get_child(),'Обновить инструменты всех серверов');await until(()=>!settings.refreshing&&settings.snapshot.servers[0].tool_count===75,'native refresh did not publish 75 tools');await expand(settings.status);
  let f=await facts();check(Object.values(f.catalogs).length===1&&Object.values(f.catalogs)[0].complete&&Object.values(f.catalogs)[0].items.length===75,'complete catalog not durably published');check(settings.snapshot.servers[0].latest_attempt.ok&&metadata(settings.status).length===75,'saved metadata not displayed');
  const parsed=metadata(settings.status).map(v=>{const b=v.buffer;return JSON.parse(b.get_text(b.get_start_iter(),b.get_end_iter(),false))});check(parsed.some(x=>x.title==='Metadata seven 74'&&x.outputSchema.properties.language.const==='en'),'stored literal metadata lost');check(texts(settings.status).includes('Адрес сервера · http://127.0.0.1:')&&texts(settings.status).includes('Заголовок токена · X-Legacy')&&texts(settings.status).includes('Server instructions seven <&> 🔧')&&texts(settings.status).includes('fixture_074'),'stored instructions/last tool missing');
  const count=f.wire.length;await settings.readStatus();await settings.readStatus();check((await facts()).wire.length===count,'passive status refreshed the MCP server');
  stage='failed listing retains complete catalog';await control({action:'mode',mode:'fail'});click(settings.status,'Обновить инструменты');await until(()=>!settings.refreshing&&settings.snapshot.servers[0].latest_attempt?.ok===false,'failed listing not recorded');await expand(settings.status);f=await facts();const retained=Object.values(f.catalogs)[0];check(retained.complete&&retained.items.length===75&&retained.latest_attempt.ok===false,'failed listing erased durable tools');check(settings.snapshot.servers[0].tool_count===75&&metadata(settings.status).length===75&&texts(settings.status).includes('ошибка'),'native status lost last-known tools or hid failed attempt');
  stage='HTTP status failure preserves snapshot';const snapshot=JSON.stringify(settings.snapshot);await control({action:'status-fail'});await settings.readStatus();check(settings.statusError.label.includes('HTTP 503')&&JSON.stringify(settings.snapshot)===snapshot&&metadata(settings.status).length===75,'HTTP failure erased confirmed status');
  stage='malformed status preserves snapshot';await control({action:'malformed'});await settings.readStatus();check(settings.statusError.label.includes('пригодное состояние MCP')&&JSON.stringify(settings.snapshot)===snapshot&&metadata(settings.status).length===75,'malformed status erased confirmed tools');await settings.readStatus();check(!settings.statusError.label,'valid status did not clear read failure');
  stage='successful empty listing replaces retained tools';await control({action:'mode',mode:'empty'});click(settings.status,'Обновить инструменты');await until(()=>!settings.refreshing&&settings.snapshot.servers[0].latest_attempt?.ok&&settings.snapshot.servers[0].tool_count===0,'successful empty listing not accepted');await expand(settings.status);f=await facts();check(Object.values(f.catalogs)[0].complete&&Object.values(f.catalogs)[0].items.length===0&&metadata(settings.status).length===0,'successful empty listing retained stale metadata');
  check(f.settings_unchanged&&applied===0&&f.audit.every(r=>r.method==='GET'||r.path==='/api/mcp/refresh')&&!f.wire.some(r=>r.rpc==='tools/call'),'refresh wrote Settings/applied draft/executed tools');
  print('OK: real MCP status/refresh and durable catalog through native settings; two-page 75-tool listing with saved metadata/instructions, passive reads without server I/O, failed listing retains last-known tools, HTTP/malformed status retains snapshot, successful empty listing clears tools; no Settings writes or tools/call');
 })().catch(e=>{failed=true;logError(e);print('Stage: '+stage);if(settings)print(texts(settings.status)+'\n'+settings.statusError.label+'\n'+settings.observation.label)}).finally(()=>{for(const d of [...active].reverse())d.force_close();gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
