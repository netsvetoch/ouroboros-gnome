import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {exit} from 'system';

const base=ARGV[0],remote=ARGV[1],local=ARGV[2];
const {Gateway,HttpError}=await import(base+'gateway.js');
const {probeConnection}=await import(base+'connection-probe.js');
const check=(value,message)=>{if(!value)throw new Error(message)};
async function rejects(fn,status,message){
 let error;try{await fn()}catch(e){error=e}
 check(error&&(status===undefined||error instanceof HttpError&&error.status===status),message+': '+error);
 return error;
}
const clients=[],sockets=[];
const client=(url,password='')=>{const result=new Gateway(url,password);clients.push(result);return result};
async function echo(gateway,value){
 const socket=await gateway.connect('/ws',new Gio.Cancellable());sockets.push(socket);
 return new Promise((resolve,reject)=>{
  const timer=GLib.timeout_add(0,3000,()=>{reject(new Error('WebSocket echo timeout'));return GLib.SOURCE_REMOVE});
  socket.connect('message',(_socket,_kind,bytes)=>{GLib.Source.remove(timer);resolve(JSON.parse(new TextDecoder().decode(bytes.get_data())))});
  socket.send_text(JSON.stringify(value));
 });
}
const app=new Gio.Application({application_id:'io.github.ouroboros.Client.AuthTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
async function run(){
 const anonymous=client(remote),session=client(remote),bearer=client(remote,'fixture-secret');
 check((await anonymous.publicJson('/api/health')).status==='ok','health unavailable without authentication');
 await rejects(()=>anonymous.json('GET','/api/state'),401,'unauthenticated HTTP admitted');
 await rejects(()=>anonymous.connect('/ws',new Gio.Cancellable()),undefined,'unauthenticated WebSocket admitted');
 check((await probeConnection(anonymous)).includes('HTTP 401'),'connection probe hid protected-state rejection');
 await rejects(()=>session.login('wrong-password'),401,'incorrect password accepted');check(!session.hasSession,'failed login created session');
 await session.login('fixture-secret');check(session.hasSession,'real gate cookie was not stored');
 const cookieState=await session.json('GET','/api/state');check(cookieState.cookie&&!cookieState.bearer,'cookie-only authentication failed');
 const publicState=await session.publicJson('/api/health');check(!publicState.cookie&&!publicState.bearer,'public health received authentication');
 check((await probeConnection(session)).includes('Доступ к защищённому состоянию подтверждён.'),'connection probe did not recognize cookie access');
 const sessionEcho=await echo(session,{text:'Сеанс GNOME 🔑'});check(sessionEcho.cookie&&!sessionEcho.bearer&&sessionEcho.value.text==='Сеанс GNOME 🔑','WebSocket lost cookie or Unicode payload');
 await rejects(()=>session.login('wrong-password'),401,'incorrect replacement password accepted');
 check(session.hasSession&&(await session.json('GET','/api/state')).cookie,'failed re-login erased valid session');
 const bearerState=await bearer.json('GET','/api/state');check(bearerState.bearer&&!bearerState.cookie&&!bearer.hasSession,'Bearer authentication acquired a browser session');
 const bearerEcho=await echo(bearer,{text:'Bearer'});check(bearerEcho.bearer&&!bearerEcho.cookie,'WebSocket lost Bearer authentication');
 const crossSite=await rejects(()=>bearer.json('POST','/fixture/control',{password:'must-not-apply'},{Origin:'https://other.example'}),403,'cross-site request bypassed the browser boundary');
 check(crossSite.reason&&(await bearer.json('GET','/api/state')).bearer,'boundary rejection lost its reason or applied the write');
 const distinct=client(remote);await rejects(()=>distinct.json('GET','/api/state'),401,'cookie leaked between Gateway instances');
 await rejects(()=>session.json('GET','/fixture/redirect'),302,'authenticated redirect was followed');
 await session.logout();check(!session.hasSession,'logout retained local session');
 await rejects(()=>session.json('GET','/api/state'),401,'logout retained HTTP authority');
 await rejects(()=>session.connect('/ws',new Gio.Cancellable()),undefined,'logout retained WebSocket authority');
 await session.logout();
 check((await bearer.json('GET','/api/state')).bearer,'cookie logout removed independent Bearer access');
 const audit=await bearer.json('GET','/fixture/audit');check(!audit.some(x=>x.path==='/fixture/redirect-target'||x.method==='GET'&&x.path==='/auth/logout'),'redirect/logout navigation reached another route');
 const logouts=audit.filter(x=>x.path==='/auth/logout');check(logouts.length===1&&logouts[0].method==='POST'&&logouts[0].cookie&&!logouts[0].bearer,'logout did not send the previous cookie exactly once');
 const loopback=client(local);check((await loopback.json('GET','/api/state')).supervisor_ready,'loopback gate unexpectedly required authentication');
 const loopbackError=await rejects(()=>loopback.login('fixture-secret'),undefined,'loopback created network session');
 check(loopbackError.message.includes('не выдаёт сетевые сеансы'),'inactive gate 404 was not explained');
 await session.login('fixture-secret');
 await bearer.json('POST','/fixture/control',{password:'replacement-secret'});
 await rejects(()=>session.json('GET','/api/state'),401,'old signed cookie survived password change');
 await rejects(()=>bearer.json('GET','/api/state'),401,'old Bearer survived password change');
 await rejects(()=>session.login('fixture-secret'),401,'old login password survived rotation');
 await session.login('replacement-secret');check((await session.json('GET','/api/state')).cookie,'new password could not replace expired session');
 check((await echo(session,{text:'Recovered'})).cookie,'WebSocket did not recover with replacement session');
 await session.json('POST','/fixture/control',{password:''});
 check((await anonymous.json('GET','/api/state')).supervisor_ready,'disabled network gate remained locked');
 await rejects(()=>anonymous.login('replacement-secret'),undefined,'disabled gate minted a session');
 print('OK: upstream NetworkAuthGate HTTP/WS cookie and Bearer, anonymous public probe, wrong password/re-login, per-Gateway cookie isolation, cross-site refusal, no redirect navigation, real cookie logout exactly once, loopback/inactive gate, password rotation and cookie/WS recovery');
}
app.connect('activate',()=>{app.hold();void run().catch(error=>{failed=true;logError(error)}).finally(()=>{
 for(const socket of sockets)try{socket.close(1000,null)}catch{}
 for(const gateway of clients)gateway.close();app.quit();
})});await app.runAsync([]);exit(failed?1:0);
