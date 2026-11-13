import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const {Gateway}=await import(ARGV[0]+'gateway.js');
const {ChatPage}=await import(ARGV[0]+'chat.js');
const {DictationAudio,dictationFormat}=await import(ARGV[0]+'dictation-audio.js');
const check=(v,m)=>{if(!v)throw new Error(m)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
async function until(fn,m){for(let i=0;i<1500;i++){if(await fn())return;await wait(20)}throw new Error(m)}
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.SpeechCodecTests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:1000,default_height:850}),gateway=new Gateway(ARGV[1],'');let chat,stage='catalog',record;const start=DictationAudio.prototype.start;
 DictationAudio.prototype.start=function(){record=this;this.source='audiotestsrc wave=sine num-buffers=100 samplesperbuffer=160 ! audio/x-raw,rate=16000,channels=1';return start.call(this)};
 const audio=async()=> (await gateway.json('GET','/api/extensions/native_actions/facts')).audio;
 (async()=>{
  chat=new ChatPage(win,gateway,{chatId:1,name:'Main'},()=>{});win.set_content(chat.widget);win.present();await until(()=>chat.contributions.current.contributions?.some(c=>c.key==='native_actions:codec_wav')&&!chat.draft.recovering,'codec declarations absent');const d=chat.dictation,results=[];
  for(const [suffix,mime,codec] of [['webm','audio/webm','opus'],['ogg','audio/ogg','opus'],['mp4','audio/mp4','aac'],['mpeg','audio/mpeg','mp3'],['wav','audio/wav','pcm_s16le']]){
   stage=mime;const key='native_actions:codec_'+suffix;await chat.contributions.saveVoice({stt:key});const provider=chat.contributions.speech('stt').find(p=>p.key===key),format=dictationFormat(provider);check(format?.type===mime,'declared encoder unavailable: '+mime);check(d.mic.is_sensitive(),'native codec choice disabled: '+d.mic.tooltip_text);chat.composer.text='';const count=(await audio()).length;d.mic.emit('clicked');await until(()=>!d.active,'record/encode/upload did not finish: '+mime);const observed=await audio();check(observed.length===count+1,'encoded upload missing: '+mime+' '+d.status.label);const fact=observed.at(-1);check(fact.type===mime&&fact.codec===codec&&fact.channels===1&&fact.frames>0&&fact.frames<=20000&&fact.size<=65536,'independent decoder rejected codec facts: '+JSON.stringify(fact));check(chat.composer.text==='Recognised <&> Ω'&&!record.pipeline&&!record.chunks.length,'codec result/lifetime wrong: '+mime);results.push({mime,codec:fact.codec,rate:fact.rate,frames:fact.frames,size:fact.size});
  }
  stage='cancel capture and byte bound';await chat.contributions.saveVoice({stt:'native_actions:codec_wav'});const count=(await audio()).length;d.mic.emit('clicked');d.cancelButton.emit('clicked');await wait(100);check(!d.active&&!record.pipeline&&(await audio()).length===count,'capture cancel uploaded bytes or retained pipeline');
  const wav=dictationFormat({formats:['audio/wav'],max_bytes:1000,max_seconds:1});await new Promise((resolve,reject)=>{const bounded=new DictationAudio(wav,{max_bytes:1000,max_seconds:1},()=>{},(error,bytes)=>{try{if(error)throw error;check(bytes.length<=1000&&bytes.length>=46,'PCM byte budget not enforced');check(new DataView(bytes.buffer).getUint32(40,true)===bytes.length-44,'bounded WAV header wrong');resolve()}catch(e){reject(e)}},'audiotestsrc num-buffers=100 samplesperbuffer=160 ! audio/x-raw,rate=16000,channels=1');bounded.start()});
  print('OK: all five real native Dictation encoders negotiated through declared providers/GTK and raw Gateway audio upload; independent wave or ffprobe/ffmpeg decode validates MIME, Opus/AAC/MP3/PCM, channels/sample frames and byte limits; actual draft insertion, EOS cleanup, capture cancel without upload and small WAV budget; synthetic sine, no physical audio/models '+JSON.stringify(results));
 })().catch(error=>{failed=true;logError(error);print('Stage: '+stage);print('Dictation: '+chat?.dictation?.status?.label)}).finally(async()=>{await chat?.close();DictationAudio.prototype.start=start;gateway.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
