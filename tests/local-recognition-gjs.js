import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';
const [root,run,executable,model]=ARGV;
const {LocalRecognition,recognitionWavDuration}=await import(root+'local-recognition.js');
const check=(ok,message)=>{if(!ok)throw Error(message)};
const wav=pcm=>{
 const bytes=new Uint8Array(44+pcm.length),v=new DataView(bytes.buffer);
 bytes.set(new TextEncoder().encode('RIFF'),0);bytes.set(new TextEncoder().encode('WAVEfmt '),8);bytes.set(new TextEncoder().encode('data'),36);
 for(const [at,n] of [[4,bytes.length-8],[16,16],[24,16000],[28,32000],[40,pcm.length]])v.setUint32(at,n,true);
 for(const [at,n] of [[20,1],[22,1],[32,2],[34,16]])v.setUint16(at,n,true);
 bytes.set(pcm,44);return bytes;
};
const bad=async(promise,code)=>{try{await promise}catch(e){check(e.code===code,`wanted ${code}, got ${e.code}: ${e}`);return}throw Error('unexpected success: '+code)};
const reaped=process=>new Promise((resolve,reject)=>process.wait_async(null,(_s,result)=>{try{process.wait_finish(result);resolve()}catch(e){reject(e)}}));
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn){for(let i=0;i<400;i++){if(fn())return;await wait(5)}throw Error('decoder phase did not start')}
const vad=GLib.build_filenamev([GLib.path_get_dirname(executable),'ouroboros-vad']);
const launched=[],spawn=Gio.Subprocess.new;
Gio.Subprocess.new=function(argv,flags){launched.push(argv[0]);return spawn.call(this,argv,flags)};
let failed=false;
await (async()=>{
 const [,pcm]=GLib.file_get_contents(run+'/goforward.raw'),audio=wav(pcm);
 const decoder=new LocalRecognition(executable,model);
 check(decoder.available,'actual CLI/model missing');
 const rawGate=bytes=>new Promise((resolve,reject)=>{
  const flags=Gio.SubprocessFlags,p=Gio.Subprocess.new([vad],flags.STDIN_PIPE|flags.STDOUT_PIPE|flags.STDERR_SILENCE);
  p.communicate_async(GLib.Bytes.new(bytes),null,async(_s,r)=>{
   try{const [,out]=p.communicate_finish(r);resolve({ok:p.get_successful(),text:new TextDecoder().decode(out.get_data())})}
   catch(e){try{await reaped(p);resolve({ok:false,text:''})}catch(error){reject(error)}}
  });
 });
 for(const bytes of [new Uint8Array(),new Uint8Array([1]),new Uint8Array(1_920_002)])check(!(await rawGate(bytes)).ok,'native VAD accepted empty/odd/oversize PCM');
 const limit=await rawGate(new Uint8Array(1_920_000));check(limit.ok&&JSON.parse(limit.text).samples===960000&&!JSON.parse(limit.text).speech,'native VAD max input rejected');
 const tail=await rawGate(new Uint8Array([17,0]));check(tail.ok&&JSON.parse(tail.text).samples===1&&!JSON.parse(tail.text).speech,'native VAD final partial frame invalid');
 check(!new LocalRecognition('/no/such/engine',model).available,'missing engine available');
 check(!new LocalRecognition(executable,run).available,'missing model available');
 check(!new LocalRecognition(executable,model,'/no/such/vad').available,'missing VAD available');
 check(!new LocalRecognition(run,model,vad).available,'directory engine available');
 await bad(new LocalRecognition('/no/such/engine',model).transcribe(audio),'unavailable');
 await bad(decoder.transcribe(audio,'ru-RU'),'language');
 check(!decoder.active,'unsupported language launched child');
 const malformed=[];
 malformed.push(audio.subarray(0,43),audio.subarray(0,audio.length-1));
 for(const [at,n,bits] of [[4,8,32],[20,3,16],[22,2,16],[24,48000,32],[28,1,32],[32,4,16],[34,8,16],[40,1,32]]){
  const x=audio.slice(),v=new DataView(x.buffer);bits===16?v.setUint16(at,n,true):v.setUint32(at,n,true);malformed.push(x);
 }
 malformed.push(wav(new Uint8Array(1_920_002)),wav(new Uint8Array()));
 for(const bytes of malformed){await bad(decoder.transcribe(bytes),'audio');check(!decoder.active,'malformed WAV launched child')}
 check(Math.abs(recognitionWavDuration(audio)-pcm.length/32000)<1e-9,'WAV duration');
 const result=await decoder.transcribe(audio,'EN-us');
 check(result.text==='go forward ten meters','real recognition: '+JSON.stringify(result));
 check(result.language==='en-US'&&result.probability>=0&&result.probability<=1,'result metadata');
 // Odd ancillary chunks before and after audio must never be passed as PCM.
 const extra=new Uint8Array(audio.length+20);extra.set(audio.subarray(0,36));
 extra.set(new TextEncoder().encode('JUNK'),36);new DataView(extra.buffer).setUint32(40,1,true);extra[44]=42;
 extra.set(audio.subarray(36),46);extra.set(new TextEncoder().encode('LIST'),audio.length+10);new DataView(extra.buffer).setUint32(audio.length+14,1,true);extra[audio.length+18]=99;
 new DataView(extra.buffer).setUint32(4,extra.length-8,true);
 check((await decoder.transcribe(extra)).text===result.text,'ancillary chunk normalization changed speech');
 const silent=await decoder.transcribe(wav(new Uint8Array(32000)));
 check(silent.text===''&&silent.probability===null&&!decoder.active,'digital silence invented words');
 for(const amplitude of [0,32,500]){
  const noise=new Uint8Array(32000),view=new DataView(noise.buffer);let seed=703;
  for(let i=0;i<16000;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;view.setInt16(i*2,amplitude?seed%(2*amplitude+1)-amplitude:128,true)}
  const before=launched.length,quiet=await decoder.transcribe(wav(noise));
  check(quiet.text===''&&quiet.probability===null,'VAD invented speech on DC/noise '+amplitude);
  check(JSON.stringify(launched.slice(before))===JSON.stringify([vad]),'non-speech reached acoustic decoder');
 }
 const cancelled=new Gio.Cancellable();cancelled.cancel();await bad(decoder.transcribe(audio,'en',cancelled),'cancelled');check(!decoder.active,'pre-cancelled child');
 const caller=new Gio.Cancellable(),pending=decoder.transcribe(audio,'en',caller);
 await bad(decoder.transcribe(audio),'busy');
 await until(()=>decoder.active?.phase==='decode');const child=decoder.active.process;
 const peer=new LocalRecognition(executable,model),independent=peer.transcribe(audio);
 caller.cancel();await bad(pending,'cancelled');await reaped(child);
 check(!child.get_successful(),'cancelled decoder completed successfully');
 check((await independent).text===result.text,'one cancellation affected peer');
 const reusable=await decoder.transcribe(audio);check(reusable.text===result.text,'caller cancellation poisoned decoder');
 const closing=decoder.transcribe(audio),closingChild=decoder.active.process;check(decoder.active.phase==='vad','close did not cover VAD phase');decoder.close();decoder.close();
 await bad(closing,'cancelled');await reaped(closingChild);await bad(decoder.transcribe(audio),'cancelled');
 check(!closingChild.get_successful()&&!decoder.active,'close left a child active');
 for(const [name,body] of [['invalid','printf "not-json"'],['failed','exit 3'],['foreign','printf \'{"t":"x","b":0,"d":999,"p":1}\'']]){
  const path=run+'/'+name;GLib.file_set_contents(path,'#!/bin/sh\n'+body+'\n');Gio.File.new_for_path(path).set_attribute_uint32('unix::mode',0o700,Gio.FileQueryInfoFlags.NONE,null);
  const broken=new LocalRecognition(path,model,vad);await bad(broken.transcribe(audio),'engine');check(!broken.active,'failed child retained');broken.close();
 }
 for(const [name,body] of [['vad-invalid','printf "not-json"'],['vad-failed','exit 3'],['vad-count','printf \'{"samples":1,"voiced_samples":1,"longest_samples":1,"speech":false}\'']]){
  const path=run+'/'+name;GLib.file_set_contents(path,'#!/bin/sh\n'+body+'\n');Gio.File.new_for_path(path).set_attribute_uint32('unix::mode',0o700,Gio.FileQueryInfoFlags.NONE,null);
  const before=launched.length,broken=new LocalRecognition(executable,model,path);await bad(broken.transcribe(audio),'engine');
  check(!broken.active&&launched.slice(before).every(p=>p!==executable),'failed VAD dispatched decoder');broken.close();
 }
 peer.close();
 print('OK: actual PocketSphinx/WebRTC VAD passes original human goforward WAV to real English model -> go forward ten meters; DC and deterministic low/moderate noise stop before acoustic decoder; ancillary normalization, bounded PCM, explicit language/model/VAD availability, digital silence, cancellation in decode and close in VAD/child reaping, reuse/busy/peer isolation, malformed/nonzero VAD and decoder errors; no network, physical microphone, broad noise-quality or browser SpeechRecognition claim');
})().catch(e=>{failed=true;logError(e)}).finally(()=>{Gio.Subprocess.new=spawn});
System.exit(failed?1:0);
