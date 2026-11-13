def main():
    """Real selected secret API in an isolated installation; no providers are contacted."""
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

    seed={"OPENAI_API_KEY":"builtin-synthetic-718", "NATIVE_CUSTOM_TOKEN":"  custom-🔧-934\n", 
      "OUROBOROS_CONNECTIONS":[{"kind":"openai","name":"extra","api_key":"named-synthetic-641"}],
      "MCP_SERVERS":[{"id":"fixture","transport":"streamable_http","url":"https://invalid.example/mcp",
        "auth_token":"mcp-token-synthetic-817","headers":{"X-Secret":"header-synthetic-356"}},
        {"id":"duplicate","auth_token":"one"},{"id":"duplicate","auth_token":"two"},
        {"id":"ambiguous","headers":{"X-Key":"one","x-key":"two"}},
        {"id":"malformed","headers":"unreadable"}]}
    current=json.loads(config.SETTINGS_PATH.read_text());current.update(seed);config.SETTINGS_PATH.write_text(json.dumps(current))
    import asyncio
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    from ouroboros.gateway.router import collect_routes
    audit=[];hold={"value":None}
    async def facts(request):
        return JSONResponse({"audit":audit,"held":bool(hold['value'] and hold['value']['ready']),
          "unchanged":all(json.loads(config.SETTINGS_PATH.read_text()).get(k)==v for k,v in seed.items())})
    async def control(request):
        body=await request.json()
        if body['action']=='hold':hold['value']={'ready':False,'event':asyncio.Event(),'fail':body.get('fail',False)}
        elif body['action']=='release':hold['value']['event'].set()
        return JSONResponse({'ok':True})
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),*collect_routes(data_dir=data)])
    app.state.drive_root=data;app.state.repo_dir=repo
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http':return await app(scope,receive,send)
            raw=bytearray();messages=[];record={'method':scope['method'],'path':scope['path']}
            async def input():
                message=await receive();raw.extend(message.get('body',b''));return message
            async def output(message):messages.append(message)
            await app(scope,input,output)
            if scope['path'].startswith('/api/'):
                if raw:record['body']=json.loads(raw)
                record['status']=messages[0]['status'];record['no_store']=dict(messages[0].get('headers',[])).get(b'cache-control')==b'no-store'
                audit.append(record)
            pending=hold['value']
            if scope['path']=='/api/settings/secret' and pending and not pending['ready']:
                pending['ready']=True;await pending['event'].wait()
                if pending['fail']:
                    return await JSONResponse({'error':'builtin-synthetic-718','code':'builtin-synthetic-718'},status_code=503)(scope,receive,send)
            for message in messages:await send(message)
    sock=socket.socket();sock.bind(('127.0.0.1',0));(run/'port').write_text(str(sock.getsockname()[1]))
    uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])

if __name__=='__main__':main()
