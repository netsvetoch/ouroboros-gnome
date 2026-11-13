import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {showSavedSecret}=await import(ARGV[0]+'saved-secret.js');
const {ServerSettings}=await import(ARGV[0]+'settings.js');
const {Providers}=await import(ARGV[0]+'providers.js');
const {editMcpServer}=await import(ARGV[0]+'mcp-server.js');
const check=(x,m)=>{if(!x)throw new Error(m)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,message){for(let i=0;i<700;i++){if(await fn())return;await wait(20)}throw new Error(message)}
function all(widget,predicate){let result=predicate(widget)?[widget]:[];for(let c=widget.get_first_child?.();c;c=c.get_next_sibling())result.push(...all(c,predicate));return result}
const text=root=>all(root,w=>w instanceof Gtk.Label).map(w=>w.get_text()).join('\n');
const click=(root,caption)=>{const b=all(root,w=>w instanceof Gtk.Button&&w.label===caption)[0];check(b,'missing button '+caption);b.emit('clicked')};
const input=d=>all(d.get_child(),w=>w instanceof Gtk.PasswordEntry)[0];
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.SavedSecretsTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const gateway=new Gateway(ARGV[1],'fixture-secret');const win=new Adw.ApplicationWindow({application:app,default_width:1100,default_height:900});win.present();let settings,stage='bootstrap';
 const selectedCancels=[];const json=gateway.json.bind(gateway);gateway.json=(...args)=>{if(args[1]==='/api/settings/secret')selectedCancels.push(args[5]);return json(...args)};
 const dialogs=[];const present=(d,parent)=>{dialogs.push(d);d.present(parent??win)};
 const facts=()=>gateway.json('GET','/fixture/facts');const control=body=>gateway.json('POST','/fixture/control',body);
 async function expectValue(d,value){await until(()=>input(d)?.text===value,'selected value not loaded');check(!input(d).editable&&input(d).show_peek_icon,'selected secret is not a readonly peek field');check(!text(d.get_child()).includes(value),'secret leaked into a status label');d.force_close();await until(()=>input(d).text==='','closed secret not cleared')}
 (async()=>{
  settings=new ServerSettings(win,gateway);settings.show();await until(()=>settings.snapshot&&!settings.busy,'settings not loaded');
  const snapshot=settings.snapshot;
  for(const value of ['builtin-synthetic-718','  custom-🔧-934\n','named-synthetic-641','mcp-token-synthetic-817','header-synthetic-356'])check(!JSON.stringify(snapshot).includes(value),'passive settings exposed a secret');
  stage='generic built-in and custom reveal';
  for(const [key,value] of [['OPENAI_API_KEY','builtin-synthetic-718'],['NATIVE_CUSTOM_TOKEN','  custom-🔧-934\n']]){
   settings.editSecret(key);let edit=[...settings.children].at(-1);click(edit.get_child(),'Показать сохранённое значение…');let selected=[...settings.children].at(-1);await expectValue(selected,value);edit.force_close();
  }
  check(!settings.pending.size,'selected read staged a setting');
  stage='provider builtin and named selectors';
  const providers=new Providers(gateway,present);
  for(const [original,value] of [[{kind:'openai',name:'default'},'builtin-synthetic-718'],[snapshot.OUROBOROS_CONNECTIONS[0],'named-synthetic-641']]){
   providers.edit(settings.dialog,'openai',original,snapshot,snapshot,snapshot.OUROBOROS_CONNECTIONS,()=>{throw new Error('read applied provider draft')});
   const edit=dialogs.at(-1);click(edit.get_child(),'Показать сохранённое значение · Ключ API…');await expectValue(dialogs.at(-1),value);edit.force_close();
  }
  stage='MCP legacy and named header selectors';
  const saved=snapshot.MCP_SERVERS.find(s=>s.id==='fixture');editMcpServer(settings.dialog,gateway,present,saved,saved,()=>{throw new Error('read applied MCP draft')},()=>{});
  const mcp=dialogs.at(-1);for(const expander of all(mcp.get_child(),w=>w instanceof Gtk.Expander))expander.expanded=true;
  click(mcp.get_child(),'Показать сохранённый токен…');await expectValue(dialogs.at(-1),'mcp-token-synthetic-817');
  click(mcp.get_child(),'Показать сохранённый X-Secret…');await expectValue(dialogs.at(-1),'header-synthetic-356');mcp.force_close();
  stage='selected error states and case-insensitive header';
  const empty=showSavedSecret(settings.dialog,gateway,present,{key:'ANTHROPIC_API_KEY'});await until(()=>text(empty.get_child()).includes('Секрет не задан.'),'empty saved secret not distinguished from loading');check(input(empty).text==='','empty read retained text');empty.force_close();
  await expectValue(showSavedSecret(settings.dialog,gateway,present,{mcp_server_id:'fixture',header_name:'x-secret'}),'header-synthetic-356');
  for(const [selector,code] of [[{key:'NOT_SAVED'},404],[{connection:'openai@extra',field:'base_url'},404],
    [{mcp_server_id:'duplicate'},409],[{mcp_server_id:'ambiguous',header_name:'x-key'},409],[{mcp_server_id:'malformed',header_name:'X-Key'},409]]){
   const d=showSavedSecret(settings.dialog,gateway,present,selector);await until(()=>text(d.get_child()).includes('HTTP '+code),'selected error not shown');check(input(d).text==='','error retained a secret');d.force_close();
  }
  stage='HTTP failure cannot echo secret into UI';await control({action:'hold',fail:true});let d=showSavedSecret(settings.dialog,gateway,present,{key:'OPENAI_API_KEY'});await until(async()=>(await facts()).held,'failure not held');await control({action:'release'});await until(()=>text(d.get_child()).includes('HTTP 503'),'failure not shown');check(!text(d.get_child()).includes('builtin-synthetic-718')&&input(d).text==='','error response leaked a value');d.force_close();
  stage='close cancels pending request and late response cannot repopulate';await control({action:'hold'});d=showSavedSecret(settings.dialog,gateway,present,{key:'OPENAI_API_KEY'});await until(async()=>(await facts()).held,'pending read not held');d.force_close();check(selectedCancels.at(-1)?.is_cancelled(),'closed read not cancelled');await control({action:'release'});await wait(200);check(input(d).text==='','late value populated closed dialog');
  stage='closing parent clears selected secret';d=showSavedSecret(settings.dialog,gateway,present,{key:'OPENAI_API_KEY'});await until(()=>input(d).text==='builtin-synthetic-718','parent-close value not loaded');settings.close();await until(()=>input(d).text==='','parent close retained secret');
  const f=await facts();check(f.unchanged,'read changed saved settings');const reads=f.audit.filter(r=>r.path==='/api/settings/secret');
  check(reads.length>=15&&reads.every(r=>r.no_store),'selected reads missing no-store');
  check(f.audit.every(r=>r.method==='GET'||r.path==='/api/settings/secret'),'secret read caused another write/provider request');
  const selectors=reads.map(r=>r.body);for(const selector of [{key:'OPENAI_API_KEY'},{key:'NATIVE_CUSTOM_TOKEN'},{connection:'openai@extra',field:'api_key'},{mcp_server_id:'fixture'},{mcp_server_id:'fixture',header_name:'X-Secret'}])check(selectors.some(x=>JSON.stringify(x)===JSON.stringify(selector)),'production selector not observed');
  print('OK: real selected secret API from native generic/provider/MCP forms; passive masking, builtin/custom/named/header selectors, case-insensitive header, missing/ambiguous/malformed errors, no-store, readonly peek fields, clearing on close/parent close, held late response and opaque HTTP failure; no settings writes or provider calls');
 })().catch(e=>{failed=true;logError(e);print('Stage: '+stage)}).finally(()=>{for(const d of dialogs.reverse())d.force_close();settings?.close();gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
