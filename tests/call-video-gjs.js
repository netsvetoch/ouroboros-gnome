import GLib from 'gi://GLib';
import {exit} from 'system';
const {gstreamer}=await import(ARGV[0]+'gi.js');
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {CallSession}=await import(ARGV[0]+'call-session.js');
const {CallVideo,CallVideoEncoder,canShareVideo}=await import(ARGV[0]+'call-video.js');
const check=(x,m)=>{if(!x)throw new Error(m)};
const wait=ms=>new Promise(r=>GLib.timeout_add(0,ms,()=>{r();return GLib.SOURCE_REMOVE}));
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
async function until(fn,m){for(let i=0;i<600;i++){if(await fn())return;await wait(20)}throw new Error(m)}
function decodeSize(bytes){
 const gst=gstreamer(),pipeline=gst.parse_launch('appsrc name=decode_in caps=image/jpeg format=time ! jpegdec ! appsink name=decode_out sync=false');
 try{pipeline.set_state(gst.State.PLAYING);const buffer=gst.Buffer.new_allocate(null,bytes.length,null);buffer.fill(0,bytes);pipeline.get_by_name('decode_in').push_buffer(buffer);const sample=pipeline.get_by_name('decode_out').try_pull_sample(2*gst.SECOND);check(sample,'actual JPEG decoder did not produce image');const caps=sample.get_caps().get_structure(0);return {width:caps.get_value('width'),height:caps.get_value('height')}}finally{pipeline.set_state(gst.State.NULL)}
}
const hash=b=>GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256,GLib.Bytes.new(b));
const gateway=new Gateway(ARGV[1],'fixture-secret'),observer=new Gateway(ARGV[1],'fixture-secret');
const facts=()=>observer.json('GET','/fixture/facts'),control=b=>observer.json('POST','/fixture/control',b);
let failed=false,stage='',session,wire;let diagnose=()=>({});const connect=gateway.connect.bind(gateway);gateway.connect=async(...args)=>wire=await connect(...args);const videos=[],encoders=[];
function lifecycle(){const status=[],shares=[],frames=[],pending=[],remote=[];let epoch=1,accept=true;
 const video=new CallVideo(undefined,{changed:s=>status.push(s),share:(kind,sharing)=>shares.push({kind,sharing}),epoch:()=>epoch,sendFrame:(b,e)=>{frames.push({b,e});return accept}},(kind,cancel,stopped)=>{const d=defer();pending.push({kind,cancel,stopped,...d});return d.promise},()=>{const e={closed:0,frame:()=>new Uint8Array([255,216,255]),close:()=>e.closed++};encoders.push(e);return e});videos.push(video);
 const grant=index=>{const r={fd:-1,closed:0,close:()=>r.closed++};remote.push(r);pending[index].resolve(r);return r};
 return {video,status,shares,frames,pending,remote,grant,epoch:e=>epoch=e,accept:a=>accept=a};
}
try{
 stage='portal grant after stop and obsolete system callbacks';
 let f=lifecycle(),opening=f.video.toggle('screen');check(f.status.at(-1).waiting,'no pending permission state');f.video.stop();check(f.pending[0].cancel.is_cancelled(),'portal request not cancelled');const old=f.grant(0);await opening;check(old.closed===1&&f.shares.length===0,'late portal grant leaked/announced');
 f=lifecycle();const first=f.video.toggle('screen'),second=f.video.toggle('camera');check(f.pending[0].cancel.is_cancelled(),'source replacement left prior portal active');const screen=f.grant(0),camera=f.grant(1);await first;await second;check(screen.closed===1&&camera.closed===0,'out-of-order grant displaced current camera');f.pending[0].stopped();check(f.status.at(-1).kind==='camera','obsolete portal stop ended camera');await until(()=>f.shares.some(x=>x.sharing),'first synthetic frame not announced');f.pending[1].stopped();check(camera.closed===1&&f.shares.at(-1).sharing===false,'current system stop did not release/announce');
 stage='first-frame send acceptance, duplicate suppression and new epoch';
 f=lifecycle();f.accept(false);opening=f.video.toggle('screen');f.grant(0);await opening;await until(()=>f.frames.length>0,'no attempted frame');check(!f.shares.length&&f.status.at(-1).waiting,'blocked first frame falsely announced');f.accept(true);await until(()=>f.shares.some(x=>x.sharing),'accepted first frame not announced');let count=f.frames.length;await wait(1250);check(f.frames.length===count,'identical frame resent in same epoch');f.epoch(2);await until(()=>f.frames.length===count+1,'unchanged image not resent after epoch change');f.video.stop();check(f.shares.filter(x=>x.sharing).length===1&&f.shares.at(-1).sharing===false,'duplicate share start/stop');
 stage='capture failure and missing first-frame deadline release resources';
 f=lifecycle();opening=f.video.toggle('screen');const failedRemote=f.grant(0);await opening;const failedEncoder=encoders.at(-1);failedEncoder.frame=()=>{throw new Error('Synthetic capture failure')};await until(()=>f.status.at(-1).error==='Synthetic capture failure','capture failure not surfaced');check(failedRemote.closed===1&&failedEncoder.closed===1&&f.shares.length===0,'failed first frame leaked or announced');
 f=lifecycle();opening=f.video.toggle('camera');const emptyRemote=f.grant(0);await opening;const emptyEncoder=encoders.at(-1);emptyEncoder.frame=()=>undefined;await until(()=>f.status.at(-1).error?.includes('не поступает видео'),'missing first frame did not reach capture deadline');check(emptyRemote.closed===1&&emptyEncoder.closed===1&&!f.shares.length,'missing first frame leaked or announced');
 stage='real JPEG encoder and native session through actual video hub';
 check(canShareVideo(),'required portal/GStreamer video capabilities unavailable');const portal=[],captures=[],shares=[];let video;
 session=new CallSession(gateway,()=>{},()=>{},()=>({prepare:async()=>{},capture(){},play(){},flush(){},close(){}}),handlers=>{
  const originalShare=handlers.share;handlers.share=(kind,sharing)=>{shares.push({kind,sharing});originalShare(kind,sharing)};
  video=new CallVideo(undefined,handlers,async(kind,cancel,stopped)=>{const r={kind,cancel,stopped,fd:-1,closed:0,close:()=>r.closed++};portal.push(r);return r},(kind,remote)=>{
   const actual=new CallVideoEncoder(kind,remote,'videotestsrc name=video_capture is-live=true pattern=2 ! video/x-raw,width=1920,height=1080,framerate=10/1');
   const record={kind,closed:0,frames:[]};captures.push(record);const e={frame:()=>{const b=actual.frame();if(b){const size=record.frames[0]??decodeSize(b);check(size.width<=(kind==='camera'?768:1280)&&size.height<=(kind==='camera'?768:1280)&&b.length<=512*1024,'JPEG exceeds protocol/native bounds');record.frames.push({sha256:hash(b),size:b.length,width:size.width,height:size.height})}return b},close:()=>{record.closed++;actual.close()}};encoders.push(e);return e;
  });videos.push(video);return video;
 });
 diagnose=()=>{const output=wire?.get_io_stream()?.get_output_stream();return {view:session.current,encoded:captures.map(x=>({kind:x.kind,closed:x.closed,frames:x.frames.length,first:x.frames[0]})),shares,output:output?.constructor.name,canPoll:output?.can_poll?.(),writable:output?.is_writable?.()}};
 const room={chatId:-1000000000020,name:'Synthetic video room'};await session.start(room);await until(()=>session.current.phase==='preparing','video session not joined');check(session.current.videoAvailable,'video factory not admitted');const id=session.current.callId;
 check((await facts()).hubs[id].peers[0].video===true,'owner hello omitted video permission');await control({action:'live',call_id:id});await until(()=>session.current.phase==='live','no live state');session.toggleVideo('screen');
 await until(async()=>(await facts()).events.some(e=>e.call_id===id&&e.kind==='PeerVideo'),'JPEG not accepted by real video parser/hub');let a=await facts(),frame=a.events.find(e=>e.call_id===id&&e.kind==='PeerVideo');check(frame.body.role==='owner'&&frame.body.mime==='image/jpeg'&&frame.body.head.join(',')==='255,216,255'&&captures[0].frames.some(x=>x.sha256===frame.body.sha256&&x.size===frame.body.size),'hub frame differs from encoded JPEG');
 await until(async()=>(await facts()).events.some(e=>e.call_id===id&&e.kind==='PeerControl'&&e.body.message.type==='share'&&e.body.message.sharing===true&&e.body.message.kind==='screen'),'real share control missing');
 count=(await facts()).events.filter(e=>e.kind==='PeerVideo').length;await wait(1350);check((await facts()).events.filter(e=>e.kind==='PeerVideo').length===count,'real static JPEG duplicate not suppressed');await control({action:'flush',call_id:id});await until(async()=>(await facts()).events.filter(e=>e.kind==='PeerVideo').length===count+1,'static JPEG not resent after real flush');
 session.toggleVideo('camera');await until(()=>session.current.video?.announced&&session.current.video.kind==='camera','camera switch not announced');check(portal[0].closed===1&&captures[0].closed===1,'screen pipeline/remote not closed on camera switch');
 await until(async()=>{const es=(await facts()).events.filter(e=>e.call_id===id&&e.kind==='PeerControl').map(e=>e.body.message);return es.some(x=>x.type==='share'&&x.kind==='screen'&&!x.sharing)&&es.some(x=>x.type==='share'&&x.kind==='camera'&&x.sharing)},'screen stop/camera start not accepted');
 const prior=portal.length;session.setDevices({...session.devices,camera:'missing-fixture-camera'});await until(()=>portal.length===prior+1&&session.current.video?.announced,'camera preference switch not restarted');check(session.current.video.notice?.includes('Выбранная камера недоступна')&&captures.at(-2).closed===1,'missing preferred camera fallback absent');
 stage='server close stops encoder and portal capture';await control({action:'close',call_id:id});await until(()=>!session.current.active,'closed hub left video active');check(portal.every(x=>x.closed===1)&&captures.every(x=>x.closed===1)&&shares.at(-1).sharing===false,'video capture leaked after call close');a=await facts();check(a.settings_unchanged&&a.sessions.length===0,'core settings changed/provider started');
 print('OK: native video portal lifecycle with injected grants, stale grant/system stop, first-frame share and dedup/epoch; actual GStreamer videotestsrc/decodebin/scale/jpegenc/appsink and JPEG decode/bounds, CallSession/Gateway/Soup -> primary serve_peer/LiveCallHub video and share controls, source/camera preference switch and closed-call teardown; no real portal/PipeWire/device/provider');
}catch(e){failed=true;logError(e);print('Stage: '+stage);print(JSON.stringify(diagnose()))}finally{for(const v of videos)v.stop();await session?.close();gateway.close();observer.close()}
exit(failed?1:0);
