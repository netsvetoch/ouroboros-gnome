"""Real extension registrations, widget leases, auth gate and route dispatch; no models."""
def main():
    import asyncio,json,os,pathlib,re,socket,sys,zlib
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route,WebSocketRoute
    run=pathlib.Path(sys.argv[1]);reference=pathlib.Path(sys.argv[2])
    for key in list(os.environ):
        if key.startswith('OUROBOROS_'):os.environ.pop(key)
    data,repo=run/'data',run/'repo'
    for folder in (data/'logs',data/'memory',repo/'web/modules'):folder.mkdir(parents=True,exist_ok=True)
    os.environ.update(OUROBOROS_APP_ROOT=str(run),OUROBOROS_DATA_DIR=str(data),OUROBOROS_REPO_DIR=str(repo),OUROBOROS_SETTINGS_PATH=str(data/'settings.json'),OUROBOROS_SKILLS_REPO_PATH=str(run/'empty-skills'))
    from ouroboros import config,store_import,extension_loader
    from ouroboros.skill_loader import find_skill,compute_content_hash,SkillReviewState,save_review_state,save_skill_grants
    config.initialize_runtime_mode_baseline('advanced')
    config.SETTINGS_PATH.write_text(json.dumps({'OUROBOROS_NETWORK_PASSWORD':'fixture-widget-password','OUROBOROS_STARTER_SKILLS':'[]','TOTAL_BUDGET':0}))
    store_import.ensure_current_store(data)
    (repo/'web/modules/widget_frame_bridge.js').write_bytes((reference/'web/modules/widget_frame_bridge.js').read_bytes())
    from tests.widget_esm_fixture import install,NAME
    skill=install(data,reviewed=False)
    # Upstream fixture's IDAT checksum is invalid: WebKit correctly refuses decode.
    # Keep its pixel payload, repair chunk checksums before hashing/reviewing.
    image=skill/'images/pixel.png';png=image.read_bytes();fixed=png[:8];offset=8
    while offset<len(png):
        size=int.from_bytes(png[offset:offset+4],'big');chunk=png[offset+4:offset+8+size]
        fixed+=png[offset:offset+8+size]+zlib.crc32(chunk).to_bytes(4,'big');offset+=12+size
    image.write_bytes(fixed)
    plugin=skill/'plugin.py'
    extra='''
from starlette.responses import HTMLResponse, StreamingResponse
import asyncio
proofs=[]
stream_chunks=0
async def report(request):
    value=await request.json()
    allowed=('phase','value','cycle','size','last','json','api','origin','top','cookie','blocked','stream_size','stream_valid','event','late','theme','classic','global_value','css','image')
    proof={key:value[key] for key in allowed if key in value}
    proof['leased_module_url']='/api/widget-assets/' in str(value.get('url',''))
    proof['leased_base']='/api/widget-assets/' in str(value.get('base',''))
    proofs.append(proof)
    return {'ok':True}
async def observations(request):
    return {'proofs':proofs,'disposed':hits,'stream_chunks':stream_chunks}
async def stream(request):
    async def chunks():
        global stream_chunks
        for _ in range(32):
            stream_chunks+=1
            yield bytes(range(256))*128
            await asyncio.sleep(.001)
    return StreamingResponse(chunks(),media_type='application/octet-stream')
async def route_view(request):
    return HTMLResponse('''+repr("<!doctype html><div id='root'>Route ready</div><script src='/api/widget-bridge.js'></script><script>OuroborosWidget.ready.then(async()=>{let top=false,cookie=false;try{top=!!parent.document}catch{}try{cookie=!!document.cookie}catch{}const api=await(await OuroborosWidget.fetch('ping')).json();await OuroborosWidget.fetch('/api/extensions/esm_read_files/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phase:'route',api:api.ok,top,cookie,origin:window.origin})});__ouroWidgetOnDispose(async()=>{await OuroborosWidget.fetch('/api/extensions/esm_read_files/disposed',{method:'POST'})});});</script>")+''')
'''
    original=plugin.read_text();plugin.write_text(original.replace('def register(api):',extra+'\ndef register(api):')+"    api.register_route('report',report,methods=('POST',))\n    api.register_route('proofs',observations)\n    api.register_route('stream',stream)\n    api.register_route('view',route_view)\n    api.register_ui_tab('route','Route frame',render={'kind':'iframe','route':'view','start':'auto'})\n")
    main_js=skill/'app/main.js'
    main_js.write_text(main_js.read_text()+'''
await OuroborosWidget.ready;
let blocked=0;
for(const url of ['/api/settings','/api/extensions/neighbor/ping','https://elsewhere.invalid/private']){try{await fetch(url)}catch{blocked++}}
const pixel=document.getElementById('pixel');
await pixel.decode();
for(let i=0;i<200 && getComputedStyle(document.body).backgroundColor!=='rgb(23, 25, 29)';i++)await new Promise(resolve=>setTimeout(resolve,10));
const css=getComputedStyle(document.body).backgroundColor==='rgb(23, 25, 29)' && getComputedStyle(document.querySelector('h2')).fontSize==='20px';
const image=pixel.naturalWidth===1 && pixel.naturalHeight===1;
const streamed=new Uint8Array(await(await fetch('/api/extensions/esm_read_files/stream')).arrayBuffer());
await fetch('/api/extensions/esm_read_files/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...window.proof,phase:'module',blocked,css,image,stream_size:streamed.length,stream_valid:streamed.every((v,i)=>v===i%256)})});
OuroborosWidget.onEvent(async({type,data})=>{if(type==='probe'){await document.querySelector('#late').onclick();await fetch('/api/extensions/esm_read_files/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phase:'event',event:data.value,late:document.getElementById('root').dataset.late})})}else if(type==='fault'){Promise.reject(new Error('Fixture widget rejection <&>'))}});
OuroborosWidget.onTheme(theme=>{fetch('/api/extensions/esm_read_files/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phase:'theme',theme})})});
''')
    classic=skill/'classic.mjs';classic.write_text(classic.read_text()+'''
(async()=>{await OuroborosWidget.ready;const api=await(await fetch('/api/extensions/esm_read_files/ping')).json();await fetch('/api/extensions/esm_read_files/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phase:'classic',api:api.ok,classic:window.classicThis,global_value:window.classicGlobal})});__ouroWidgetOnDispose(async()=>{await fetch('/api/extensions/esm_read_files/disposed',{method:'POST'})})})();
''')
    digest=compute_content_hash(skill);save_review_state(data,NAME,SkillReviewState(status='pass',content_hash=digest))
    save_skill_grants(data,NAME,[],content_hash=digest,requested_keys=[],granted_permissions=['widget','route'],requested_permissions=['widget','route'])
    loaded=find_skill(data,NAME,repo_path=str(run/'empty-skills'))
    problem=extension_loader.load_extension(loaded,config.load_settings,drive_root=data,repo_path=str(run/'empty-skills'))
    assert problem is None,problem
    hold_frames=[]
    if len(sys.argv)>3 and sys.argv[3]=='holds':
        from supervisor import message_bus,state
        from ouroboros.usage_store import migrate_from_journal
        migrate_from_journal(data);state.init(data,total_budget_limit=0)
        bridge=message_bus.LocalChatBridge();bridge._broadcast_fn=hold_frames.append
        message_bus.init(data,0,1000,bridge)
    from ouroboros.gateway.router import collect_routes
    from ouroboros.server_auth import NetworkAuthGate
    peers=set();audit=[];board_fault={};release=asyncio.Event();release.set()
    async def facts(request):return JSONResponse({'audit':audit,'peers':len(peers),'hold_frames':hold_frames})
    async def control(request):
        value=await request.json()
        from ouroboros import extension_registry_state
        if value['action']=='board-fault':
            board_fault.clear();board_fault.update(value.get('fault',{}))
            if board_fault.get('hold'):release.clear()
            else:release.set()
        if value['action']=='event':
            tab=next(tab for tab in extension_loader.snapshot()['ui_tabs'] if tab['tab_id']=='main')
            prefix=tab['ws_prefix']
            for peer in list(peers):await peer.send_json({'type':prefix+value.get('event','probe'),'data':value.get('data',{})})
        return JSONResponse({'ok':True})
    async def ws(peer):
        await peer.accept();peers.add(peer)
        try:
            while True:await peer.receive_text()
        except Exception:pass
        finally:peers.discard(peer)
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),WebSocketRoute('/ws',ws),*collect_routes(data_dir=data)])
    app.state.drive_root=data;app.state.repo_dir=repo
    gate=NetworkAuthGate(app)
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type'] in ('http','websocket'):scope={**scope,'client':('192.0.2.42',12345)}
            if scope['type']!='http':return await gate(scope,receive,send)
            raw_path=scope['path'];safe=re.sub(r'(/api/widget-(?:assets|resources)/)[A-Za-z0-9_-]{43}/',r'\1<lease>/',raw_path)
            headers=dict(scope['headers']);record={'path':safe,'method':scope['method'],'authenticated':headers.get(b'authorization')==b'Bearer fixture-widget-password'};audit.append(record)
            if raw_path.startswith('/fixture/'):return await gate(scope,receive,send)
            if raw_path in ('/api/ui/preferences','/api/widgets','/api/ui/holds'):
                messages=[];raw=bytearray()
                async def input():
                    message=await receive();raw.extend(message.get('body',b''));return message
                async def output(message):messages.append(message)
                await gate(scope,input,output);record['status']=messages[0]['status']
                if raw:record['body']=json.loads(raw)
                fault=dict(board_fault)
                if fault.get('hold')==scope['method'] and raw_path=='/api/ui/preferences':await release.wait()
                mode=fault.get('preferences_'+scope['method'],'') if raw_path=='/api/ui/preferences' else fault.get('holds','') if raw_path=='/api/ui/holds' else fault.get('widgets','')
                if mode=='lost':return await JSONResponse({'error':'Fixture lost response'},status_code=503)(scope,receive,send)
                body=json.loads(b''.join(m.get('body',b'') for m in messages))
                if raw_path=='/api/ui/holds':record['response']=body.copy()
                if mode=='empty':body={'ok':True}
                if mode=='badnamed':body={'ok':True,'named':'1'}
                if mode=='order':body['widget_order']={}
                if mode=='size':body['widget_size']={'esm_read_files:classic':{'w':'2','h':0}}
                if mode=='modes':body['widget_start_mode']=[]
                if mode=='duplicate':body['ui_tabs'].append(body['ui_tabs'][0])
                if mode=='row':body['ui_tabs'].append(None)
                if mode=='title':body['ui_tabs'][0]['title']=[]
                if mode:return await JSONResponse(body)(scope,receive,send)
                for message in messages:await send(message)
                return
            if not raw_path.startswith('/api/widgets/asset-leases'):
                async def relay(message):
                    if message['type']=='http.response.start':record['status']=message['status']
                    await send(message)
                return await gate(scope,receive,relay)
            messages=[]
            async def capture(message):messages.append(message)
            await gate(scope,receive,capture)
            if messages:record['status']=messages[0].get('status')
            if raw_path.startswith('/api/widgets/asset-leases') and record.get('status')==200:
                body=json.loads(b''.join(m.get('body',b'') for m in messages));body['renew_after']=1
                return await JSONResponse(body)(scope,receive,send)
            for message in messages:await send(message)
    sock=socket.socket();sock.bind(('127.0.0.1',0));(run/'port').write_text(str(sock.getsockname()[1]));uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])
if __name__=='__main__':main()
