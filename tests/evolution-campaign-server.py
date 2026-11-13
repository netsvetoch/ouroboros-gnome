def main():
    """Actual command admission; campaign state and asynchronous execution are controlled."""
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

    import copy
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    from ouroboros.gateway.control import api_command
    from ouroboros.server_liveness import BOOT
    from supervisor import message_bus
    admitted=[];audit=[];fault={'lost':False}
    class Bridge:
        def ui_send(self,cmd,**kwargs):admitted.append({'cmd':cmd,'kwargs':kwargs})
    message_bus.get_bridge=lambda:Bridge()
    state={'runtime_mode':'advanced','supervisor_ready':True,'evolution_enabled':False,'evolution_state':{'enabled':False,'status':'disabled','owner_chat_bound':True,'budget_remaining_usd':2.5}}
    async def facts(request):return JSONResponse({'admitted':admitted,'audit':audit,'boot':BOOT.snapshot(jobs=False)['since']})
    async def projection(request):return JSONResponse(state)
    async def control(request):
        body=await request.json()
        if body['action']=='state':state.clear();state.update(body['value'])
        elif body['action']=='lost':fault['lost']=True
        return JSONResponse({'ok':True})
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/state',projection),Route('/fixture/control',control,methods=['POST']),Route('/api/command',api_command,methods=['POST'])]);app.state.drive_root=data;app.state.repo_dir=repo
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or scope['path']!='/api/command':return await app(scope,receive,send)
            record={};audit.append(record);raw=bytearray();messages=[]
            async def input():message=await receive();raw.extend(message.get('body',b''));return message
            async def output(message):messages.append(message)
            await app(scope,input,output);record.update(body=json.loads(raw),status=messages[0]['status'])
            if fault['lost']:
                fault['lost']=False;return await JSONResponse({'error':'Fixture lost command receipt'},status_code=503)(scope,receive,send)
            for message in messages:await send(message)
    sock=socket.socket();sock.bind(('127.0.0.1',0));(run/'port').write_text(str(sock.getsockname()[1]));uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])

if __name__=='__main__':main()
