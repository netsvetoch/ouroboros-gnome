/** Keep the platform's WebSocket implementation, with module lifetime ownership. */
export const hostSocketsDocument = `
 const NativeSocket=window.WebSocket,sockets=new Set();let socketsStopped=false;
 class ModuleSocket extends NativeSocket{
  constructor(address,protocols){
   if(socketsStopped)throw new DOMException('Module closed','InvalidStateError');
   let target=address;
   try{
    const url=new URL(String(address),document.baseURI);
    if(['ws:','wss:'].includes(url.protocol)&&url.hostname==='module'&&!url.port&&!url.username&&!url.password&&!url.href.includes('#')){
     const gateway=new URL(config.gateway+'/');gateway.protocol=gateway.protocol==='https:'?'wss:':'ws:';
     gateway.pathname=gateway.pathname.slice(0,-1)+url.pathname;gateway.search=url.search;gateway.hash=url.hash;
     target=gateway.href;
    }
   }catch{ /* Let the native constructor report invalid URLs. */ }
   super(target,protocols);sockets.add(this);
   this.addEventListener('close',()=>sockets.delete(this),{once:true});
  }
 }
 window.WebSocket=ModuleSocket;
 async function closeSockets(){
  socketsStopped=true;
  let timer;
  await Promise.race([Promise.all([...sockets].map(socket=>new Promise(resolve=>{
   if(socket.readyState===NativeSocket.CLOSED){resolve();return}
   socket.addEventListener('close',resolve,{once:true});
   try{socket.close(1000,'Module closed')}catch{resolve()}
  }))),new Promise(resolve=>{timer=setTimeout(resolve,750)})]);
  clearTimeout(timer);sockets.clear();
 }
`;
