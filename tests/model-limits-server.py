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

    import asyncio
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    from ouroboros.gateway.router import collect_routes
    from ouroboros import capability_evidence as evidence
    initial=json.loads(config.SETTINGS_PATH.read_text())
    initial.update(OPENAI_COMPATIBLE_API_KEY='fixture-route-key',OPENAI_COMPATIBLE_BASE_URL='http://127.0.0.1:9/route-a/v1')
    config.SETTINGS_PATH.write_text(json.dumps(initial));expected={'bytes':config.SETTINGS_PATH.read_bytes()}
    audit=[];fault={'hold':None,'lose':False,'read_fail':False,'mismatch':False}
    async def facts(request):return JSONResponse({'audit':audit,'evidence':evidence._read(data),'settings_unchanged':config.SETTINGS_PATH.read_bytes()==expected['bytes'],
      'held':bool(fault['hold'] and fault['hold']['ready'])})
    async def control(request):
        body=await request.json();action=body['action']
        if action=='route':
            current=json.loads(config.SETTINGS_PATH.read_text());current['OPENAI_COMPATIBLE_BASE_URL']='http://127.0.0.1:9/'+body['route']+'/v1'
            config.SETTINGS_PATH.write_text(json.dumps(current));expected['bytes']=config.SETTINGS_PATH.read_bytes()
        elif action=='lose':fault['lose']=True
        elif action=='read-fail':fault['read_fail']=True
        elif action=='mismatch':fault['mismatch']=True
        elif action=='preview':fault['preview']=body['body']
        elif action=='hold':fault['hold']={'kind':body.get('kind','read'),'event':asyncio.Event(),'ready':False}
        elif action=='release':fault['hold']['event'].set()
        return JSONResponse({'ok':True})
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),*collect_routes(data_dir=data)])
    app.state.drive_root=data;app.state.repo_dir=repo
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or not scope['path'].startswith('/api/'):return await app(scope,receive,send)
            raw=bytearray();messages=[];record={'method':scope['method'],'path':scope['path'],'query':scope.get('query_string',b'').decode()}
            async def input():
                message=await receive();raw.extend(message.get('body',b''));return message
            async def output(message):messages.append(message)
            pending=fault['hold'];kind='write' if scope['method']=='POST' else 'read'
            if pending and pending['kind']==kind and not pending['ready']:
                pending['ready']=True;await pending['event'].wait()
            await app(scope,input,output)
            if raw:record['body']=json.loads(raw)
            record['status']=messages[0]['status'];record['actor']=dict(scope.get('headers',[])).get(b'x-ouroboros-actor',b'').decode()
            try:record['reply']=json.loads(b''.join(m.get('body',b'') for m in messages))
            except Exception:pass
            audit.append(record)
            if scope['method']=='POST' and fault['mismatch']:
                fault['mismatch']=False
                reply=json.loads(json.dumps(record['reply']));reply['ack']['note']='fixture mismatched annotation'
                return await JSONResponse(reply)(scope,receive,send)
            if scope['method']=='POST' and fault['lose']:
                fault['lose']=False
                return await JSONResponse({'error':'fixture lost acknowledged response'},status_code=503)(scope,receive,send)
            if scope['method']=='GET' and fault['read_fail']:
                fault['read_fail']=False
                return await JSONResponse({'error':'fixture preview unavailable'},status_code=503)(scope,receive,send)
            if scope['method']=='GET' and 'preview' in fault:
                return await JSONResponse(fault.pop('preview'))(scope,receive,send)
            for message in messages:await send(message)
    sock=socket.socket();sock.bind(('127.0.0.1',0));(run/'port').write_text(str(sock.getsockname()[1]))
    uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])

if __name__=='__main__':main()
