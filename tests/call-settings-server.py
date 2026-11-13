"""Real Live Conversation plugin config route/validator/file writer and PluginAPI dispatch.
Provider catalogs and credential grants are inert fixture data; sessions never open."""
def main():
    import asyncio,copy,hashlib,importlib,json,os,pathlib,socket,sys
    from types import SimpleNamespace
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    run=pathlib.Path(sys.argv[1]);data=run/'data';data.mkdir();(run/'repo').mkdir()
    for key in list(os.environ):
        if key.startswith('OUROBOROS_'):os.environ.pop(key)
    os.environ.update(OUROBOROS_APP_ROOT=str(run),OUROBOROS_DATA_DIR=str(data),OUROBOROS_REPO_DIR=str(run/'repo'),OUROBOROS_SETTINGS_PATH=str(data/'settings.json'))
    from ouroboros import config,extension_loader,extension_registry_state as registry
    from ouroboros.settings_setup_contract import SECRET_SETTING_KEYS
    for key in SECRET_SETTING_KEYS:os.environ.pop(key,None)
    config.initialize_runtime_mode_baseline('light');config.SETTINGS_PATH.write_text('{}');initial=config.SETTINGS_PATH.read_bytes()
    from ouroboros.extension_plugin_api import PluginAPIImpl
    from ouroboros.extension_registry_state import _PluginAPIConfig
    from ouroboros.contracts.realtime import ProviderCatalog,CatalogModel,CatalogVoice,RouteFacts,RealtimeRoute
    from ouroboros.gateway.extensions import api_extension_dispatch
    sessions=[]
    def session(*args,**kwargs):sessions.append('unexpected session');raise AssertionError('fixture never opens realtime media')
    provider=PluginAPIImpl(_PluginAPIConfig(skill_name='fixture_voice',permissions=['realtime_provider','read_settings'],env_allowlist=['FIXTURE_VOICE_KEY'],granted_keys=['FIXTURE_VOICE_KEY'],settings_reader=lambda:{'FIXTURE_VOICE_KEY':'fixture-only'},state_dir=data/'provider',drive_root=data))
    catalog=ProviderCatalog(label='Fixture engine <&> 🔧',privacy='Fixture privacy <&>',credential_settings=('FIXTURE_VOICE_KEY',),models=(
        CatalogModel(id='retention',label='Retention model <&>',default=True,vision=True,silent_tool_results=True,voices=(CatalogVoice('v1','Voice <&> 🔧'),CatalogVoice('v2','Second voice')),
            facts=RouteFacts(conversation_window_tokens=32000,accepted_input_tokens=64000,working_reserve_tokens=4000,basis='provider',source='Fixture retention <&>',observed='2026-11-12',acceptance_can_raise=False),
            honours=frozenset({'pause','interruptions','thinking','search'}),thinking_levels=('low','high'),thinking_default='low'),
        CatalogModel(id='unknown-window',label='Unknown conversation window',facts=RouteFacts(accepted_input_tokens=16000,working_reserve_tokens=1000,basis='provider',source='Fixture acceptance only',acceptance_can_raise=True),
            notes=(('pause','Fixture controls pause <&>'),('thinking','No thinking control'),('search','No native search'),('interruptions','No interruption control'))),))
    provider.register_realtime_provider('engine',route=RealtimeRoute(accounting_provider='fixture',endpoint='wss://fixture.invalid/realtime',model_prefix='fixture/'),session=session,catalog=catalog)
    provider._publish_registrations(content_hash='fixture-provider-review')
    registry._extensions['fixture_voice']=SimpleNamespace(api_instances=[provider])
    api=PluginAPIImpl(_PluginAPIConfig(skill_name='live_conversation',permissions=['widget','route','live_conversation'],env_allowlist=[],settings_reader=lambda:{},state_dir=data/'live',drive_root=data))
    plugin=importlib.import_module('skills.live_conversation.plugin');plugin.register(api);api._publish_registrations(content_hash='fixture-live-review')
    registry._extensions['live_conversation']=SimpleNamespace(api_instances=[api])
    extension_loader.runtime_state_for_skill_name=lambda *args,**kwargs:{'desired_live':True,'live_loaded':True}
    state_path=data/'live/conversation.json';state_path.parent.mkdir(parents=True,exist_ok=True)
    state_path.write_text(json.dumps({**plugin.DEFAULTS,'provider':'fixture_voice:engine','instructions':'Original <&> 🔧'}))
    end_requests=[]
    original_end=plugin.end_feature_calls
    def end(feature):end_requests.append(feature);return original_end(feature)
    plugin.end_feature_calls=end
    audit=[];fault={'get':'','post':'','hold':''};release=asyncio.Event();release.set()
    async def facts(request):
        raw=state_path.read_bytes()
        try:saved=json.loads(raw)
        except ValueError:saved=None
        try:effective=plugin.configuration_view(plugin.validate(saved),plugin.registered_catalogs())
        except Exception:effective=None
        return JSONResponse({'audit':audit,'saved':saved,'effective':effective,'defaults':plugin.DEFAULTS,'state_sha':hashlib.sha256(raw).hexdigest(),
            'settings_unchanged':config.SETTINGS_PATH.read_bytes()==initial,'sessions':sessions,'end_requests':end_requests})
    async def control(request):
        body=await request.json()
        if body.get('action')=='release-all':fault['hold']='';release.set()
        if body.get('state')=='malformed':state_path.write_text('{\"enabled\":')
        elif body.get('state')=='invalid':state_path.write_text(json.dumps({'enabled':'invalid','provider':'fixture_voice:engine','instructions':'Do not reset without consent'}))
        elif body.get('state')=='array':state_path.write_text('[]')
        if 'hold' in body:fault['hold']=body['hold'];release.clear()
        for key in ('get','post'):
            if key in body:fault[key]=body[key]
        return JSONResponse({'ok':True})
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),Route('/api/extensions/{skill}/{rest:path}',api_extension_dispatch,methods=['GET','POST'])]);app.state.drive_root=data;app.state.repo_dir=run/'repo'
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or not scope['path'].startswith('/api/'):return await app(scope,receive,send)
            raw=bytearray();messages=[];record={'method':scope['method'],'path':scope['path']};audit.append(record)
            async def input():
                message=await receive();raw.extend(message.get('body',b''));return message
            async def output(message):messages.append(message)
            if scope['method']=='POST' and fault['post']=='before':
                fault['post']=''
                while True:
                    message=await input()
                    if not message.get('more_body'):break
                record['body']=json.loads(raw);record['status']=503
                return await JSONResponse({'error':'Fixture recovery refused before handler'},status_code=503)(scope,receive,send)
            await app(scope,input,output);record['status']=messages[0]['status']
            if raw:record['body']=json.loads(raw)
            content=b''.join(m.get('body',b'') for m in messages)
            if fault['hold']==scope['method']:
                fault['hold']='';record['held']=True;await release.wait();record['released']=True
            mode=fault['get' if scope['method']=='GET' else 'post']
            if scope['method']=='POST':fault['post']=''
            if mode=='timeout':return await JSONResponse({'error':'Fixture accepted request timed out'},status_code=408)(scope,receive,send)
            if mode=='http':return await JSONResponse({'error':'Fixture accepted response lost'},status_code=503)(scope,receive,send)
            if messages[0]['status']==200 and mode:
                body=copy.deepcopy(json.loads(content))
                if mode=='model':body['catalogs'][0]['models'][0]['voices']=[None]
                elif mode=='facts':body['catalogs'][0]['models'][0]['facts']['working_reserve_tokens']='4000'
                elif mode=='notes':body['catalogs'][0]['models'][0]['notes']=[['pause',{}]]
                elif mode=='booleans':body['search']='true'
                elif mode=='mismatch':body['instructions']='different acknowledgement'
                elif mode=='reset-enabled':body['enabled']=True
                return await JSONResponse(body)(scope,receive,send)
            for message in messages:await send(message)
    sock=socket.socket();sock.bind(('127.0.0.1',0));(run/'port').write_text(str(sock.getsockname()[1]))
    uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])
if __name__=='__main__':main()
