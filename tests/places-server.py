def main():
    """Real Places APIs; one fixture connector declaration/status, no remote service."""
    import json
    import os
    import pathlib
    import socket
    import sys
    from types import SimpleNamespace

    run = pathlib.Path(sys.argv[1])
    for key in list(os.environ):
        if key.startswith("OUROBOROS_"):
            os.environ.pop(key)
    os.environ.update({"OUROBOROS_APP_ROOT": str(run), "OUROBOROS_DATA_DIR": str(run / "data"),
                       "OUROBOROS_REPO_DIR": str(run / "repo"), "OUROBOROS_SETTINGS_PATH": str(run / "data/settings.json")})
    data, repo = run / "data", run / "repo"
    for directory in (data / "logs", data / "memory", repo):
        directory.mkdir(parents=True, exist_ok=True)
    (data / "logs/chat.jsonl").write_text("")
    (data / "logs/progress.jsonl").write_text("")

    from ouroboros import config, store_import
    from ouroboros.settings_setup_contract import SECRET_SETTING_KEYS
    for key in SECRET_SETTING_KEYS:
        os.environ.pop(key, None)
    config.initialize_runtime_mode_baseline("light")
    config.SETTINGS_PATH.write_text(json.dumps({"OUROBOROS_SUBAGENTS": '{"enabled":false,"items":[]}',
        "OUROBOROS_SUBAGENTS_MODE": "off", "TOTAL_BUDGET": 0}))
    store_import.ensure_current_store(data)
    from ouroboros.usage_store import migrate_from_journal
    migrate_from_journal(data)
    from supervisor import queue, workers
    queue.init(data)
    queue.init_queue_refs(workers.PENDING, workers.RUNNING, workers.QUEUE_SEQ_COUNTER_REF)
    workers.WORKERS = {0: SimpleNamespace(busy_task_id=None, reaping=False)}
    workers._WORKER_POOL_DISABLED_REASON = ""

    queue.publish_queue_snapshot(reason='places_fixture')
    from ouroboros.contracts.skill_manifest import parse_skill_manifest_text
    from ouroboros.extension_ui_validation import validate_contributions
    from ouroboros.extension_contributions import project_contributions
    from ouroboros import extension_registry_state, places
    manifest = parse_skill_manifest_text(json.dumps(dict(name='fixture-bridge', type='extension', description='Fixture', version='1', permissions=['presence'], contributes=[dict(
        id='place', provides='place', label='Сервис <&>', destination='vendor:chat', scope='account', wakes=['mention'],
        facts=[dict(id='mention', label='Упоминания <&>'), dict(id='any_message', label='Любое сообщение')], source=dict(route='status', refresh_s=60), **({'settings':'connection'} if '--connector-contract' in sys.argv else {}))])))
    clean, errors = validate_contributions(manifest)
    assert not errors, errors
    declaration = project_contributions('fixture-bridge', clean, 'fixture-revision')
    extension_registry_state.live_contribution_projection = lambda: declaration
    from ouroboros.presence_admission import admit_presence_turn
    from ouroboros.presence_runner import capture_presence_event, PresenceTurnEvent
    from ouroboros.place_intake import settle_heard
    import asyncio
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    from ouroboros.gateway.router import collect_routes
    audit = []
    status_mode={"value":""}
    status_wire=[]
    settings_wire=[];settings_state={"endpoint":"saved fixture endpoint"}
    captured = None
    fail_next = False
    projection = {"mode":"", "target":"list"}
    barrier={"value":None}
    async def status(request):
        value=dict(ok=True, account_id=request.query_params.get('account_id',''), text='Готово <&>',
            connect=[dict(account_id='fixture-account', conversation_id='fixture-room', label='Комната <&>')],
            identity=dict(sends_as=dict(id='person', label='Владелец <&>', kind='user'), reads_as=[]))
        mode=status_mode['value']
        sender=value['identity']['sends_as']
        if mode=='bad-reader':value['identity']['reads_as']=[dict(id='reader',label=[],kind='user')]
        elif mode=='identity-root':value['identity']=[]
        elif mode=='identity-extra':value['identity']['owner']=True
        elif mode=='sender-extra':sender['owner']=True
        elif mode=='sender-missing':sender.pop('kind')
        elif mode=='sender-null':value['identity']['sends_as']=None
        elif mode=='sender-kind':sender['kind']='future-kind'
        elif mode=='sender-id':sender['id']=' '
        elif mode=='sender-label':sender['label']=[]
        elif mode=='sender-long':sender['label']='x'*201
        elif mode=='emoji-long':sender['label']='😀'*201
        elif mode=='readers-root':value['identity']['reads_as']={}
        elif mode=='reader-null':value['identity']['reads_as']=[None]
        elif mode=='reader-extra':value['identity']['reads_as']=[dict(id='reader',label='Reader',kind='user',owner=True)]
        elif mode=='split':value['identity']['reads_as']=[dict(id='reader',label='Reader <&>',kind='user')]
        elif mode=='bot':sender['kind']='bot'
        elif mode=='emoji':sender['label']='😀'*200
        elif mode=='long-valid':sender['label']='x'*200
        elif mode=='legacy':value.pop('account_id')
        elif mode=='no-identity':value.pop('identity')
        elif mode=='wrong-account':value['account_id']='neighbor-account'
        elif mode=='bad-text':value['text']=[]
        elif mode=='bad-root':
            status_wire.append({'account_id':request.query_params.get('account_id'),'mode':mode,'identity_valid':None})
            return JSONResponse([])
        elif mode=='additive':value.update(ok='plugin-owned-value',fixture_extra={'preserve':True})
        elif mode=='bad-labels':value['labels']={'mention':'MUST NOT APPLY PARTIAL LABEL','any_message':[]}
        elif mode=='labels':value['labels']={'mention':'Private status wake <&>'}
        elif mode=='absent':value.pop('connect')
        elif mode=='empty':value['connect']=[]
        elif mode=='malformed':value['connect']={}
        elif mode=='invalid-rows':value['connect']=[None,dict(account_id=None,conversation_id='',label='Not a wildcard')]
        elif mode=='mixed':value['connect']=[None,dict(account_id=None,conversation_id='',label='Not a wildcard'),
            dict(account_id='first-choice',conversation_id='same-label-room',label='Identical label <&>'),
            dict(account_id='second-choice',conversation_id='different-room',label='Identical label <&>'),
            dict(account_id='broad-choice',conversation_id='',label='Explicit account-wide Ω')]
        elif mode=='http':return JSONResponse({'error':'fixture status unavailable'},status_code=503)
        valid=None
        if 'identity' in value:
            try:places.validate_presence_identity(value['identity']);valid=True
            except ValueError:valid=False
        status_wire.append({'account_id':request.query_params.get('account_id'), 'mode':mode, 'identity_valid':valid})
        return JSONResponse(value)
    async def set_status(request):
        status_mode['value']=(await request.json()).get('mode','')
        return JSONResponse({'ok':True})
    if '--connector-contract' in sys.argv:
        from ouroboros import extension_loader
        from ouroboros.extension_plugin_api import PluginAPIImpl
        from ouroboros.extension_registry_state import _PluginAPIConfig
        async def settings_handler(request):
            endpoint=request.url.path.rsplit('/',1)[-1]
            body=await request.json() if request.method=='POST' else {}
            settings_wire.append({'method':request.method,'path':endpoint,'body':body})
            if request.method=='GET':return settings_state if endpoint=='connection' else {'unrelated':'must not hydrate'}
            settings_state.update(body)
            return {'message':'Fixture connection saved <&>'}
        api=PluginAPIImpl(_PluginAPIConfig(skill_name='fixture-bridge',permissions=['widget','route'],env_allowlist=[],state_dir=data/'plugin',settings_reader=lambda:{},drive_root=data))
        for section in ('connection','unrelated'):
            api.register_route(section,settings_handler,methods=['GET','POST'])
            api.register_settings_section(section,'Fixture '+section,schema={'components':[{'type':'form','route':section,'fields':[{'name':'endpoint' if section=='connection' else 'unrelated','type':'text','label':'Endpoint' if section=='connection' else 'Unrelated field'}],'submit_label':'Save '+section}]})
        api._publish_registrations(content_hash='fixture-reviewed-hash')
        extension_loader.runtime_state_for_skill_name=lambda *args,**kwargs:{'desired_live':True,'live_loaded':True}
    async def capture(request):
        nonlocal captured
        body=await request.json()
        p = next((p for p in places.load_places(data) if p.place_id==body.get("place_id")), places.load_places(data)[0])
        event = PresenceTurnEvent('fixture-arrival', 'chat', p.account_id, p.conversation_id, '', 'chat:'+p.account_id+':'+p.conversation_id,
            {'platform_actor_id':'person'}, {'title':'Комната истории <&>'}, {}, 'Сообщение комнаты <&>', facts=())
        admission = admit_presence_turn(drive_root=data, authenticated_transport_skill='fixture-bridge', provider='chat', account_id=p.account_id, conversation_id=p.conversation_id)
        task = capture_presence_event(admission, event, drive_root=data)
        settle_heard(data, task, event, 'no_wake_match')
        captured = dict(chat_id=task['chat_id'], task_id=task['id'])
        return JSONResponse(captured)
    async def facts(request):
        return JSONResponse(dict(places=[places.place_summary(p) for p in places.load_places(data)], audit=audit, status_wire=status_wire, settings_wire=settings_wire, settings_state=settings_state, captured=captured, held=bool(barrier["value"] and barrier["value"]["ready"] and not barrier["value"]["event"].is_set())))
    async def fault(request):
        nonlocal fail_next
        fail_next = True
        return JSONResponse({'ok': True})
    async def lifetime(request):
        body=await request.json()
        if body.get('action')=='hold':barrier['value']={'path':body['path'],'method':body.get('method','GET'),'ready':False,'event':asyncio.Event()}
        elif barrier['value']:barrier['value']['event'].set()
        return JSONResponse({'ok':True})
    async def project(request):
        body=await request.json();projection.update(mode=body.get('mode',''),target=body.get('target','list'))
        return JSONResponse({'ok':True})
    def corrupt(row, mode):
        if mode=='label':row['label']=[]
        elif mode=='state':row['state']={}
        elif mode=='revision':row['revision']=-1
        elif mode=='wakes':row['wakes']=[{'fact':[]}]
        elif mode=='notes':row['notes']=[{'text':[]}]
        elif mode=='owners':row['owner_accounts']=[{'platform_actor_id':{}}]
        elif mode=='candidates':row['account_candidates']=[{'platform_actor_id':1}]
        elif mode=='facts':row['facts']=[{'id':[]}]
        elif mode=='labels':row['labels']={'mention':[]}
        elif mode=='readiness':row['readiness']={'text':[]}
        elif mode=='source':row['source']=[]
        elif mode=='rooms':row['rooms']=[{'room_chat_id':'bad'}]
        elif mode=='count':row['unanswered']='3'
        elif mode=='cost':row['spent_24h_usd']='not-a-number'
        elif mode=='foreign':row['place_id']='foreign-place'
        elif mode=='future':row.update(state='future-state',fixture_extension={'keep':True})
        elif mode=='optional':
            for key in ('source','readiness','labels','facts','account_candidates','wake_suggestions','rooms','spent_24h_usd','unanswered'):row.pop(key,None)
    app = Starlette(routes=[Route('/fixture/facts', facts), Route('/fixture/capture', capture, methods=['POST']),
        Route('/fixture/fault', fault, methods=['POST']), Route('/fixture/status', set_status, methods=['POST']), Route('/fixture/lifetime', lifetime, methods=['POST']), Route('/fixture/projection', project, methods=['POST']),
        Route('/api/extensions/fixture-bridge/status', status), *collect_routes(data_dir=data)])
    app.state.drive_root = data
    app.state.repo_dir = repo
    class Observe:
        async def __call__(self, scope, receive, send):
            nonlocal fail_next
            record = dict(method=scope.get('method'), path=scope.get('path'))
            raw=bytearray()
            async def input():
                message=await receive();raw.extend(message.get('body',b''))
                if raw and not message.get('more_body'):
                    try:record['body']=json.loads(raw)
                    except ValueError:pass
                return message
            if scope['type'] == 'http' and not scope['path'].startswith('/fixture'):
                audit.append(record)
            if fail_next and scope.get('method') == 'POST' and scope.get('path', '').startswith('/api/places/'):
                fail_next = False
                messages = []
                async def hold(message):
                    messages.append(message)
                await app(scope, input, hold)
                record['upstream_status'] = messages[0]['status']
                if record['upstream_status'] == 200:
                    record['status'] = 503
                    await JSONResponse({'error': 'fixture response unavailable after update'}, status_code=503)(scope, receive, send)
                else:
                    record['status'] = record['upstream_status']
                    for message in messages:
                        await send(message)
                return
            pending=barrier['value']
            if pending and not pending['ready'] and scope['type']=='http' and scope.get('path')==pending['path'] and scope.get('method')==pending['method']:
                messages=[]
                async def collect_held(message):messages.append(message)
                await app(scope,input,collect_held);record['status']=messages[0]['status'];pending['ready']=True
                await pending['event'].wait()
                for message in messages:await send(message)
                return
            mode=projection['mode'];target=projection['target']
            selected=mode and scope['type']=='http' and (target=='list' and scope.get('method')=='GET' and scope.get('path')=='/api/places'
                or target in ('write','conflict') and scope.get('method')=='POST' and scope.get('path','').startswith('/api/places/'))
            if selected:
                messages=[]
                async def collect(message):messages.append(message)
                await app(scope,input,collect);record['status']=messages[0]['status']
                body=json.loads(b''.join(m.get('body',b'') for m in messages))
                if target=='list':
                    if mode=='root':body={'places':{},'connectors':[]}
                    elif mode=='duplicate':body['places'].append(dict(body['places'][0]))
                    elif mode=='mixed':body['places'][0]['label']='MUST NOT REPLACE SNAPSHOT';corrupt(body['places'][1],'notes')
                    elif mode=='connector':body['connectors'][0]['facts']=[None]
                    elif mode=='migration':body['migration_problems']={}
                    elif mode in ('missing-section','no-settings'):
                        body['connectors'][0]['settings']='missing' if mode=='missing-section' else ''
                    else:corrupt(body['places'][0],mode)
                elif target=='write' and record['status']==200 or target=='conflict' and record['status']==409:
                    if mode=='ok':body['ok']='true'
                    else:corrupt(body['place'],mode)
                return await JSONResponse(body,status_code=record['status'])(scope,receive,send)
            async def output(message):
                if message['type'] == 'http.response.start': record['status'] = message['status']
                await send(message)
            await app(scope, input, output)
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    (run / 'port').write_text(str(sock.getsockname()[1]))
    uvicorn.Server(uvicorn.Config(Observe(), log_level='warning')).run(sockets=[sock])

if __name__ == '__main__':
    main()
