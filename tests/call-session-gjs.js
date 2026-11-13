import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import {exit} from 'system';
const {CallSession}=await import(ARGV[0]+'call-session.js');
const {callAudioPacket,readCallAudio}=await import(ARGV[0]+'call-wire.js');
const check=(x,m)=>{if(!x)throw new Error(m)};
const wait=ms=>new Promise(r=>GLib.timeout_add(0,ms,()=>{r();return GLib.SOURCE_REMOVE}));
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
class Socket {
 signals=new Map();next=1;state=Soup.WebsocketState.OPEN;text=[];binary=[];
 connect(name,fn){const id=this.next++;this.signals.set(id,{name,fn});return id}
 disconnect(id){this.signals.delete(id)}
 emit(name,...args){for(const {name:n,fn} of [...this.signals.values()])if(n===name)fn(this,...args)}
 get_state(){return this.state}get_close_data(){return ''}
 set_max_incoming_payload_size(){}set_keepalive_interval(){}set_keepalive_pong_timeout(){}
 send_text(s){this.text.push(JSON.parse(s))}send_binary(b){this.binary.push(b)}
 close(){if(this.state!==Soup.WebsocketState.OPEN)return;this.state=Soup.WebsocketState.CLOSED;GLib.idle_add(0,()=>{this.emit('closed');return GLib.SOURCE_REMOVE})}
 message(value){const data=new TextEncoder().encode(JSON.stringify(value));this.emit('message',Soup.WebsocketDataType.TEXT,{get_data:()=>data})}
 audio(epoch,sequence,stream=1){const b=callAudioPacket(new Uint8Array([1,0,2,0]),epoch,sequence);b[3]=2;new DataView(b.buffer).setUint16(14,stream,true);this.emit('message',Soup.WebsocketDataType.BINARY,{get_data:()=>b})}
}
function fixture(){
 const sockets=[],posts=[],media=[],views=[];let reply={call_id:'test-call',ws_path:'/ws/call/test-call',vision:false},gate;
 const gateway={json:async(method,path,body)=>{posts.push({method,path,body});return gate?await gate.promise:reply},connect:async path=>{const s=new Socket();s.path=path;sockets.push(s);return s}};
 const session=new CallSession(gateway,v=>views.push(v),()=>{},handlers=>{const m={handlers,captures:[],plays:[],flushes:0,closed:0,prepare:async()=>{},capture:x=>m.captures.push(x),play:(item,pcm)=>m.plays.push({item,pcm}),flush:()=>m.flushes++,close:()=>m.closed++};media.push(m);return m});
 return {session,sockets,posts,media,views,reply:v=>reply=v,hold:()=>gate=defer()};
}
const room={chatId:-1000000000001,name:'Synthetic call'};
let stage='';let failed=false;const sessions=[];
const fresh=()=>{const f=fixture();sessions.push(f.session);return f};
try{
 stage='admission type and uncertain receipt recovery';
 for(const joined of ['true',0,null,{}]){
  const f=fresh();f.reply({call_id:'test-call',ws_path:'/ws/call/test-call',vision:false,joined});await f.session.start(room);
  check(f.session.current.phase==='failed'&&f.sockets.length===0&&f.media[0].closed===1,'malformed ownership accepted/released');
  f.reply({call_id:'test-call',ws_path:'/ws/call/test-call',vision:false,joined:true});await f.session.start(room);
  check(f.posts.length===2&&f.posts[0].body.client_message_id===f.posts[1].body.client_message_id,'unknown admission did not retain recovery ID');
  check(f.session.current.joined===true,'valid joined receipt lost');await f.session.close();
 }
 stage='ending pending admission distinguishes new and joined calls';
 for(const joined of [false,true]){
  const f=fresh(),gate=f.hold(),started=f.session.start(room);await wait(5);check(f.posts.length===1,'POST not pending');f.session.end();f.session.end();
  check(f.session.current.phase==='closing'&&f.media[0].closed===1,'pending admission did not close media');
  gate.resolve({call_id:'test-call',ws_path:'/ws/call/test-call',vision:false,joined});await started;await f.session.close();
  check(f.session.current.phase==='closed'&&f.sockets.length===(joined?0:1),'abandoned admission ownership mishandled');
  if(!joined)check(f.sockets[0].text[0].type==='hello'&&f.sockets[0].text[0].mic===false&&f.sockets[0].text[1].type==='bye','new abandoned call not released without microphone');
 }
 stage='native state, PCM sequence/epoch, mute and call-bound controls';
 const f=fresh();await f.session.start(room);const s=f.sockets[0],m=f.media[0];check(s.text[0].type==='hello'&&s.text[0].role==='owner'&&s.text[0].rate===48000,'owner handshake mismatch');
 s.message({type:'state',state:'preparing'});s.message({type:'flush',epoch:65535});s.message({type:'state',state:'live'});
 m.handlers.capture(new Uint8Array([3,0]));check(readCallAudio(s.binary[0]).epoch===65535,'capture epoch mismatch');
 f.session.setMuted(true);m.handlers.capture(new Uint8Array([3,0]));check(s.binary.length===1&&m.captures.at(-1)===false&&s.text.at(-1).muted===true,'muted capture escaped');f.session.setMuted(false);
 s.message({type:'caption',speaker:'ouroboros',item_id:'first',text:'hello',final:false,stream:1,epoch:65535});
 s.audio(65535,0xffffffff);s.audio(65535,0xffffffff);s.audio(65535,0);s.audio(65535,0xfffffffe);check(m.plays.length===2,'duplicate/old sequence or wrap mishandled');
 s.message({type:'flush',epoch:0});s.audio(65535,1);s.message({type:'caption',speaker:'ouroboros',item_id:'second',text:'new',final:false,stream:1,epoch:0});s.audio(0,0);
 check(m.plays.length===3&&m.plays.at(-1).item==='second','epoch wrap retained stale audio mapping');
 check(!f.session.sendContext('another-call','fact').sent&&f.session.sendContext('test-call',' fact ').sent&&s.text.at(-1).source==='gnome_owner_note','call identity control guard failed');
 check(f.session.sendParticipant('test-call','Guest',true).sent&&!f.session.sendContext('test-call','я'.repeat(9000)).sent,'participant or UTF8 bound failed');
 s.message({type:'state',state:'closed',reason:'done'});check(!f.session.current.active&&m.closed===1,'server close did not release media');
 stage='unknown frames preserve initial state deadline';
 const silent=fresh(),accepted=fresh();await silent.session.start(room);await accepted.session.start(room);
 silent.sockets[0].message({type:'future_extension',value:1});silent.sockets[0].message({type:'state',state:'future_state'});silent.sockets[0].message({type:'turn',turn:'idle'});
 accepted.sockets[0].message({type:'state',state:'preparing'});
 await wait(14500);
 check(silent.session.current.reason==='socket_silent'&&!silent.session.current.active,'additive/unknown state disabled answer timeout');
 check(accepted.session.current.active&&accepted.session.current.phase==='preparing','valid state failed to acknowledge initial answer');
 check(silent.sockets[0].text.some(x=>x.type==='bye'&&x.reason==='client_error'),'timeout did not release call');
 print('OK: native CallSession admission ownership validation and recovery ID, pending admission release, handshake/state deadline, synthetic PCM sequence/epoch wrap and stale suppression, mute, call-bound controls and closure; injected transport/media only, no actual API/WebSocket/provider/microphone');
}catch(e){failed=true;logError(e);print('Stage: '+stage)}finally{for(const s of sessions)await s.close();}
exit(failed?1:0);
