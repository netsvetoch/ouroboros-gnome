"""Finite declared skill routes exercised through actual registration/dispatch; no model/job worker."""
def main():
    import asyncio,json,os,pathlib,socket,sys
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route,WebSocketRoute,Mount
    from starlette.staticfiles import StaticFiles
    run=pathlib.Path(sys.argv[1]);data=run/'data';repo=run/'repo'
    sock=socket.socket();sock.bind(('127.0.0.1',0))
    for key in list(os.environ):
        if key.startswith('OUROBOROS_'):os.environ.pop(key)
    for folder in (data/'logs',data/'memory',repo):folder.mkdir(parents=True,exist_ok=True)
    os.environ.update(OUROBOROS_APP_ROOT=str(run),OUROBOROS_DATA_DIR=str(data),OUROBOROS_REPO_DIR=str(repo),OUROBOROS_SETTINGS_PATH=str(data/'settings.json'),OUROBOROS_SKILLS_REPO_PATH=str(run/'empty-skills'))
    from ouroboros import config,store_import,extension_loader
    from ouroboros.skill_loader import find_skill,compute_content_hash,SkillReviewState,save_review_state,save_enabled,save_skill_grants
    config.initialize_runtime_mode_baseline('advanced');config.SETTINGS_PATH.write_text(json.dumps({'OUROBOROS_STARTER_SKILLS':'[]','TOTAL_BUDGET':0,'OUROBOROS_NETWORK_PASSWORD':'fixture-host-password' if len(sys.argv)>3 and sys.argv[3] in ('host-modules','host-recovery','capture-leases') else ''}));store_import.ensure_current_store(data)
    skill=data/'skills/external/native_actions';skill.mkdir(parents=True)
    entries=[
      {'id':'insert','placement':'composer.plus','label':'Insert template','action':{'verb':'draft.insert','text':'Template <&>'}},
      {'id':'notice','placement':'composer.plus','label':'Show notice','action':{'verb':'notice','text':'Notice <&>'}},
      {'id':'open','placement':'composer.plus','label':'Open widgets','action':{'verb':'open.tab'}},
      {'id':'request','placement':'composer.plus','label':'Send draft','action':{'verb':'skill.request','route':'invoke','with':'draft','then':'clear_draft'}},
      {'id':'message','placement':'message.action','label':'Process reply','action':{'verb':'skill.request','route':'invoke','with':'message'}}]
    host_mode=len(sys.argv)>3 and sys.argv[3] in ('host-modules','host-recovery','capture-leases')
    speech_mode=len(sys.argv)>3 and sys.argv[3] in ('speech','codecs')
    codec_mode=len(sys.argv)>3 and sys.argv[3]=='codecs'
    if speech_mode:entries.append({'id':'speech','provides':'stt','label':'Fixture speech','runtime':'server','route':'transcribe','destination':'host','formats':['audio/wav'],'max_bytes':8192,'max_seconds':1})
    if codec_mode:
        for suffix,mime in [('webm','audio/webm'),('ogg','audio/ogg'),('mp4','audio/mp4'),('mpeg','audio/mpeg'),('wav','audio/wav')]:
            entries.append({'id':'codec_'+suffix,'provides':'stt','label':'Codec '+suffix,'runtime':'server','route':'transcribe','destination':'host','formats':[mime],'max_bytes':65536,'max_seconds':1})
    if host_mode:
        (skill/'ui').mkdir()
        entries.extend([{'id':name,'provides':kind,'label':name,'runtime':'client','destination':'device','render':{'kind':'host','entry':'ui/'+entry}} for name,kind,entry in [('client_voice','tts','provider.js'),('client_stt','stt','provider.js'),('bad','tts','bad.js'),('hang','tts','hang.js')]])
        if sys.argv[3]=='capture-leases':entries=[e for e in entries if e['id'] not in ('bad','hang')]
        for name in ('generic_a','generic_b'):
            entries.append({'id':name,'placement':'composer.plus','label':name,'action':{'verb':'notice','text':'Native generic action'},'render':{'kind':'host','entry':'ui/generic.js'}})
        entries.append({'id':'conversation_module','provides':'conversation','label':'Conversation module','runtime':'client','destination':'device','render':{'kind':'host','entry':'ui/conversation.js'}})
        (skill/'ui/generic.js').write_text("export function mount(ctx){let refused=false;try{ctx.providers.register('tts',{})}catch{refused=true}ctx.notice(JSON.stringify({phase:'generic',key:ctx.key,refused}));return {dispose(){}}}")
        (skill/'ui/conversation.js').write_text("export function mount(ctx){const off=ctx.providers.register('conversation',{mountRoom(){throw new Error('No native room adapter in this fixture')}});ctx.notice('conversation registered');return {dispose:off}}")
        (skill/'ui/with space.js').write_text("export const value='Captured value';")
        (skill/'ui/lib.js').write_text("export {value} from './with space.js';")
        (skill/'ui/late.js').write_text("export const late='Dynamic value';")
        (skill/'ui/hang.js').write_text("export function mount(){while(true){}}")
        (skill/'ui/bad.js').write_text("export function mount(){throw new Error('Fixture host mount error <&>')}")
        (skill/'ui/provider.js').write_text('''import {value} from './lib.js';
export function mount(ctx){
 const initial=ctx.draft.insert('Module draft <&>');
 ctx.notice(JSON.stringify({phase:'mount',api:ctx.api,keys:Object.keys(ctx).sort(),initial,value,secure:ctx.origin.secure,loopback:ctx.origin.loopback}));
 const kind=ctx.key.endsWith('client_stt')?'stt':'tts';let finishSpeech;
 const off=ctx.providers.register(kind,{label:'Registered '+kind,destination:'device',available:()=>({ok:globalThis.fixtureAvailable!==false,reason:globalThis.fixtureAvailable===false?'Fixture unavailable':undefined}),
  async voices(){if(globalThis.fixtureDelayVoices)await new Promise(resolve=>setTimeout(resolve,globalThis.fixtureDelayVoices));if(globalThis.fixtureEmptyVoices)return [];const missing=await fetch(new URL('./missing.json',import.meta.url));ctx.notice('missing status '+missing.status);const {late}=await import('./late.js');return [{id:'test:voice',label:late,lang:'en',local:true}]},
  async speak(text,{voice,signal}={}){
   ctx.notice(JSON.stringify({phase:'speak',text,voice,dark:ctx.theme.dark,reduced:ctx.theme.reducedMotion}));
   if(text==='network'){
    const settings=await fetch('__GATEWAY_ORIGIN__/api/settings');
    const omitted=await fetch('/api/settings',{credentials:'omit'});await settings.arrayBuffer();await omitted.arrayBuffer();
    let blocked=false;try{await fetch('file:///etc/passwd')}catch{blocked=true}
    const {fetchJson}=await import('/static/modules/api_client.js');
    const posted=await fetchJson('/api/extensions/'+ctx.skill+'/network',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Fixture':'native header'},body:new Uint8Array([0,255,128,1,60,38])});
    const large=new Uint8Array(5*1024*1024+7);for(let i=0;i<large.length;i++)large[i]=i%251;
    const big=await fetchJson('/api/extensions/'+ctx.skill+'/network',{method:'PUT',body:large});
    const xhr=await new Promise((resolve,reject)=>{const x=new XMLHttpRequest();x.open('PATCH','__GATEWAY_ORIGIN__/api/extensions/'+ctx.skill+'/network');x.setRequestHeader('Content-Type','text/plain');x.onload=()=>resolve(JSON.parse(x.responseText));x.onerror=reject;x.send('XHR <&> Ω')});
    const compressed=await fetch('/api/extensions/'+ctx.skill+'/network?mode=gzip');const inflated=await compressed.text();
    const followed=await fetch('/api/extensions/'+ctx.skill+'/network?mode=redirect',{method:'POST',body:new Uint8Array([1,2,3])}),redirected=await followed.json();
    const manual=await fetch('/api/extensions/'+ctx.skill+'/network?mode=redirect',{redirect:'manual'});let refused=false;try{await fetch('/api/extensions/'+ctx.skill+'/network?mode=redirect',{redirect:'error'})}catch(e){refused=e.name==='TypeError'}
    const external=await fetchJson('/api/extensions/'+ctx.skill+'/network?mode=external');
    const redirectPolicy={manual:manual.status===0&&manual.type==='opaqueredirect'&&await manual.text()==='',refused,followed:followed.redirected&&followed.url==='__GATEWAY_ORIGIN__/api/extensions/'+ctx.skill+'/network',external:!external.authenticated&&!external.cookie};
    const flowing=await fetch('/api/extensions/'+ctx.skill+'/network?mode=stream'),reader=flowing.body.getReader();let count=0,correct=true,progressive=false;
    while(true){const {done,value}=await reader.read();if(done)break;for(let i=0;i<value.length;i++)if(value[i]!==((count+i)%251))correct=false;count+=value.length;if(!progressive){const facts=await fetchJson('/api/extensions/'+ctx.skill+'/facts');progressive=!facts.net_events.some(e=>e.mode==='stream'&&e.phase==='complete')}}
    const abort=new AbortController(),pending=fetch('/api/extensions/'+ctx.skill+'/network?mode=wait',{signal:abort.signal});setTimeout(()=>abort.abort(),80);let aborted=false;try{await pending}catch(e){aborted=e.name==='AbortError'}
    const slowAbort=new AbortController(),slow=await fetch('/api/extensions/'+ctx.skill+'/network?mode=slow',{signal:slowAbort.signal});await slow.body.getReader().read();slowAbort.abort();
    for(const proof of [{phase:'network',settings:settings.status,omitted:omitted.status,blocked,posted},{phase:'network-big',big},{phase:'network-xhr',xhr},{phase:'network-gzip',inflated},{phase:'network-redirect',redirected},{phase:'network-policy',redirectPolicy},{phase:'network-stream',count,correct,progressive,aborted}])ctx.notice(JSON.stringify(proof));
   }
   if(text==='socket'){
    const proof=await new Promise((resolve,reject)=>{
     const socket=new WebSocket('__GATEWAY_ORIGIN__'.replace(/^http/,'ws')+'/ws/call/abcd',['ouro.test.v1']);socket.binaryType='arraybuffer';
     let early=false,codeValidation=false,reasonValidation=false;
     try{socket.send('too early')}catch(e){early=e.name==='InvalidStateError'}
     try{socket.close(1001)}catch(e){codeValidation=e.name==='InvalidAccessError'}
     try{socket.close(1000,'Ω'.repeat(62))}catch(e){reasonValidation=e.name==='SyntaxError'}
     let count=0,textOk=false,viewOk=false,blobOk=false,largeOk=false,buffered=false;
     socket.onerror=()=>reject(new Error('Authenticated socket failed'));
     socket.onopen=()=>{
      socket.send('Socket <&> Ω');const source=new Uint8Array([9,0,255,128,1,60,38,9]),view=source.subarray(1,7);socket.send(view);view.fill(0);
      socket.send(new Blob([new Uint8Array([5,0,255])]));socket.send('after blob');
      const large=new Uint8Array(5*1024*1024+7);for(let i=0;i<large.length;i++)large[i]=i%251;socket.send(large);buffered=socket.bufferedAmount>=large.byteLength;socket.send('close fixture');
     };
     socket.onmessage=event=>{
      const index=count++;if(index===0)textOk=event.data==='Socket <&> Ω';
      if(index===1)viewOk=event.data instanceof ArrayBuffer&&[...new Uint8Array(event.data)].join(',')==='0,255,128,1,60,38';
      if(index===2)blobOk=event.data instanceof ArrayBuffer&&[...new Uint8Array(event.data)].join(',')==='5,0,255';
      if(index===3)textOk&&=event.data==='after blob';
      if(index===4){const bytes=new Uint8Array(event.data);largeOk=bytes.length===5*1024*1024+7&&bytes.every((value,i)=>value===i%251)}
     };
     socket.onclose=event=>resolve({count,textOk,viewOk,blobOk,largeOk,buffered,early,codeValidation,reasonValidation,clean:event.wasClean&&event.code===4001&&event.reason==='Fixture close Ω'&&socket.readyState===WebSocket.CLOSED,protocol:socket.protocol==='ouro.test.v1',privateCookie:document.cookie===''});
    });
    const {count,textOk,viewOk,blobOk,largeOk,buffered,...state}=proof;
    ctx.notice(JSON.stringify({phase:'socket-data',count,textOk,viewOk,blobOk,largeOk,buffered}));ctx.notice(JSON.stringify({phase:'socket-state',...state}));
    const {liveConversationSocket}=await import('/static/modules/api_client.js');
    for(const [id,create] of [['1234',()=>liveConversationSocket('/ws/call/1234')],['5678',()=>new WebSocket('ws://module/ws/call/5678')]]){
     const correct=await new Promise((resolve,reject)=>{const socket=create();let valid=false;socket.onopen=()=>socket.send(new Uint8Array([0,128,255]));socket.onerror=reject;socket.onmessage=async event=>{valid=event.data instanceof Blob&&[...new Uint8Array(await event.data.arrayBuffer())].join(',')==='0,128,255';socket.close(1000,'done')};socket.onclose=event=>resolve(valid&&event.wasClean&&socket.url==='__GATEWAY_ORIGIN__'.replace(/^http/,'ws')+'/ws/call/'+id)});
     ctx.notice(JSON.stringify({phase:'socket-extra',id,correct}));
    }
   }
   if(text==='socket_live'){
    const socket=new WebSocket('__GATEWAY_ORIGIN__'.replace(/^http/,'ws')+'/ws/call/9999');await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});ctx.notice('live socket opened');await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
   }
   if(text==='close_network'){const response=await fetch('/api/extensions/'+ctx.skill+'/network?mode=slow',{signal});const reader=response.body.getReader();await reader.read();ctx.notice('closing live response');await reader.read()}
   if(text==='close_wait')await fetch('/api/extensions/'+ctx.skill+'/network?mode=wait',{signal});
   if(text==='wait')await new Promise(resolve=>{finishSpeech=resolve;signal.addEventListener('abort',resolve,{once:true})});finishSpeech=undefined;
   if(text==='throw')throw new Error('Fixture provider call failure');
   ctx.notice('finished');
  },stop(){finishSpeech?.();finishSpeech=undefined;ctx.notice('stopped')},
  start({lang,signal}){
   ctx.notice('start '+lang);
   if(!window.fixtureCapture)return {stop:async()=>({text:'Client transcript <&>'}),cancel:()=>ctx.notice('cancelled')};
   window.fixtureStarts=(window.fixtureStarts||0)+1;let stream,cancelled=false;
   const pending=navigator.mediaDevices.getUserMedia({audio:true}).then(value=>{if(cancelled||signal.aborted){value.getTracks().forEach(t=>t.stop());throw new DOMException('Cancelled','AbortError')}stream=window.fixtureCaptureStream=value;return value});pending.catch(()=>{});
   const cancel=()=>{cancelled=true;stream?.getTracks().forEach(t=>t.stop())};signal.addEventListener('abort',cancel,{once:true});
   return {stop:async()=>{await pending;cancel();return {text:'Client transcript <&>'}},cancel};
  }
 });
 ctx.signal.addEventListener('abort',()=>ctx.notice('late dispose notice'));
 return {dispose(){off()}};
}
'''.replace('__GATEWAY_ORIGIN__',f'http://127.0.0.1:{sock.getsockname()[1]}'))
    (skill/'skill.json').write_text(json.dumps({'name':'Native actions','type':'extension','description':'Finite native action fixture','version':'1','entry':'plugin.py','plugin_api':'2.0','permissions':['route','page_module'] if host_mode else ['route'],'contributes':entries}))
    (skill/'plugin.py').write_text('''calls=[]
async def invoke(request):
    value=await request.json();calls.append(value);return {'notice':'Action accepted <&>'}
audio=[]
async def transcribe(request):
    import io,wave,hashlib
    raw=await request.body()
    fact={'size':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'type':request.headers.get('content-type'),'lang':request.query_params.get('lang')}
    if fact['type']=='audio/wav':
        with wave.open(io.BytesIO(raw),'rb') as wav:fact.update(rate=wav.getframerate(),channels=wav.getnchannels(),width=wav.getsampwidth(),frames=wav.getnframes(),codec='pcm_s16le')
    else:
        import subprocess,json,asyncio
        def inspect():
            metadata=subprocess.run(['ffprobe','-v','error','-show_streams','-show_format','-of','json','-i','pipe:0'],input=raw,stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True,timeout=10)
            stream=json.loads(metadata.stdout)['streams'][0]
            decoded=subprocess.run(['ffmpeg','-v','error','-i','pipe:0','-f','s16le','-ac','1','-ar','16000','pipe:1'],input=raw,stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True,timeout=10)
            return {'rate':int(stream['sample_rate']),'channels':stream['channels'],'codec':stream['codec_name'],'frames':len(decoded.stdout)//2,'width':2}
        fact.update(await asyncio.to_thread(inspect))
    audio.append(fact)
    return {'text':'Recognised <&> Ω'}
net_events=[]
async def network(request):
    import hashlib,asyncio,gzip
    from starlette.responses import Response,StreamingResponse,RedirectResponse
    mode=request.query_params.get('mode')
    if mode=='external':return RedirectResponse(f'{request.url.scheme}://localhost:{request.url.port}/fixture/external',status_code=302)
    if mode=='redirect':return RedirectResponse('/api/extensions/native_actions/network',status_code=307)
    if mode=='gzip':return Response(gzip.compress(b'Compressed native <&>'),media_type='application/octet-stream',headers={'Content-Encoding':'gzip','X-Fixture-Response':'gzip'})
    if mode in ('stream','slow'):
        async def output():
            net_events.append({'mode':mode,'phase':'start'})
            try:
                if mode=='slow':
                    yield b'first'
                    await asyncio.sleep(30)
                else:
                    for index in range(32):
                        yield bytes((index*32768+at)%251 for at in range(32768))
                        await asyncio.sleep(.02)
                    net_events.append({'mode':mode,'phase':'complete'})
            finally:net_events.append({'mode':mode,'phase':'closed'})
        return StreamingResponse(output(),media_type='application/octet-stream')
    if mode=='wait':
        await asyncio.sleep(5)
        return {'waited':True}
    raw=await request.body()
    return {'method':request.method,'type':request.headers.get('content-type'),'header':request.headers.get('x-fixture'),'size':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
async def facts(request):return {'calls':calls,'audio':audio,'net_events':net_events}
def register(api):
    api.register_route('network',network,methods=('GET','POST','PUT','PATCH','DELETE','HEAD'))
    api.register_route('invoke',invoke,methods=('POST',))
    api.register_route('facts',facts)
    api.register_route('transcribe',transcribe,methods=('POST',))
''')
    digest=compute_content_hash(skill);save_review_state(data,'native_actions',SkillReviewState(status='pass',content_hash=digest));save_enabled(data,'native_actions',True)
    from ouroboros.skill_loader import grant_status_for_skill
    requested=grant_status_for_skill(data,find_skill(data,'native_actions',repo_path=str(run/'empty-skills')))['requested_permissions']
    save_skill_grants(data,'native_actions',[],content_hash=digest,requested_keys=[],granted_permissions=requested,requested_permissions=requested)
    problem=extension_loader.load_extension(find_skill(data,'native_actions',repo_path=str(run/'empty-skills')),config.load_settings,drive_root=data,repo_path=str(run/'empty-skills'));assert problem is None,problem
    if speech_mode:
        import shutil
        voice_dir=data/'skills/external/device_voice';shutil.copytree(pathlib.Path(sys.argv[2])/'skills/device_voice',voice_dir)
        loaded=find_skill(data,'device_voice',repo_path=str(run/'empty-skills'));digest=compute_content_hash(voice_dir)
        save_review_state(data,'device_voice',SkillReviewState(status='pass',content_hash=digest));save_enabled(data,'device_voice',True)
        save_skill_grants(data,'device_voice',[],content_hash=digest,requested_keys=[],granted_permissions=['page_module'],requested_permissions=['page_module'])
        assert extension_loader.load_extension(find_skill(data,'device_voice',repo_path=str(run/'empty-skills')),config.load_settings,drive_root=data,repo_path=str(run/'empty-skills')) is None
    if len(sys.argv)>3 and sys.argv[3]=='recognition':
        import shutil
        recognition_dir=data/'skills/external/browser_speech';shutil.copytree(pathlib.Path(sys.argv[2])/'skills/browser_speech',recognition_dir)
        digest=compute_content_hash(recognition_dir)
        save_review_state(data,'browser_speech',SkillReviewState(status='pass',content_hash=digest));save_enabled(data,'browser_speech',True)
        loaded=find_skill(data,'browser_speech',repo_path=str(run/'empty-skills'))
        requested=grant_status_for_skill(data,loaded)['requested_permissions']
        save_skill_grants(data,'browser_speech',[],content_hash=digest,requested_keys=[],granted_permissions=requested,requested_permissions=requested)
        assert extension_loader.load_extension(loaded,config.load_settings,drive_root=data,repo_path=str(run/'empty-skills')) is None
    from ouroboros.gateway.router import collect_routes
    from ouroboros.projects_registry import create_project
    project=create_project(data,'contribution-room',name='Contribution room')
    release=asyncio.Event();release.set();fault={};audit=[];sockets=[]
    hold_frames=[]
    if len(sys.argv)>3 and sys.argv[3]=='host-recovery':
        from supervisor import state,message_bus
        state.init(data,total_budget_limit=0)
        bridge=message_bus.LocalChatBridge();bridge._broadcast_fn=hold_frames.append
        message_bus.init(data,0,1000,bridge)
    async def facts(request):return JSONResponse({'audit':audit,'project':project,'sockets':sockets,'hold_frames':hold_frames})
    async def control(request):
        value=await request.json();fault.clear();fault.update(value)
        if host_mode and value.get('reload'):
            release.set()
            def reload_reviewed():
                extension_loader.unload_extension('native_actions')
                source=skill/'ui/generic.js'
                source.write_text(source.read_text()+'\n// fixture new reviewed revision\n')
                revision=compute_content_hash(skill)
                save_review_state(data,'native_actions',SkillReviewState(status='pass',content_hash=revision))
                save_skill_grants(data,'native_actions',[],content_hash=revision,requested_keys=[],granted_permissions=requested,requested_permissions=requested)
                problem=extension_loader.load_extension(find_skill(data,'native_actions',repo_path=str(run/'empty-skills')),config.load_settings,drive_root=data,repo_path=str(run/'empty-skills'))
                assert problem is None,problem
            await asyncio.to_thread(reload_reviewed)
        if speech_mode and value.get('reload_voice'):
            def reload_voice():
                extension_loader.unload_extension('device_voice')
                source=voice_dir/'ui/tts.js'
                # Keep the real module's behavior, adding an observable reviewed revision.
                source.write_text(source.read_text().replace("label: 'Device voice'", "label: 'Reviewed native voice'").replace("speak(text, { voice, lang, signal } = {}) {", "speak(text, { voice, lang, signal } = {}) { text = 'Revision prefix. ' + text;"))
                revision=compute_content_hash(voice_dir)
                save_review_state(data,'device_voice',SkillReviewState(status='pass',content_hash=revision))
                save_skill_grants(data,'device_voice',[],content_hash=revision,requested_keys=[],granted_permissions=['page_module'],requested_permissions=['page_module'])
                problem=extension_loader.load_extension(find_skill(data,'device_voice',repo_path=str(run/'empty-skills')),config.load_settings,drive_root=data,repo_path=str(run/'empty-skills'))
                assert problem is None,problem
            await asyncio.to_thread(reload_voice)
        if fault.get('hold'):release.clear()
        else:release.set()
        return JSONResponse({'ok':True})
    async def ws(peer):
        await peer.accept()
        try:
            while True:await peer.receive_text()
        except Exception:pass
    async def socket_echo(peer):
        import hashlib
        headers=peer.headers
        record={'path':peer.url.path,'cookie':bool(headers.get('cookie')),'bearer':bool(headers.get('authorization')),'origin':headers.get('origin'),'messages':[],'closed':False}
        sockets.append(record)
        protocol='ouro.test.v1' if 'ouro.test.v1' in peer.scope.get('subprotocols',[]) else None
        await peer.accept(subprotocol=protocol)
        try:
            while True:
                value=await peer.receive()
                if value['type']=='websocket.disconnect':record['code']=value.get('code');break
                if 'bytes' in value and value['bytes'] is not None:
                    raw=value['bytes'];record['messages'].append({'kind':'binary','size':len(raw),'sha256':hashlib.sha256(raw).hexdigest()});await peer.send_bytes(raw)
                else:
                    text=value.get('text','');record['messages'].append({'kind':'text','size':len(text.encode())})
                    if text=='close fixture':await peer.close(code=4001,reason='Fixture close Ω');record['code']=4001;break
                    await peer.send_text(text)
        finally:record['closed']=True
    app=Starlette(routes=[WebSocketRoute('/ws',ws),WebSocketRoute('/ws/call/{fixture_id}',socket_echo),Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),Mount('/static',StaticFiles(directory=str(pathlib.Path(sys.argv[2])/'web'))),*collect_routes(data_dir=data)])
    app.state.drive_root=data;app.state.repo_dir=repo
    from ouroboros.server_auth import NetworkAuthGate
    gate=NetworkAuthGate(app) if host_mode else app
    class Observe:
        async def __call__(self,scope,receive,send):
            if host_mode and scope['type'] in ('http','websocket'):scope={**scope,'client':('192.0.2.42',12345)}
            path=scope.get('path','')
            if host_mode and scope['type']=='http' and path=='/fixture/external':
                headers=dict(scope['headers']);audit.append({'path':path,'method':scope['method'],'authenticated':bool(headers.get(b'authorization')),'cookie':bool(headers.get(b'cookie'))})
                return await JSONResponse({'authenticated':bool(headers.get(b'authorization')),'cookie':bool(headers.get(b'cookie'))},headers={'Access-Control-Allow-Origin':'*'})(scope,receive,send)
            if scope['type']!='http' or path.startswith('/fixture/'):return await gate(scope,receive,send)
            record={'path':path,'method':scope['method'],'authenticated':dict(scope['headers']).get(b'authorization')==b'Bearer fixture-host-password','cookie':bool(dict(scope['headers']).get(b'cookie'))};audit.append(record);messages=[];raw=bytearray()
            async def input():
                message=await receive();raw.extend(message.get('body',b''));return message
            async def output(message):messages.append(message)
            if host_mode and path=='/api/extensions/native_actions/network':
                async def stream_output(message):
                    if message['type']=='http.response.start':record['status']=message['status']
                    await send(message)
                try:await gate(scope,input,stream_output)
                finally:
                    if raw:
                        import hashlib
                        record['audio']={'size':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
                return
            await gate(scope,input,output);record['status']=messages[0]['status']
            if raw:
                try:record['body']=json.loads(raw)
                except (ValueError,UnicodeDecodeError):
                    import hashlib
                    record['audio']={'size':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
            current=dict(fault)
            if current.get('hold')==path and (not current.get('method') or current['method']==scope['method']):await release.wait()
            mode=current.get('mode','')
            if path=='/api/ui/contributions' and mode in ('row','order','duplicate','withdraw'):
                body=json.loads(b''.join(m.get('body',b'') for m in messages))
                if mode=='row':body['contributions'].append(None)
                if mode=='order':body['preferences']['contributions']['order']={}
                if mode=='duplicate':body['contributions'].append(body['contributions'][0])
                if mode=='withdraw':body['contributions']=[]
                return await JSONResponse(body)(scope,receive,send)
            if path=='/api/ui/preferences' and current.get('preferences_'+scope['method']):
                mode=current['preferences_'+scope['method']]
                body=json.loads(b''.join(m.get('body',b'') for m in messages))
                if mode=='lost':return await JSONResponse({'error':'Fixture lost settings response'},status_code=503)(scope,receive,send)
                if mode=='empty':body={'ok':True}
                if mode=='voice':body['voice']['stt']=[]
                if mode=='order':body['contributions']['order']={}
                if mode=='foreign':body['voice']['stt']='another:engine'
                return await JSONResponse(body)(scope,receive,send)
            if path=='/api/extensions/native_actions/transcribe':
                if mode=='no_speech':return await JSONResponse({'status':'no_speech','text':''})(scope,receive,send)
                if mode=='malformed':return await JSONResponse({'text':[]})(scope,receive,send)
                if mode=='lost':return await JSONResponse({'error':'Fixture transcription reply lost'},status_code=503)(scope,receive,send)
            if path=='/api/extensions/native_actions/invoke':
                from starlette.responses import Response
                if mode=='lost':return await JSONResponse({'error':'Fixture lost acknowledgement'},status_code=503)(scope,receive,send)
                if mode=='badjson':return await Response('{',media_type='application/json')(scope,receive,send)
                if mode=='empty':return await Response(status_code=204)(scope,receive,send)
                if mode=='text':return await Response('Accepted text',media_type='text/plain')(scope,receive,send)
                if mode=='jsontext':return await Response(json.dumps({'notice':'Receipt as text <&>'}),media_type='text/plain')(scope,receive,send)
            for message in messages:await send(message)
    (run/'port').write_text(str(sock.getsockname()[1]));uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])
if __name__=='__main__':main()
