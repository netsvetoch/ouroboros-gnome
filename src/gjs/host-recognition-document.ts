/** Module-facing SpeechRecognition backed by native capture and local ASR. */
export const hostRecognitionDocument = `
 let recognitionEvent=()=>{},closeRecognition=()=>{};
 if(config.recognition){
  const runs=new Map();let serial=0,closed=false;
  function emit(owner,type,properties={}){
   const event=new Event(type);for(const [key,value] of Object.entries(properties))Object.defineProperty(event,key,{value});
   owner.dispatchEvent(event);const handler=owner['on'+type];if(typeof handler==='function'){try{handler.call(owner,event)}catch(error){queueMicrotask(()=>{throw error})}}
  }
  class Recognition extends EventTarget {
   constructor(){super();this.lang=config.recognition.language;this.continuous=false;this.interimResults=false;this.maxAlternatives=1;this._run=null;
    for(const type of ['start','audiostart','audioend','result','error','end','nomatch','soundstart','soundend','speechstart','speechend'])this['on'+type]=null;
   }
   start(...inputs){
    if(inputs.length)throw new DOMException('Audio track input is not supported','NotSupportedError');
    if(closed)throw new DOMException('Module closed','InvalidStateError');
    if(this._run)throw new DOMException('Recognition already started','InvalidStateError');
    const run={id:++serial,owner:this,results:[],aborted:false,stopping:false};this._run=run;runs.set(run.id,run);
    post({type:'recognition',op:'start',id:run.id,lang:String(this.lang||''),continuous:!!this.continuous});
   }
   stop(){const run=this._run;if(!run||run.stopping||closed)return;run.stopping=true;post({type:'recognition',op:'stop',id:run.id})}
   abort(){const run=this._run;if(!run||run.aborted||closed)return;run.aborted=true;post({type:'recognition',op:'abort',id:run.id})}
  }
  recognitionEvent=message=>{
   const run=runs.get(message.id);if(!run)return;
   if(message.type==='end'){runs.delete(run.id);if(run.owner._run===run)run.owner._run=null;emit(run.owner,'end');return}
   if(message.type==='error'){emit(run.owner,'error',{error:String(message.error||'service-not-allowed'),message:''});return}
   if(run.aborted)return;
   if(message.type==='result'&&typeof message.text==='string'){
    const index=run.results.length,result=[Object.freeze({transcript:(index?' ':'')+message.text,confidence:0})];
    Object.defineProperties(result,{isFinal:{value:true},item:{value:i=>result[i]??null}});Object.freeze(result);run.results.push(result);
    const results=run.results.slice();Object.defineProperty(results,'item',{value:i=>results[i]??null});Object.freeze(results);
    emit(run.owner,'result',{resultIndex:index,results});return;
   }
   if(['start','audiostart','audioend'].includes(message.type))emit(run.owner,message.type);
  };
  closeRecognition=()=>{closed=true;for(const run of runs.values()){run.owner._run=null;post({type:'recognition',op:'abort',id:run.id})}runs.clear()};
  Object.defineProperty(window,'SpeechRecognition',{configurable:true,value:Recognition});
  Object.defineProperty(window,'webkitSpeechRecognition',{configurable:true,value:Recognition});
 }
`;
