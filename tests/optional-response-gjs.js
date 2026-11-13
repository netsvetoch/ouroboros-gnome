import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {exit} from 'system';
const {Gateway,HttpError}=await import(ARGV[0]+'gateway.js');
const check=(value,message)=>{if(!value)throw new Error(message)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,message){for(let i=0;i<500;i++){if(await fn())return;await wait(10)}throw new Error(message)}
const app=new Gio.Application({application_id:'io.github.ouroboros.Client.OptionalResponseTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{app.hold();const gateway=new Gateway(ARGV[1],'fixture-secret'),observer=new Gateway(ARGV[1],'fixture-secret'),connections=[gateway,observer];let stage='primary parity';
 const facts=()=>observer.json('GET','/facts');
 const url=(status,mode,id)=>`/reply/${status}/${mode}?id=${id}`;
 async function outcome(read){try{return {ok:true,value:await read()}}catch(error){return {ok:false,error}}}
 (async()=>{
  const [,bytes]=Gio.File.new_for_path(ARGV[2]+'/primary.json').load_contents(null),primary=JSON.parse(new TextDecoder().decode(bytes));
  for(const expected of primary.filter(row=>row.name!=='cancel')){
   stage='native '+expected.name;const id='native-'+expected.name,status=expected.status||200,mode=expected.mode;
   const result=await outcome(()=>gateway.optionalJson('POST',url(status,mode,id),{}));
   check(result.ok===expected.ok,'optional response differs from primary '+expected.name+': '+result.error);
   if(expected.name==='mime')check(result.value?.notice==='Receipt Ω','valid JSON metadata lost by MIME');
   if(expected.errorStatus)check(result.error instanceof HttpError&&result.error.status===expected.errorStatus,'unreadable body lost final HTTP status '+result.error);
   check((await facts()).filter(row=>row.id===id).length===1,'transport retried POST '+expected.name);
  }
  stage='strict JSON still requires readable body';const strict=await outcome(()=>gateway.json('POST',url(200,'cut','native-strict'),{}));check(!strict.ok,'strict JSON accepted incomplete body');
  for(const mode of ['caller','connection']){
   stage='cancel after final headers '+mode;const connection=new Gateway(ARGV[1],'fixture-secret');connections.push(connection);const cancel=new Gio.Cancellable(),id='native-'+mode;
   let settled=false,peerSettled=false;const pending=outcome(()=>connection.optionalJson('POST',url(200,'hold',id),{},cancel)).then(value=>{settled=true;return value});await until(async()=>(await facts()).some(row=>row.id===id&&row.headers),'held response headers absent');
   let peer,peerPending;const peerId=id+'-peer';
   if(mode==='connection'){peer=new Gateway(ARGV[1],'fixture-secret');connections.push(peer);peerPending=outcome(()=>peer.optionalJson('POST',url(200,'hold',peerId),{},cancel)).then(value=>{peerSettled=true;return value});await until(async()=>(await facts()).some(row=>row.id===peerId&&row.headers),'shared caller peer did not start')}
   if(mode==='caller')cancel.cancel();else connection.close();
   for(let i=0;i<100&&!settled;i++)await wait(10);const prompt=settled;
   if(!prompt)await observer.json('GET','/release?id='+id);
   const result=await pending;
   if(peer){check(!peerSettled&&!cancel.is_cancelled(),'closing connection cancelled shared caller or peer');await observer.json('GET','/release?id='+peerId);check((await peerPending).value?.notice==='Receipt Ω','shared caller peer did not complete');peer.close()}
   check(prompt,'owner/caller cancellation waited for the remote body '+mode);check(!result.ok,'cancellation after 2xx became acknowledgement '+mode);
   await observer.json('GET','/release?id='+id);connection.close();
  }
  stage='closed connection cannot dispatch with a fresh caller';const closed=connections.at(-1),fresh=new Gio.Cancellable();const retired=await outcome(()=>closed.optionalJson('POST',url(200,'mime','native-closed-unsent'),{},fresh));check(!retired.ok&&!(await facts()).some(row=>row.id==='native-closed-unsent'),'closed Gateway sent with fresh caller');
  stage='cancellation before request';const cancel=new Gio.Cancellable();cancel.cancel();const before=await outcome(()=>gateway.optionalJson('POST',url(200,'mime','native-unsent'),{},cancel));check(!before.ok&&!(await facts()).some(row=>row.id==='native-unsent'),'already-cancelled request sent or acknowledged');
  await until(async()=>(await facts()).every(row=>row.closed),'fixture retained an open response');check((await facts()).every(row=>row.authenticated),'native or primary request lost authorization');
  print('OK: native Gateway optional acknowledgements match actual pinned fetchJson across raw truncated/complete responses and final 200/400/503 status, no POST replay; strict JSON rejects incomplete body, explicit caller cancellation and Gateway close after headers remain errors, cancelled-before-send stays unsent; no GTK/model/owner settings changes');
 })().catch(error=>{failed=true;logError(error);print('Stage: '+stage)}).finally(()=>{for(const connection of connections)connection.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
