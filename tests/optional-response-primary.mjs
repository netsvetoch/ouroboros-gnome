import {pathToFileURL} from 'node:url';
import {writeFile} from 'node:fs/promises';
const [reference,remote,run]=process.argv.slice(2);
const {fetchJson}=await import(pathToFileURL(reference+'/web/modules/api_client.js'));
const check=(value,message)=>{if(!value)throw new Error(message)};
const cases=[['mime',200,'mime'],['cut',200,'cut'],['corrupt',200,'chunk'],['corrupt-refused',400,'chunk'],['corrupt-failed',503,'chunk'],['refused',400,'cut'],['failed',503,'cut'],['before',200,'before'],['cancel',200,'hold']];
const proof=[];
for(const [name,status,mode] of cases){
 const id='primary-'+name,controller=new AbortController();let observed=0;
 const options={method:'POST',headers:{Authorization:'Bearer fixture-secret','Content-Type':'application/json'},body:'{}',signal:controller.signal};
 let value,error;
 try{value=await fetchJson(remote+`/reply/${status}/${mode}?id=${id}`,options,{fetchImpl:async(url,init)=>{
  const response=await fetch(url,init);observed=response.status;
  if(name==='cancel')controller.abort();
  return response;
 }})}catch(e){error=e}
 if(name==='cancel')await fetch(remote+'/release?id='+id);
 const row={name,mode,status:observed,ok:!error,errorStatus:error?.status??null,errorName:error?.name??null};
 check(name==='mime'?value?.notice==='Receipt Ω':(name==='cut'||name==='corrupt')?!error:name==='cancel'?error?.name==='AbortError':!!error,'unexpected primary outcome '+JSON.stringify(row));
 if(status>=400)check(error.status===status,'primary lost final HTTP status');
 if(name==='before')check(observed===0,'before-header failure exposed a final status');
 proof.push(row);
}
await writeFile(run+'/primary.json',JSON.stringify(proof));
console.log('OK: actual pinned fetchJson over raw HTTP preserves 2xx optional-body acknowledgement, MIME-independent JSON, final refusal status, caller AbortError and before-header failure');
