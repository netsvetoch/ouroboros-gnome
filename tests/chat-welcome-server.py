def main():
    """Real preferences/history with deterministic unavailable/partial/delayed reads; no model execution."""
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

    queue.publish_queue_snapshot(reason='welcome_fixture')
    import asyncio
    from ouroboros import dialogue_store
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route, WebSocketRoute
    from ouroboros.gateway.router import collect_routes
    from ouroboros.gateway.history import make_chat_history_endpoint
    from ouroboros.gateway.ui_preferences import api_ui_preferences_get
    mode='normal'
    peers=set()
    original_history=make_chat_history_endpoint(data)
    async def history(request):
        if mode=='delayed': await asyncio.sleep(.4)
        if mode=='failed': return JSONResponse({'error':'fixture history unavailable'},status_code=503)
        response=await original_history(request)
        if mode=='partial' and response.status_code==200:
            body=json.loads(response.body)
            body['window'].update(complete=False,truncated_by=['chat_importing'])
            return JSONResponse(body)
        return response
    async def preferences(request):
        if mode=='preferences_failed': return JSONResponse({'error':'fixture preferences unavailable'},status_code=503)
        return await api_ui_preferences_get(request)
    async def control(request):
        nonlocal mode
        mode=(await request.json())['mode']
        return JSONResponse({'ok':True})
    async def append(request):
        row=dict(direction='out',chat_id=1,user_id=1,text='Настоящее сообщение',ts='2026-11-12T00:00:00Z')
        dialogue_store.append(data,'chat',row,emit_live=False,feed=True)
        for peer in list(peers): await peer.send_json(dict(type='chat',role='assistant',chat_id=1,content=row['text'],ts=row['ts']))
        return JSONResponse({'ok':True})
    async def facts(request):
        return JSONResponse({'rows':len(dialogue_store.whole_rows(data,dialogue_store.newest(data,'chat',limit=100)))})
    async def ws(peer):
        await peer.accept();peers.add(peer)
        try:
            while True:
                frame=await peer.receive_json()
                if frame.get('type')=='ping': await peer.send_json({'type':'pong'})
        except Exception: pass
        finally: peers.discard(peer)
    routes=[route for route in collect_routes(data_dir=data) if getattr(route,'path','') not in {'/ws','/api/chat/history'}
        and not (getattr(route,'path','')=='/api/ui/preferences' and 'GET' in getattr(route,'methods',set()))]
    app=Starlette(routes=[WebSocketRoute('/ws',ws),Route('/api/chat/history',history),Route('/api/ui/preferences',preferences),
        Route('/fixture/mode',control,methods=['POST']),Route('/fixture/append',append,methods=['POST']),Route('/fixture/facts',facts),*routes])
    app.state.drive_root=data
    app.state.repo_dir=repo
    sock=socket.socket();sock.bind(('127.0.0.1',0))
    (run/'port').write_text(str(sock.getsockname()[1]))
    uvicorn.Server(uvicorn.Config(app,log_level='warning')).run(sockets=[sock])

if __name__=='__main__': main()
