/** Web Speech synthesis capability backed by this module's native local engine. */
export const hostSpeechDocument = `
 let speechEvent=()=>{}, closeSpeech=()=>{};
 if(config.speech){
  const voices=config.speech.voices.map(v=>Object.freeze({...v})),queue=[];
  let active,paused=false,serial=0,closed=false;
  class Utterance extends EventTarget {
   constructor(text=''){super();this.text=String(text);this.lang='';this.voice=null;this.volume=1;this.rate=1;this.pitch=1;
    this.onstart=this.onend=this.onerror=this.onpause=this.onresume=this.onboundary=this.onmark=null;
   }
  }
  function emit(run,type,error){
   const event=new Event(type);Object.defineProperties(event,{utterance:{value:run.utterance},charIndex:{value:0},charLength:{value:0},elapsedTime:{value:run.started?(performance.now()-run.started)/1000:0},name:{value:''},...(error?{error:{value:error}}:{})});
   run.utterance.dispatchEvent(event);const handler=run.utterance['on'+type];if(typeof handler==='function'){try{handler.call(run.utterance,event)}catch(error){setTimeout(()=>{throw error},0)}}
  }
  function next(){
   if(closed||active||paused||!queue.length)return;
   active=queue.shift();const u=active.utterance;
   const voice=u.voice||voices.find(v=>v.lang===u.lang)||voices[0];
   post({type:'speech',op:'speak',id:active.id,text:String(u.text),voice:voice?.voiceURI,rate:Number(u.rate),pitch:Number(u.pitch),volume:Number(u.volume)});
  }
  class Synthesis extends EventTarget {
   constructor(){super();this.onvoiceschanged=null}
   get pending(){return queue.length>0} get speaking(){return !!active} get paused(){return paused}
   getVoices(){return voices.slice()}
   speak(utterance){if(!(utterance instanceof Utterance))throw new TypeError('Expected SpeechSynthesisUtterance');if(closed)return;queue.push({id:++serial,utterance});next()}
   cancel(){const stopped=active,waiting=queue.splice(0);active=undefined;post({type:'speech',op:'cancel'});if(stopped)queueMicrotask(()=>emit(stopped,'error',stopped.started?'interrupted':'canceled'));for(const run of waiting)queueMicrotask(()=>emit(run,'error','canceled'))}
   pause(){if(paused||closed)return;paused=true;post({type:'speech',op:'pause'});if(active?.started)emit(active,'pause')}
   resume(){if(!paused||closed)return;paused=false;post({type:'speech',op:'resume'});if(active?.started)emit(active,'resume');next()}
  }
  const synth=new Synthesis();
  speechEvent=message=>{const run=active;if(!run||message.id!==run.id)return;if(message.type==='start'){run.started=performance.now();emit(run,'start');return}if(!['end','error'].includes(message.type))return;active=undefined;emit(run,message.type,message.error);next()};
  closeSpeech=()=>{closed=true;synth.cancel()};
  Object.defineProperty(window,'speechSynthesis',{configurable:true,value:synth});Object.defineProperty(window,'SpeechSynthesisUtterance',{configurable:true,value:Utterance});
 }
`;
