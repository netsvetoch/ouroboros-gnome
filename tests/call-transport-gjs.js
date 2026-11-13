import GLib from 'gi://GLib';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {CallSession}=await import(ARGV[0]+'call-session.js');
const check=(x,m)=>{if(!x)throw new Error(m)};
const wait=ms=>new Promise(r=>GLib.timeout_add(0,ms,()=>{r();return GLib.SOURCE_REMOVE}));
async function until(fn,m){for(let i=0;i<600;i++){if(await fn())return;await wait(20)}throw new Error(m)}
const gateway=new Gateway(ARGV[1],'fixture-secret'),observer=new Gateway(ARGV[1],'fixture-secret');
const facts=()=>observer.json('GET','/fixture/facts'),control=body=>observer.json('POST','/fixture/control',body);
const sessions=[];let stage='',failed=false;
function client(chatId){
 const media=[],views=[];let done=0;
 const session=new CallSession(gateway,v=>views.push(v),()=>done++,handlers=>{const m={handlers,captures:[],plays:[],flushes:0,closed:0,prepare:async()=>{},capture:x=>m.captures.push(x),play:(item,pcm)=>m.plays.push({item,pcm:[...pcm]}),flush:()=>m.flushes++,close:()=>m.closed++};media.push(m);return m});
 sessions.push(session);return {session,media,views,room:{chatId,name:'Synthetic room'},finished:()=>done};
}
try{
 stage='actual admission, initial state and server hub peer';
 const f=client(-1000000000001);await f.session.start(f.room);
 await until(()=>f.session.current.phase==='preparing','no primary hub initial state');let id=f.session.current.callId;
 let a=await facts();check(a.queued.length===1&&a.queued[0].turn_type==='LiveConversationTurn'&&a.queued[0].request.call_id===id&&a.hubs[id].peers[0].role==='owner','real admission/turn metadata/peer missing');
 check(a.admitted[0].task_metadata.host_fact.call_id===id&&a.admitted[0].chat_id===f.room.chatId,'64-bit room or host fact changed');
 stage='actual server controls and bidirectional synthetic PCM';
 await control({action:'live',call_id:id});await until(()=>f.session.current.phase==='live'&&f.session.current.activity==='Synthetic tool <&>','hub live/activity not received');
 const m=f.media[0];check(m.captures.at(-1)===true&&f.session.current.turn==='answering','live state did not capture/turn');
 m.handlers.capture(new Uint8Array([3,0,4,0,5,0,6,0]));
 await until(async()=>(await facts()).events.some(e=>e.call_id===id&&e.kind==='PeerAudio'&&e.body.role==='owner'&&e.body.pcm.join(',')==='3,0,4,0,5,0,6,0'),'actual binary mic PCM not decoded/mixed');
 await control({action:'speak',call_id:id,item:'reply-1'});await until(()=>m.plays.length>0,'primary hub audio not played');check(m.plays[0].item==='reply-1'&&m.plays[0].pcm.slice(0,4).join(',')==='1,0,2,0','caption stream/PCM association lost');
 m.handlers.played('reply-1',10);f.session.setMuted(true);m.handlers.capture(new Uint8Array([9,0]));
 check(f.session.sendContext(id,' Synthetic fact <&> ').sent&&f.session.sendParticipant(id,'Guest <&>',true).sent,'native controls not sent');
 await until(async()=>{const es=(await facts()).events.filter(e=>e.call_id===id&&e.kind==='PeerControl').map(e=>e.body.message);return es.some(x=>x.type==='played'&&x.item_id==='reply-1'&&x.played_ms===10)&&es.some(x=>x.type==='mute'&&x.muted===true)&&es.some(x=>x.type==='context'&&x.source==='gnome_owner_note'&&x.text==='Synthetic fact <&>')&&es.some(x=>x.type==='participant'&&x.label==='Guest <&>'&&x.speaking===true)},'real schema/hub controls missing');
 let count=m.plays.length;await control({action:'flush',call_id:id});await control({action:'speak',call_id:id,item:'reply-2',text:'New epoch'});await until(()=>m.plays.length>count&&m.plays.at(-1).item==='reply-2','flush/new caption audio association failed');
 await control({action:'state',call_id:id,state:'reconnecting',phase:'renewing'});await until(()=>f.session.current.phase==='reconnecting','reconnecting state lost');check(m.captures.at(-1)===false&&f.session.current.detail==='renewing','reconnecting did not stop microphone');await control({action:'state',call_id:id,state:'live'});await until(()=>f.session.current.phase==='live','reconnected live state lost');check(m.captures.at(-1)===false,'reconnection ignored mute preference');f.session.setMuted(false);check(m.captures.at(-1)===true,'unmute after reconnection did not resume capture');
 f.session.end();await f.session.close();await until(async()=>{const h=(await facts()).hubs[id];return h.owner_bye&&h.peers.length===0},'owner bye/peer leave not received');check(m.closed===1&&f.finished()===1,'native teardown duplicated/missing');await control({action:'close',call_id:id});
 stage='lost actual admission receipt rejoins same room hub';
 const lost=client(-1000000000002);await control({action:'lost'});await lost.session.start(lost.room);check(lost.session.current.phase==='failed','503 receipt treated as success');a=await facts();const lostRow=a.audit.at(-1),lostId=lostRow.reply.call_id,queued=a.queued.length;check(a.hubs[lostId].peers.length===0,'failed receipt attached unexpected peer');
 await lost.session.start(lost.room);await until(()=>lost.session.current.phase==='preparing','recovered hub not connected');a=await facts();check(lost.session.current.callId===lostId&&lost.session.current.joined===true&&a.queued.length===queued&&a.audit.at(-1).body.client_message_id===lostRow.body.client_message_id,'retry created another admitted turn or lost recovery ID');await lost.session.close();await control({action:'close',call_id:lostId});
 stage='ending held actual new admission releases only its new hub';
 const held=client(-1000000000003);let before=(await facts()).audit.length;await control({action:'hold'});const pending=held.session.start(held.room);await until(async()=>{const a=(await facts()).audit;return a.length>before&&a.at(-1).held},'admission not accepted/held');a=await facts();const heldId=a.audit.at(-1).reply.call_id;held.session.end();check(held.session.current.phase==='closing'&&held.media[0].closed===1,'pending admission microphone not closed');await control({action:'release'});await pending;await held.session.close();await until(async()=>{const h=(await facts()).hubs[heldId];return h.owner_bye&&h.peers.length===0},'new abandoned actual admission not released');a=await facts();const releasePeer=a.events.find(e=>e.call_id===heldId&&e.kind==='PeerJoined');check(releasePeer&&releasePeer.body.peer.mic===false&&releasePeer.body.peer.speaker===false,'real release peer requested media');await control({action:'close',call_id:heldId});
 stage='ending held joined admission preserves existing peer and hub';
 const owner=client(-1000000000004);await owner.session.start(owner.room);await until(()=>owner.session.current.phase==='preparing','existing owner not connected');const ownerId=owner.session.current.callId,joiner=client(owner.room.chatId);before=(await facts()).audit.length;await control({action:'hold'});const joining=joiner.session.start(joiner.room);await until(async()=>{const a=(await facts()).audit;return a.length>before&&a.at(-1).held},'joined admission not held');check((await facts()).audit.at(-1).reply.joined===true,'not real room hub reuse');joiner.session.end();await control({action:'release'});await joining;await joiner.session.close();a=await facts();check(!a.hubs[ownerId].owner_bye&&a.hubs[ownerId].peers.length===1&&owner.session.current.active,'abandoned joiner terminated existing owner');
 stage='server-initiated close reaches native client';
 await control({action:'state',call_id:ownerId,state:'closing'});await until(()=>owner.session.current.phase==='closing','closing state not received');check(owner.media[0].captures.at(-1)===false,'closing left capture enabled');
 await control({action:'close',call_id:ownerId});await until(()=>!owner.session.current.active,'server close not received');check(owner.session.current.phase==='closed'&&owner.session.current.reason==='fixture_finished'&&owner.media[0].closed===1,'server closing state lost to socket disconnect');
 stage='real bridge refusal leaves no admission';
 const refused=client(-1000000000005);a=await facts();const oldQueued=a.queued.length;await control({refuse:true});await refused.session.start(refused.room);a=await facts();check(refused.session.current.phase==='failed'&&refused.session.current.reason==='calls_unavailable'&&refused.session.current.action==='settings'&&a.queued.length===oldQueued,'definite unavailable refusal not surfaced');
 check(a.settings_unchanged&&a.sessions.length===0,'core settings changed or provider session opened');
 print('OK: native CallSession + real Gateway/Soup HTTP/WebSocket through api_call_open/_admit_owner_call/LiveConversationTurn/serve_peer/LiveCallHub, owner controls and synthetic PCM both directions, lost/held new/joined admission and server closure; inert bridge admission queue and provider catalog, no actor/provider/microphone');
}catch(e){failed=true;logError(e);print('Stage: '+stage)}finally{await control({action:'release',refuse:false}).catch(()=>{});for(const s of sessions)await s.close();gateway.close();observer.close()}
exit(failed?1:0);
