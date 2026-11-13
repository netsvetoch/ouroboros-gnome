import { hostSocketsDocument } from "./host-sockets-document.js";
import { hostSpeechDocument } from "./host-speech-document.js";
import { hostMediaDocument } from "./host-media-document.js";
import { hostRecognitionDocument } from "./host-recognition-document.js";
import { scriptJson } from "./frame-browser.js";

const bootstrap = `
(async config => {
 const post = value => window.webkit.messageHandlers.ouroHost.postMessage(JSON.stringify({...value, capability:config.capability}));
 const lifecycle = new AbortController(), operations = new Map();
 const network = new Map(), nativeFetch=window.fetch.bind(window), owner=new URL(config.gateway+'/');
 let requestId=0;
 function mapUrl(value){
  const url=new URL(String(value),document.baseURI);
  if(url.origin===owner.origin&&!url.username&&!url.password){
   const root=owner.pathname.endsWith('/')?owner.pathname.slice(0,-1):owner.pathname;
   if(url.pathname.startsWith(root+'/'))return 'ouro-host://module'+url.pathname.slice(root.length)+url.search+url.hash;
  }
  return url.href;
 }
 function exposed(response,url,redirected){
  const clone=response.clone.bind(response);
  Object.defineProperties(response,{url:{value:url},redirected:{value:redirected},clone:{value:()=>exposed(clone(),url,redirected)}});return response;
 }
 function opaqueRedirect(){
  const response=new Response(null);
  Object.defineProperties(response,{type:{value:'opaqueredirect'},status:{value:0},statusText:{value:''},ok:{value:false},url:{value:''},clone:{value:opaqueRedirect}});return response;
 }
 function publicUrl(value){const url=new URL(value);return url.protocol==='ouro-host:'&&url.host==='module'?config.gateway+url.pathname+url.search:url.href}
 window.fetch=async(input,init)=>{
  const original=new Request(input,init);
  let address=original.url,method=original.method,headers=new Headers(original.headers);
  if(!mapUrl(address).startsWith('ouro-host://module/'))return nativeFetch(original);
  if(original.signal.aborted)throw new DOMException('Aborted','AbortError');
  let body=['GET','HEAD'].includes(method)?undefined:await original.arrayBuffer();
  for(let redirects=0;;redirects++){
   const mapped=mapUrl(address);
   if(!mapped.startsWith('ouro-host://module/'))return nativeFetch(new Request(mapped,{method,headers,body,signal:original.signal,credentials:original.credentials,redirect:original.redirect,mode:original.mode}));
   const id='fetch:'+ ++requestId,transportHeaders=new Headers(headers);
   transportHeaders.set('X-Ouro-Host-Request',id);transportHeaders.set('X-Ouro-Host-Credentials',original.credentials==='omit'?'omit':'include');
   const cancel=()=>post({type:'network-cancel',id});
   original.signal.addEventListener('abort',cancel,{once:true});network.set(id,()=>original.signal.removeEventListener('abort',cancel));
   try{
    const response=await nativeFetch(new Request(mapped,{method,headers:transportHeaders,body,signal:original.signal,credentials:'omit',cache:original.cache,redirect:'follow',mode:'cors'}));
    const status=Number(response.headers.get('X-Ouro-Host-Redirect-Status')||response.status),location=response.headers.get('Location');
    if(![301,302,303,307,308].includes(status)||!location)return exposed(response,publicUrl(mapped),redirects>0);
    if(original.redirect==='error')throw new TypeError('Redirect disallowed');
    if(original.redirect==='manual'){response.body?.cancel();cancel();network.get(id)?.();network.delete(id);return opaqueRedirect()}
    if(redirects>=20)throw new TypeError('Too many redirects');
    const next=new URL(location,publicUrl(mapped));
    if(next.origin!==owner.origin&&next.protocol!=='ouro-host:'){headers.delete('Authorization');headers.delete('Proxy-Authorization')}
    if((status===301||status===302)&&method==='POST'||status===303&&method!=='GET'&&method!=='HEAD'){
     method='GET';body=undefined;for(const key of ['Content-Type','Content-Encoding','Content-Language','Content-Location'])headers.delete(key);
    }
    address=next.href;
    response.body?.cancel();cancel();network.get(id)?.();network.delete(id);
   }catch(error){cancel();network.get(id)?.();network.delete(id);throw error}
  }
 };
 ${hostSocketsDocument}
 ${hostSpeechDocument}
 ${hostMediaDocument}
 ${hostRecognitionDocument}
 const open=XMLHttpRequest.prototype.open;
 XMLHttpRequest.prototype.open=function(method,url,...rest){return open.call(this,method,mapUrl(url),...rest)};

 let provider, handle, recognition, recognitionCall=0, generation=0, dark=config.dark, reducedMotion=config.reducedMotion, disposed=false, mountHandle;
 const sync = (op,text) => {
  if(disposed)return false;
  const request=new XMLHttpRequest();
  request.open('GET','ouro-host://module/_rpc?'+encodeURIComponent(JSON.stringify({op,text})),false);
  request.send();
  return request.status===200&&JSON.parse(request.responseText)===true;
 };
 const publish = () => {
  if(!provider){post({type:'provider',generation,provider:null});return}
  const required=config.kind==='stt'?['start','available']:config.kind==='tts'?['voices','speak','stop']:[];
  let availability={ok:false,code:'invalid_provider'};
  if(required.every(key=>typeof provider[key]==='function')){
   try{availability=typeof provider.available==='function'?provider.available():{ok:true}}catch(error){availability={ok:false,code:'fault',reason:String(error.message||error)}}
  }
  post({type:'provider',generation,provider:{availability,label:typeof provider.label==='string'&&provider.label?provider.label:config.label,destination:typeof provider.destination==='string'&&provider.destination?provider.destination:config.destination}});return availability;
 };
 const context=Object.freeze({api:1,skill:config.skill,key:config.key,signal:lifecycle.signal,
  providers:Object.freeze({register(kind,impl){
   if(disposed)return()=>{};
   if(!config.kind||kind!==config.kind||!impl||typeof impl!=='object')throw new Error('module registered an undeclared provider');
   provider=impl;generation++;publish();
   return()=>{if(provider===impl){provider=undefined;generation++;publish()}};
  }}),
  notice(text){if(!disposed)sync('notice',String(text??'').slice(0,300))},
  draft:Object.freeze({insert:text=>sync('insert',String(text??''))}),
  theme:Object.freeze({get dark(){return dark},get reducedMotion(){return reducedMotion}}),
  origin:Object.freeze(config.origin)
 });
 const errorText=error=>String(error?.message||error||'module failed').slice(0,1000);
 window.addEventListener('error',event=>post({type:'fault',message:errorText(event.error||event.message)}));
 window.addEventListener('unhandledrejection',event=>post({type:'fault',message:errorText(event.reason)}));
 Object.defineProperty(window,'__ouroHostCommand',{value:async(key,message)=>{
  if(key!==config.capability||disposed)return;
  const {id,op,args={}}=message;
  const currentGeneration=generation;
  const reply=(value,error)=>post({type:'reply',id,generation:currentGeneration,value,error});
  try{
   if(op==='network-done'){network.get(args.id)?.();network.delete(args.id);return}
   if(op==='speech-event'){speechEvent(args);return}
   if(op==='recognition-event'){recognitionEvent(args);return}
   if(op==='media-stop'){stopMedia();return}
   if(op==='theme'){dark=!!args.dark;reducedMotion=!!args.reducedMotion;return}
   if(op==='cancel'){
    const operation=operations.get(args.id);
    if(operation){operation.abort();operations.delete(args.id);try{provider?.stop?.()}catch{}}
    if(recognitionCall===args.id){recognition?.abort();recognition=undefined;recognitionCall=0;try{handle?.cancel()}catch{};handle=undefined}
    return;
   }
   if(op==='dispose'){
    disposed=true;closeMedia();for(const [id,off] of network){post({type:'network-cancel',id});off()}network.clear();lifecycle.abort();for(const c of operations.values())c.abort();operations.clear();
    recognition?.abort();recognition=undefined;recognitionCall=0;try{handle?.cancel()}catch{};handle=undefined;try{provider?.stop?.()}catch{};
    closeRecognition();closeSpeech();const socketsClosing=closeSockets();await mountHandle?.dispose?.();await socketsClosing;post({type:'disposed'});return;
   }
   if(op==='stop'){recognition?.abort();recognition=undefined;recognitionCall=0;handle?.cancel();handle=undefined;provider?.stop?.();reply(null);return}
   if(!provider)throw new Error('provider is not registered');
   if(op==='available'){reply(publish());return}
   if(op==='voices'){reply(await provider.voices());return}
   if(op==='start'){recognition?.abort();handle?.cancel();recognition=new AbortController();recognitionCall=id;handle=provider.start({lang:args.lang,signal:recognition.signal});if(!handle||typeof handle.stop!=='function'||typeof handle.cancel!=='function')throw new Error('invalid recognition handle');reply(true);return}
   if(op==='finish'){if(!handle)throw new Error('recognition has not started');const active=handle;recognitionCall=id;try{reply(await active.stop())}finally{if(handle===active){handle=undefined;recognition=undefined;recognitionCall=0}}return}
   if(op==='speak'){
    const controller=new AbortController();operations.set(id,controller);
    try{await provider.speak(args.text,{voice:args.voice,lang:args.lang,signal:controller.signal});reply(null)}finally{operations.delete(id)}
    return;
   }
   throw new Error('unknown provider operation');
  }catch(error){reply(null,errorText(error))}
 }});
 try{
  const module=await import(config.entry);
  if(disposed)return;
  if(typeof module.mount!=='function')throw new Error('module exports no mount(ctx)');
  mountHandle=await module.mount(context);
  if(disposed){await mountHandle?.dispose?.();return}
  post({type:'mounted'});
 }catch(error){post({type:'fault',message:errorText(error)})}
})
`;

export function hostModuleDocument(config: object): string {
  return `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><script>${bootstrap}(${scriptJson(config)});</script>`;
}
