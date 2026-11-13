/** Preserve genuine MediaStreams, and stop late or retained streams on module disposal. */
export const hostMediaDocument = `
 const streams=new Map();let mediaClosed=false,mediaGeneration=0,mediaSequence=0;
 function mediaControl(op,id,kinds){const request=new XMLHttpRequest();request.open('GET','ouro-host://module/_rpc?'+encodeURIComponent(JSON.stringify({op,text:JSON.stringify({id,kinds})})),false);request.send();if(request.status!==200)return {ok:false,message:'Module closed'};return JSON.parse(request.responseText)}
 const release=id=>{try{mediaControl('media-release',id)}catch{}};
 const prune=()=>{for(const [stream,id] of streams)if(stream.getTracks().every(t=>t.readyState==='ended')){streams.delete(stream);release(id)}};
 if(globalThis.MediaStreamTrack){const stop=MediaStreamTrack.prototype.stop;MediaStreamTrack.prototype.stop=function(){const result=stop.call(this);prune();return result}}
 const media=navigator.mediaDevices;
 for(const method of ['getUserMedia','getDisplayMedia'])if(typeof media?.[method]==='function'){
  const prototype=Object.getPrototypeOf(media),capture=prototype[method];
  prototype[method]=async function(...args){
   if(mediaClosed)throw new DOMException('Module closed','AbortError');
   const id='media:'+ ++mediaSequence,ticket=mediaGeneration,kinds=[];
   if(args[0]?.audio)kinds.push('audio');if(method==='getDisplayMedia'||args[0]?.video)kinds.push('visual');
   const claimed=mediaControl('media-acquire',id,kinds);if(!claimed.ok)throw new DOMException(claimed.message||'Capture is in use','NotReadableError');
   try{
    const stream=await capture.apply(this,args);
    if(mediaClosed||ticket!==mediaGeneration){stream.getTracks().forEach(t=>t.stop());throw new DOMException('Capture cancelled','AbortError')}
    mediaControl('media-opened',id);streams.set(stream,id);
    stream.getTracks().forEach(t=>t.addEventListener('ended',prune,{once:true}));
    return stream;
   }catch(error){release(id);throw error}
  };
 }
 function stopMedia(){mediaGeneration++;for(const stream of streams.keys())stream.getTracks().forEach(t=>t.stop());prune()}
 function closeMedia(){mediaClosed=true;stopMedia()}
`;
