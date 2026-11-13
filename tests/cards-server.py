def main():
    """Real card store, pins/widgets and owner decisions; no worker execution."""
    import json
    import os
    import pathlib
    import socket
    import sys
    from types import SimpleNamespace

    run = pathlib.Path(sys.argv[1])
    lifetime_mode=len(sys.argv)>2 and sys.argv[2]=="lifetime"
    app_recovery_mode=len(sys.argv)>2 and sys.argv[2]=="app-recovery"
    app_runtime_mode=len(sys.argv)>2 and sys.argv[2] in ("app-runtime","app-recovery")
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

    from ouroboros.card_store import write_card, record_submission, load_card, pinned_cards, store_app_bytes
    from ouroboros.task_results import write_task_result
    from ouroboros.owner_mailbox import drain_owner_entries
    from ouroboros.gateway.cards import card_view
    write_task_result(data, 'card-author', 'scheduled', chat_id=1)
    workers.PENDING.append(dict(id='card-author', type='task', chat_id=1, root_task_id='card-author', _attempt=1))
    queue.publish_queue_snapshot(reason='card_fixture')
    def body(version):
        return {'components':[dict(type='markdown', text='Версия '+str(version)+' <&>'), dict(type='action', label='Действие', submit={'id':'choose'})]}
    card = write_card(data, chat_id=1, task_id='card-author', title='Карточка <&>', fallback_text='Запасной текст <&>', kind='components', body=body(1))
    for index in range(0 if lifetime_mode else 205):
        record_submission(data, card['card_id'], request_id=f'request-{index:03}', action_id='choose', label=f'Выбор {index:03}', values={'index':index}, once=False, revision=1)
    app_bytes = b'<!doctype html><title>Fixture</title><p>Inert source</p>'
    if app_runtime_mode:app_bytes=pathlib.Path('tests/card-app-fixture.html').read_bytes()
    app_card = write_card(data, chat_id=1, task_id='card-author', title='App', fallback_text='App fixture', kind='app', body={'app':store_app_bytes(data, app_bytes)})
    publication=None;hold_frames=[]
    if app_recovery_mode:
        from supervisor import state,message_bus
        from ouroboros.projects_registry import create_project
        from ouroboros.card_store import record_publication
        state.init(data,total_budget_limit=0)
        publication=create_project(data,'app-recovery-room',name='App recovery room <&>')
        record_publication(data,app_card['card_id'],publication['chat_id'])
        bridge=message_bus.LocalChatBridge();bridge._broadcast_fn=hold_frames.append
        message_bus.init(data,0,1000,bridge)
    import asyncio
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    from ouroboros.gateway.router import collect_routes
    audit=[];fault={'get':'','pin':'','decision':'','hold':'','method':'','app':''};release=asyncio.Event();release.set()
    async def control(request):
        body=await request.json()
        if body.get('action')=='seed-owed':record_submission(data,card['card_id'],request_id='lifetime-owed',action_id='choose',label='Stored owed',values={'stored':'exact'},once=False,revision=load_card(data,card['card_id'])['revision'])
        if body.get('action')=='release-all':fault['hold']='';release.set()
        for key in ('get','pin','decision','hold','method','app'):
            if key in body:fault[key]=body[key]
        if body.get('hold'):release.clear()
        return JSONResponse({'ok':True})
    async def facts(request):
        return JSONResponse(dict(publication=publication,hold_frames=hold_frames,audit=audit,card=card_view(data,load_card(data,card['card_id'])), app=card_view(data,app_card), pins=pinned_cards(data),
            submissions=load_card(data,card['card_id'])['submissions'], mailbox=drain_owner_entries(data,'card-author',set())))
    async def replace(request):
        saved = write_card(data, chat_id=1, task_id='card-author', title='Карточка 2 <&>', fallback_text='Вторая версия', kind='components', body=body(2), replace=card['card_id'])
        return JSONResponse({'revision':saved['revision']})
    app = Starlette(routes=[Route('/fixture/control',control,methods=['POST']),Route('/fixture/facts',facts),Route('/fixture/replace',replace,methods=['POST']),*collect_routes(data_dir=data)])
    app.state.drive_root=data
    app.state.repo_dir=repo
    class Observe:
        async def __call__(self,scope,receive,send):
            path=scope.get('path','')
            if scope['type']!='http' or path.startswith('/fixture/') or not (app_runtime_mode or path.startswith('/api/cards/') or path in ('/api/widgets','/api/decisions')):
                return await app(scope,receive,send)
            record={'method':scope['method'],'path':path};audit.append(record);messages=[];raw=bytearray()
            held=fault['hold']==path and (not fault['method'] or fault['method']==scope['method'])
            mode=fault['decision'] if path=='/api/decisions' else fault['pin'] if path.endswith('/pin') else fault['get']
            async def input():
                message=await receive();raw.extend(message.get('body',b''));return message
            async def output(message):messages.append(message)
            await app(scope,input,output)
            record['status']=messages[0]['status']
            if raw:record['body']=json.loads(raw)
            if held:await release.wait()
            if app_runtime_mode and path.endswith('/app') and fault['app']:
                from starlette.responses import Response
                if fault['app']=='missing':return await Response(status_code=404)(scope,receive,send)
                wire=app_bytes if fault['app']=='mime' else bytes([app_bytes[0]^1])+app_bytes[1:]
                return await Response(wire,media_type='text/html' if fault['app']=='mime' else 'text/plain')(scope,receive,send)
            if mode and (path=='/api/decisions' or path.endswith('/pin')):
                assert record['status'] in (200,202), messages
                if mode=='after':return await JSONResponse({'error':'Fixture lost acknowledgement'},status_code=503)(scope,receive,send)
                body=json.loads(b''.join(m.get('body',b'') for m in messages))
                if mode=='empty':body={}
                elif mode=='foreign':body['request_id' if path=='/api/decisions' else 'card_id']='foreign'
                elif mode=='delivery':body['delivery']=['delivered']
                return await JSONResponse(body)(scope,receive,send)
            if mode.startswith('pins-') and path=='/api/widgets':
                body=json.loads(b''.join(m.get('body',b'') for m in messages));pin=next(tab for tab in body['ui_tabs'] if tab.get('pinned_card'))
                if mode=='pins-row':body['ui_tabs'].append(None)
                elif mode=='pins-title':pin['title']=[]
                elif mode=='pins-revision':pin['revision']='-1'
                elif mode=='pins-components':pin['render']['components']={}
                return await JSONResponse(body)(scope,receive,send)
            if mode and path=='/api/cards/'+card['card_id'] and scope['method']=='GET':
                body=json.loads(b''.join(m.get('body',b'') for m in messages))
                if mode=='http':return await JSONResponse({'error':'Fixture read unavailable'},status_code=503)(scope,receive,send)
                if mode=='identity':body['card_id']='foreign'
                elif mode=='title':body['title']=[]
                elif mode=='revision':body['revision']=-1
                elif mode=='older':body['revision']=1
                elif mode=='summary':body['submissions_summary']=[{'request_id':'bad','action_id':'choose','delivery':'unknown'}]
                elif mode=='dropped':body['submissions_dropped']='5'
                elif mode=='components':body['components']={}
                elif mode=='data':body['data']=[]
                elif mode=='duplicate':body['submissions_summary']=[{'request_id':'repeat','action_id':'choose','delivery':'owed'}]*2
                return await JSONResponse(body)(scope,receive,send)
            for message in messages:await send(message)
    sock=socket.socket()
    sock.bind(('127.0.0.1',0))
    (run/'port').write_text(str(sock.getsockname()[1]))
    uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])

if __name__=='__main__':
    main()
