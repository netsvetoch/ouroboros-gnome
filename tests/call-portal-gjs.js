import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import {exit} from 'system';
const {openPortalVideo}=await import(ARGV[0]+'call-portal.js');
Gtk.init();const win=new Gtk.Window({default_width:200,default_height:100});win.present();
const check=(x,m)=>{if(!x)throw new Error(m)};
const wait=ms=>new Promise(r=>GLib.timeout_add(0,ms,()=>{r();return GLib.SOURCE_REMOVE}));
async function until(fn,m){for(let i=0;i<400;i++){if(await fn())return;await wait(20)}throw new Error(m)}
function rpc(method,signature='()',args=[]){return new Promise((resolve,reject)=>Gio.DBus.session.call('org.freedesktop.portal.Desktop','/org/freedesktop/portal/desktop','org.ouroboros.PortalFixture',method,new GLib.Variant(signature,args),null,0,5000,null,(c,r)=>{try{resolve(c.call_finish(r).recursiveUnpack())}catch(e){reject(e)}}))}
const configure=body=>rpc('Configure','(s)',[JSON.stringify(body)]),facts=async()=>JSON.parse((await rpc('Facts'))[0]);
const fdOpen=fd=>{try{return GLib.file_read_link('/proc/self/fd/'+fd)==='/dev/null'}catch{return false}};
let stage='',failed=false;const remotes=[];
const opened=(kind,cancel,stopped=()=>{})=>openPortalVideo(win,kind,cancel,stopped).then(r=>{remotes.push(r);return r});
async function rejected(p){try{await p;throw new Error('unexpected success')}catch(e){check(!String(e).includes('unexpected success'),'unexpected success');return String(e)}}
try{
 stage='already cancelled operation never requests camera/screen access';for(const kind of ['screen','camera']){const c=new Gio.Cancellable();c.cancel();const before=(await facts()).audit.length;const e=await rejected(opened(kind,c));await wait(50);check(e.includes('Запрос доступа отменён')&&(await facts()).audit.length===before,'cancelled operation contacted portal '+kind)}
 stage='screen grant through real libportal/GTK parent and FD transfer';
 let stopped=0,r=await opened('screen',new Gio.Cancellable(),()=>stopped++);check(r.node===71&&r.serial==='12345'&&fdOpen(r.fd),'stream metadata/FD not received');let a=await facts(),create=a.audit.find(x=>x.method==='CreateSession'),select=a.audit.find(x=>x.method==='SelectSources'),start=a.audit.find(x=>x.method==='Start');const session=start.args[0];
 check(select.args[1].types===3&&select.args[1].multiple===false&&select.args[1].cursor_mode===2&&select.args[1].persist_mode===0&&!('restore_token' in select.args[1]),'source/cursor/persistence options differ');check(start.args[1].startsWith('x11:'),'GTK parent not exported');r.close();r.close();check(!fdOpen(r.fd)&&stopped===0,'close failed FD/idempotency or called external stop');await until(async()=>(await facts()).sessions[session].closed===1,'session not closed once');
 stage='external Session Closed signal';r=await opened('screen',new Gio.Cancellable(),()=>stopped++);a=await facts();const external=a.audit.filter(x=>x.method==='Start').at(-1).args[0];await rpc('EmitClosed','(o)',[external]);await until(()=>stopped===1,'external close callback missing');r.close();check(!fdOpen(r.fd),'externally closed FD not released');check((await facts()).sessions[external].closed===0,'external session closed again');
 stage='empty stream selection closes session without FD';await configure({streams:false});a=await facts();let before=a.audit.filter(x=>x.method==='OpenPipeWireRemote').length;let e=await rejected(opened('screen',new Gio.Cancellable()));check(e.includes('не вернул выбранный экран'),'empty stream reason missing');a=await facts();check(a.audit.filter(x=>x.method==='OpenPipeWireRemote').length===before,'empty streams opened FD');await configure({streams:true});
 stage='cancel pending Start sends Request.Close and releases session';await configure({hold:'Start'});const cancel=new Gio.Cancellable();let settled=false;const pending=opened('screen',cancel).then(r=>{settled=true;return r},e=>{settled=true;throw e});await until(async()=>(await facts()).pending.some(x=>x.method==='Start'),'no held Start');cancel.cancel();e=await rejected(pending);check(e.includes('Выбор экрана или окна отменён')&&settled,'cancel not localized/settled');await configure({hold:''});
 stage='screen cancellation during initial session creation';await configure({response:1});e=await rejected(opened('screen',new Gio.Cancellable()));check(e.includes('Выбор экрана или окна отменён'),'initial create cancellation not localized: '+e);await configure({response:0});
 stage='camera property, permission, independent scan FD and idempotent close';r=await opened('camera',new Gio.Cancellable());check(fdOpen(r.fd)&&typeof r.cameraScan==='function','camera FD absent');const scan=r.cameraScan();remotes.push(scan);check(scan.fd!==r.fd&&fdOpen(scan.fd),'camera scan did not get separate FD');r.close();r.close();check(!fdOpen(r.fd)&&fdOpen(scan.fd),'camera close leaked or closed independent scan');scan.close();check(!fdOpen(scan.fd),'scan FD leaked');
 await configure({camera:false});before=(await facts()).audit.length;e=await rejected(opened('camera',new Gio.Cancellable()));check(e.includes('не обнаружил камеру')&&(await facts()).audit.length===before,'absent camera requested access');await configure({camera:true,response:1});e=await rejected(opened('camera',new Gio.Cancellable()));check(e.includes('Запрос доступа к камере отменён'),'camera denial not localized');
 print('OK: actual openPortalVideo/libportal/GTK parent -> isolated D-Bus ScreenCast/Camera/Request/Session service, source options and stream/serial, Unix FD transfer/idempotent close, external stop, empty selection, Start cancellation and camera permission/scan ownership; /dev/null FD only, no real portal UI/PipeWire/capture');
}catch(e){failed=true;logError(e);print('Stage: '+stage)}finally{for(const r of remotes)r.close();win.destroy()}
exit(failed?1:0);
