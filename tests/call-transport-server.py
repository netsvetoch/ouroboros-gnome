"""Actual call admission and peer WebSocket/hub; inert bridge queue and provider.
No actor, provider session, physical audio or microphone is started.
"""
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
    registry._extensions['live_conversation']=SimpleNamespace(api_instances=[api],generation_digest=registry._conversation_features['live_conversation:call']['extension_generation'],supervised_futures=[],active_call_work=0)
    extension_loader.runtime_state_for_skill_name=lambda *args,**kwargs:{'desired_live':True,'live_loaded':True}
    state_path=data/'live/conversation.json';state_path.parent.mkdir(parents=True,exist_ok=True)
    state_path.write_text(json.dumps({**plugin.DEFAULTS,'provider':'fixture_voice:engine','instructions':'Original <&> 🔧','enabled':True,'model':'retention','voice':'v1'}))
    import dataclasses
    from ouroboros import call_protocol as cp
    from ouroboros.call_peers import get_hub,close_hub
    from ouroboros.gateway.call_ws import call_routes
    from supervisor import message_bus
    admitted=[];queued=[];events=[];hubs={};audit=[];fault={'hold':False,'lost':False,'refuse':False}
    release=asyncio.Event();release.set()
    class Bridge:
        def broadcast(self,*args,**kwargs):pass
        def ui_send(self,text,**message):
            dispatch=message.pop('dispatch');admitted.append({'text':text,**message});dispatch(text,**message)
        def enqueue_local_message(self,text,**message):
            turn=message['task_metadata']['_realtime_turn'];hub=get_hub(turn.spec.call_id);hubs[hub.call_id]=hub
            queued.append({'call_id':hub.call_id,'chat_id':turn.spec.chat_id,'request':turn.request,'turn_type':type(turn).__name__})
    bridge=Bridge();message_bus.try_get_bridge=lambda:None if fault['refuse'] else bridge
    def drain():
        for call_id,hub in hubs.items():
            while True:
                event=hub.next_event(0)
                if event is None:break
                body=dataclasses.asdict(event)
                if isinstance(event,cp.PeerAudio):body['pcm']=list(event.pcm)
                if isinstance(event,cp.PeerVideo):
                    body.pop('data');body.update(size=len(event.data),sha256=hashlib.sha256(event.data).hexdigest(),head=list(event.data[:3]))
                events.append({'call_id':call_id,'kind':type(event).__name__,'body':body})
    async def facts(request):
        drain()
        return JSONResponse({'audit':audit,'admitted':admitted,'queued':queued,'events':events,
            'hubs':{key:{'closed':hub.closed,'owner_bye':hub.ended_by_owner,'epoch':hub.epoch,'peers':[dataclasses.asdict(p) for p in hub.peers()]} for key,hub in hubs.items()},
            'sessions':sessions,'settings_unchanged':config.SETTINGS_PATH.read_bytes()==initial})
    async def control(request):
        body=await request.json();action=body.get('action');hub=hubs.get(body.get('call_id'))
        if action=='release':release.set()
        if action=='hold':fault['hold']=True;release.clear()
        if action=='lost':fault['lost']=True
        if 'refuse' in body:fault['refuse']=body['refuse']
        if hub:
            if action=='live':hub.set_engine_rates(48000,48000);hub.send_state('live');hub.send_turn('answering');hub.send_activity('working','Synthetic tool <&>')
            if action=='speak':hub.send_caption('ouroboros',body.get('text','Synthetic reply <&>'),False,body.get('item','reply'));hub.play(bytes([1,0,2,0])*240,body.get('item','reply'))
            if action=='state':hub.send_state(body['state'],phase=body.get('phase',''))
            if action=='flush':hub.flush()
            if action=='close':close_hub(hub.call_id,'fixture_finished')
        return JSONResponse({'ok':True})
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),*call_routes()])
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or scope['path']!='/api/call/open':return await app(scope,receive,send)
            raw=bytearray();messages=[];record={'method':scope['method'],'path':scope['path']};audit.append(record)
            async def input():
                message=await receive();raw.extend(message.get('body',b''));return message
            async def output(message):messages.append(message)
            await app(scope,input,output);record['status']=messages[0]['status'];record['body']=json.loads(raw)
            content=b''.join(m.get('body',b'') for m in messages);record['reply']=json.loads(content)
            if fault['hold']:
                fault['hold']=False;record['held']=True;await release.wait();record['released']=True
            if fault['lost']:
                fault['lost']=False
                return await JSONResponse({'error':'Synthetic lost admission receipt'},status_code=503)(scope,receive,send)
            for message in messages:await send(message)
    sock=socket.socket();sock.bind(('127.0.0.1',0));(run/'port').write_text(str(sock.getsockname()[1]))
    uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])
if __name__=='__main__':main()
