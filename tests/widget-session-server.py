"""Finite declared skill routes exercised through actual registration/dispatch; no model/job worker."""
def main():
    import asyncio,json,os,pathlib,socket,sys
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route,WebSocketRoute
    run=pathlib.Path(sys.argv[1]);data=run/'data';repo=run/'repo'
    for key in list(os.environ):
        if key.startswith('OUROBOROS_'):os.environ.pop(key)
    for folder in (data/'logs',data/'memory',repo):folder.mkdir(parents=True,exist_ok=True)
    os.environ.update(OUROBOROS_APP_ROOT=str(run),OUROBOROS_DATA_DIR=str(data),OUROBOROS_REPO_DIR=str(repo),OUROBOROS_SETTINGS_PATH=str(data/'settings.json'),OUROBOROS_SKILLS_REPO_PATH=str(run/'empty-skills'))
    from ouroboros import config,store_import,extension_loader
    from ouroboros.skill_loader import find_skill,compute_content_hash,SkillReviewState,save_review_state,save_enabled,save_skill_grants
    config.initialize_runtime_mode_baseline('advanced');config.SETTINGS_PATH.write_text(json.dumps({'OUROBOROS_STARTER_SKILLS':'[]','TOTAL_BUDGET':0}));store_import.ensure_current_store(data)
    skill=data/'skills/external/native_session';skill.mkdir(parents=True)
    (skill/'SKILL.md').write_text('---\nname: native_session\ndescription: Native declarative session fixture.\nversion: 0.1.0\ntype: extension\nentry: plugin.py\npermissions: [widget, route]\n---\nFinite declared widget routes.\n')
    (skill/'plugin.py').write_text('''
import asyncio
from starlette.responses import StreamingResponse
calls=[];ticks={};streams=0;disconnected=0;mode='normal'
async def invoke(request):
    value=await request.json();calls.append(value);job=str(len(calls));ticks[job]=0
    if value.get('kind')=='form':return {'echo':value['text']}
    return {'job_id':job}
async def status(request):
    job=request.query_params['job_id'];ticks[job]+=1;n=ticks[job]
    if mode=='null':return {'status':None,'state':'done','result':{'text':'FALSE SUCCESS'}}
    if mode=='number':return {'status':42}
    if mode=='failed':return {'status':'failed'}
    if mode=='scalar':return {'status':'done','result':0,'text':'Published status <&>'}
    if mode=='normal' and n>=3:return {'status':'done','result':{'text':'Completed <&>'}}
    return {'status':'producer_wait','job_id':job,'progress_pct':60 if n==1 else 20,'custom_pct':80 if n==1 else 10}
async def polling(request):
    return {'phase':'done','text':'Polled <&>'}
async def events(request):
    global streams
    streams+=1
    async def body():
        global disconnected
        try:
            yield 'data: {"text":"Streamed <&>"}\\n\\n'
            while True:await asyncio.sleep(.05)
        finally:disconnected+=1
    return StreamingResponse(body(),media_type='text/event-stream')
async def facts(request):
    return {'calls':calls,'ticks':ticks,'streams':streams,'disconnected':disconnected}
async def control(request):
    global mode
    mode=(await request.json())['mode'];return {'ok':True}
def register(api):
    api.register_route('facts',facts)
    api.register_route('control',control,methods=('POST',))
    api.register_route('invoke',invoke,methods=('POST',))
    api.register_route('status',status)
    api.register_route('poll',polling)
    api.register_route('events',events)
    api.register_ui_tab('main','Native session',render={'kind':'declarative','components':[
      {'type':'form','id':'form','label':'Send form','route':'invoke','method':'POST','target':'form_result','fields':[{'name':'kind','type':'text','default':'form'},{'name':'text','type':'text','default':'Default'}]},
      {'type':'callout','target':'form_result','path':'echo'},
      {'type':'action','id':'job','label':'Start job','route':'invoke','method':'POST','body':{'kind':'job','literal':'Body <&>'},'target':'job_result','job':True,'interval_ms':1000,'max_ticks':5},
      {'type':'callout','target':'job_result','path':'text'},
      {'type':'progress','target':'job_result','value_key':'progress_pct'},
      {'type':'progress','target':'job_result','path':'custom_pct'},
      {'type':'poll','id':'poll','label':'Poll now','route':'poll','target':'poll_result','stop_path':'phase','stop_value':'done','max_ticks':2},
      {'type':'callout','target':'poll_result','path':'text'},
      {'type':'subscription','event':'probe','target':'ws_result','render':[{'type':'callout','path':'text'}]},
      {'type':'stream','route':'events','target':'stream_result'},
      {'type':'callout','target':'stream_result','path':'text'}]})
''')
    digest=compute_content_hash(skill);save_review_state(data,'native_session',SkillReviewState(status='pass',content_hash=digest));save_enabled(data,'native_session',True)
    save_skill_grants(data,'native_session',[],content_hash=digest,requested_keys=[],granted_permissions=['widget','route'],requested_permissions=['widget','route'])
    problem=extension_loader.load_extension(find_skill(data,'native_session',repo_path=str(run/'empty-skills')),config.load_settings,drive_root=data,repo_path=str(run/'empty-skills'));assert problem is None,problem
    from ouroboros.gateway.router import collect_routes
    # Get the module registered by the actual loader, not another import of plugin.py.
    handler=next(r for r in extension_loader.snapshot()['ui_tabs'] if r['tab_id']=='main');prefix=handler['ws_prefix']
    peers=set()
    async def facts(request):return JSONResponse({'peers':len(peers)})
    async def control(request):
        value=await request.json()
        if 'event' in value:
            for peer in list(peers):await peer.send_json({'type':prefix+'probe','data':{'text':value['event']}})
        return JSONResponse({'ok':True})
    async def ws(peer):
        await peer.accept();peers.add(peer)
        try:
            while True:await peer.receive_text()
        except Exception:pass
        finally:peers.discard(peer)
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),WebSocketRoute('/ws',ws),*collect_routes(data_dir=data)])
    app.state.drive_root=data;app.state.repo_dir=repo
    sock=socket.socket();sock.bind(('127.0.0.1',0));(run/'port').write_text(str(sock.getsockname()[1]));uvicorn.Server(uvicorn.Config(app,log_level='warning')).run(sockets=[sock])
if __name__=='__main__':main()
