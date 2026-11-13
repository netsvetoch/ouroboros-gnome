def main():
    """Real daemon snapshot/CompanionSupervisor with owned inert child processes only."""
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

    import asyncio,contextlib,copy,time
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    from ouroboros.extension_companion import CompanionDescriptor,init_global_supervisor
    from ouroboros.gateway.extensions import api_skill_daemons
    supervisor=init_global_supervisor(data)
    # Keep completed runtimes addressable for deterministic UI polling.
    # Start/snapshot/stop and the Popen exit codes remain real.
    supervisor._start_monitor=lambda key,runtime:None
    descriptors=[CompanionDescriptor('alpha','worker <&>',[sys.executable,'-c','import time;time.sleep(120)'],run,{},restart_policy='never'),
        CompanionDescriptor('beta','finished',[sys.executable,'-c','raise SystemExit(7)'],run,{},restart_policy='on_failure',max_restarts=0),
        CompanionDescriptor('gamma','signal',[sys.executable,'-c','import time;time.sleep(120)'],run,{},restart_policy='on_failure',max_restarts=0)]
    for descriptor in descriptors:assert supervisor.start(descriptor)
    descriptors[0].ports=[32123]  # declaration only; no port is bound or killed
    for _ in range(100):
        if supervisor.snapshot().get('beta:finished',{}).get('returncode')==7:break
        time.sleep(.01)
    audit=[];release=asyncio.Event();release.set();fault={'mode':''};initial=config.SETTINGS_PATH.read_bytes()
    async def facts(request):return JSONResponse({'audit':audit,'snapshot':supervisor.snapshot(),'settings_unchanged':config.SETTINGS_PATH.read_bytes()==initial})
    async def control(request):
        body=await request.json();action=body['action']
        if action=='hold':release.clear()
        elif action=='release-all':release.set()
        elif action=='fault':fault['mode']=body.get('mode','')
        elif action=='signal':supervisor._runtimes['gamma:signal'].process.terminate()
        elif action=='retiring':supervisor._runtimes['alpha:worker <&>'].retiring='Fixture stop pending <&>' if body.get('value',True) else ''
        elif action=='stop-alpha':
            descriptors[0].ports=[]
            await asyncio.to_thread(supervisor.stop,'alpha','worker <&>',1)
        return JSONResponse({'ok':True})
    @contextlib.asynccontextmanager
    async def lifespan(app):
        try:yield
        finally:
            release.set()
            for descriptor in descriptors:descriptor.ports=[]
            await asyncio.to_thread(supervisor.stop_all,1)
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),Route('/api/skills/daemons',api_skill_daemons)],lifespan=lifespan)
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or not scope['path'].startswith('/api/'):return await app(scope,receive,send)
            record={'method':scope['method'],'path':scope['path']};audit.append(record);messages=[]
            async def output(message):messages.append(message)
            await app(scope,receive,output);body=__import__('json').loads(b''.join(m.get('body',b'') for m in messages));record['reply']=copy.deepcopy(body)
            await release.wait()
            if fault['mode']=='fail':return await JSONResponse({'error':'Fixture snapshot unavailable'},status_code=503)(scope,receive,send)
            if fault['mode']=='malformed':body['companions']['alpha:worker <&>']['ports']=['invalid-port']
            await JSONResponse(body,status_code=messages[0]['status'])(scope,receive,send)
    sock=socket.socket();sock.bind(('127.0.0.1',0));(run/'port').write_text(str(sock.getsockname()[1]));uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])

if __name__=='__main__':main()
