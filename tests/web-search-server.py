def main():
    """Real built-in web-search route resolver; no provider calls or Settings writes."""
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

    import asyncio, copy
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    from ouroboros.gateway.settings import api_settings_get
    from ouroboros import search_routes
    seed=json.loads(config.SETTINGS_PATH.read_text())
    seed.update(OPENAI_API_KEY='fixture-openai',OPENROUTER_API_KEY='fixture-openrouter',ANTHROPIC_API_KEY='fixture-anthropic',
        OUROBOROS_WEBSEARCH_BACKEND='auto',OUROBOROS_WEBSEARCH_MODEL='',
        OUROBOROS_CONNECTIONS=[{'kind':'anthropic','name':'research','api_key':'fixture-named'}])
    config.SETTINGS_PATH.write_text(json.dumps(seed));initial=config.SETTINGS_PATH.read_bytes()
    packages={'anthropic':True,'ddgs':True};search_routes._package_discoverable=lambda name:packages.get(name,False)
    fault={'mode':''};audit=[];release=asyncio.Event();release.set()
    async def facts(request):return JSONResponse({'audit':audit,'settings_unchanged':config.SETTINGS_PATH.read_bytes()==initial,'defaults':search_routes.SEARCH_MODELS})
    async def control(request):
        body=await request.json()
        if body.get('action')=='hold':release.clear()
        elif body.get('action')=='release-all':release.set()
        elif body.get('action')=='fault':fault['mode']=body.get('mode','')
        elif body.get('action')=='packages':packages.update(body['values'])
        elif body.get('action')=='saved':
            config.SETTINGS_PATH.write_text(json.dumps({**seed,**body['values']}))
        return JSONResponse({'ok':True})
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),Route('/api/settings',api_settings_get)])
    app.state.drive_root=data;app.state.repo_dir=repo
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or scope['path']!='/api/settings':return await app(scope,receive,send)
            record={'method':scope['method'],'query':scope.get('query_string',b'').decode()};audit.append(record);messages=[]
            async def output(message):messages.append(message)
            await app(scope,receive,output)
            body=json.loads(b''.join(m.get('body',b'') for m in messages));record['reply']=copy.deepcopy(body);record['status']=messages[0]['status']
            mode=fault['mode']
            await release.wait()
            if mode=='fail':return await JSONResponse({'error':'Fixture route unavailable'},status_code=503)(scope,receive,send)
            if mode=='malformed':body['legs'].append(None)
            if mode=='foreign':body['model']='foreign-selection'
            await JSONResponse(body,status_code=record['status'])(scope,receive,send)
    sock=socket.socket();sock.bind(('127.0.0.1',0));(run/'port').write_text(str(sock.getsockname()[1]))
    uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])

if __name__=='__main__':main()
