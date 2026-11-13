def main():
    """Real interface-language/memory API with no generator or model execution."""
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

    from ouroboros import i18n_memory as memory
    def seed(doc):
        memory.apply_generated(doc, {f'String {i:03}': {'text': f'Перевод {i:03}'} for i in range(65)}, model='fixture/model')
        memory.set_owner_entry(doc, 'Settings', {'text':'Настройки владельца'})
        return doc
    memory.update_memory(data,'ru',seed,create=True)
    (run/'import.json').write_text(json.dumps(dict(schema=1, language='ru', pack='fixture', pack_version='1', entries={
        'Settings':{'text':'Импортированный вариант'}, 'Skills':{'text':'Навыки & 🔧'}}),ensure_ascii=False))
    from ouroboros.gateway import ui_i18n
    assert not ui_i18n._LANGUAGE_HOOKS
    import asyncio
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    from ouroboros.gateway.router import collect_routes
    audit=[]; fault={"read":"","hold":"","write":"","export":""}; release=asyncio.Event();release.set()
    async def facts(request):
        return JSONResponse(dict(settings=config.load_settings(), ru=memory.load_memory(data,'ru'),
            pending=memory.pending_count(data,'ru'), audit=audit))
    async def advance(request):
        def update(doc):
            memory.set_owner_entry(doc,'Native updated',{'text':'Обновлённый перевод'})
            return doc
        updated=memory.update_memory(data,'ru',update)
        return JSONResponse({'revision':updated['revision']})
    async def control(request):
        body=await request.json()
        if body.get('action')=='release-all':fault['hold']='';release.set()
        if 'hold' in body:fault['hold']=body['hold'];release.clear()
        if 'read' in body:fault['read']=body['read']
        if 'write' in body:fault['write']=body['write']
        if 'export' in body:fault['export']=body['export']
        return JSONResponse({'ok':True})
    app=Starlette(routes=[Route('/fixture/control',control,methods=['POST']),Route('/fixture/facts',facts),Route('/fixture/advance',advance,methods=['POST']),*collect_routes(data_dir=data)])
    app.state.drive_root=data
    app.state.repo_dir=repo
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or not scope['path'].startswith('/api/ui/i18n'):return await app(scope,receive,send)
            record=dict(method=scope['method'],path=scope['path']);audit.append(record)
            original_receive = receive
            chunks = []
            async def receive():
                message = await original_receive()
                if message['type'] == 'http.request':
                    chunks.append(message.get('body', b''))
                    if not message.get('more_body'):
                        try: record['body'] = json.loads(b''.join(chunks))
                        except Exception: pass
                return message
            mode=fault['read']; held=fault['hold']==scope['path']; messages=[]
            if scope['method']=='GET' and scope['path']=='/api/ui/i18n':
                async def capture(message):messages.append(message)
                await app(scope,receive,capture);record['status']=messages[0]['status']
                body=json.loads(b''.join(m.get('body',b'') for m in messages))
                if held:await release.wait()
                if mode=='http':return await JSONResponse({'error':'Fixture dictionary read unavailable'},status_code=503)(scope,receive,send)
                if mode=='plural':body['plural_categories']={}
                elif mode=='profile':body['profile']={'label':[]}
                elif mode=='entry':body['entries']['Settings']={'text':['wrong']}
                elif mode=='forms':body['entries']['Settings']={'forms':{'one':[]}}
                elif mode=='language':body['languages']=[{'language':'ru','label':[]}]
                elif mode=='stats':body['stats']['pending']='2'
                elif mode=='generator':body['generator']['in_flight']='2'
                return await JSONResponse(body,status_code=record['status'])(scope,receive,send)
            if scope['method']=='GET' and scope['path'].endswith('/export') and fault['export']:
                async def capture_export(message):messages.append(message)
                await app(scope,receive,capture_export);record['status']=messages[0]['status']
                body=json.loads(b''.join(m.get('body',b'') for m in messages))
                if fault['export']=='foreign':body['language']='fr'
                elif fault['export']=='profile':body['profile']['lexicon']=[]
                return await JSONResponse(body,status_code=record['status'])(scope,receive,send)
            if scope['method']=='POST' and fault['write'] and (scope['path'].endswith('/import') or scope['path'].endswith('/language')):
                async def capture_write(message):messages.append(message)
                await app(scope,receive,capture_write);record['status']=messages[0]['status']
                assert record['status']==200, messages
                if fault['write']=='after':return await JSONResponse({'error':'Fixture acknowledgement lost after import'},status_code=503)(scope,receive,send)
                body=json.loads(b''.join(m.get('body',b'') for m in messages));body['language']='fr'
                return await JSONResponse(body,status_code=messages[0]['status'])(scope,receive,send)
            async def output(message):
                if message['type']=='http.response.start':record['status']=message['status']
                if held and scope['path'].endswith('/export') and message['type']=='http.response.body' and message.get('body'):
                    content=message['body'];middle=max(1,len(content)//2)
                    await send({**message,'body':content[:middle],'more_body':True});record['stream_started']=True
                    await release.wait()
                    return await send({**message,'body':content[middle:]})
                await send(message)
            await app(scope,receive,output)
    sock=socket.socket()
    sock.bind(('127.0.0.1',0))
    (run/'port').write_text(str(sock.getsockname()[1]))
    uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])

if __name__=='__main__':
    main()
