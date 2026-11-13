def main():
    """Real local-model APIs and manager, with a test process at the runtime boundary."""
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
    import contextlib
    import threading
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    from ouroboros.gateway.router import collect_routes
    from ouroboros import local_model

    os.environ['LOCAL_MODEL_FIXTURE_RUN']=str(run)
    shim=run/'shim';package=shim/'llama_cpp';package.mkdir(parents=True)
    (package/'__init__.py').write_text("import os, pathlib\nif not (pathlib.Path(os.environ['LOCAL_MODEL_FIXTURE_RUN'])/'runtime-installed').exists(): raise ImportError('Fixture runtime missing')\n")
    os.environ['PYTHONPATH']=str(shim)+os.pathsep+os.environ.get('PYTHONPATH','')
    source=run/'model <&> 🔧.gguf';source.write_bytes(b'fixture model boundary, no weights')
    with socket.socket() as probe:probe.bind(('127.0.0.1',0));model_port=probe.getsockname()[1]
    seed=json.loads(config.SETTINGS_PATH.read_text());seed.update(LOCAL_MODEL_SOURCE=str(source),LOCAL_MODEL_PORT=model_port,
      LOCAL_MODEL_N_GPU_LAYERS=-1,LOCAL_MODEL_CONTEXT_LENGTH=0,LOCAL_MODEL_CHAT_FORMAT='',USE_LOCAL_MAIN=False,USE_LOCAL_LIGHT=False)
    config.SETTINGS_PATH.write_text(json.dumps(seed));initial=config.SETTINGS_PATH.read_bytes()
    mgr=local_model.get_manager();fault={'before':False,'after':False,'status':'','status_error':False};audit=[];launches=[]
    install_release=threading.Event();start_release=asyncio.Event();start_release.set()
    real_popen=local_model.subprocess.Popen
    class FixtureProcess(real_popen):
        def __init__(self,cmd,*args,**kwargs):
            if isinstance(cmd,list) and len(cmd)>2 and cmd[1:3]==['-m','ouroboros.local_model_server']:
                launches.append(cmd[3:]);cmd=[cmd[0],str(pathlib.Path('tests/local-model-process.py').resolve()),*cmd[3:]]
            super().__init__(cmd,*args,**kwargs)
    local_model.subprocess.Popen=FixtureProcess
    def install():
        mgr._runtime_install_log='Fixture install <&> 🔧\nWaiting at runtime boundary'
        while not install_release.wait(.05):
            if mgr._install_cancelled.is_set():mgr._runtime_status='missing';return
        if mgr._install_cancelled.is_set():mgr._runtime_status='missing';return
        (run/'runtime-installed').write_text('fixture shim only');mgr._runtime_status='install_ok'
    mgr._run_install=install
    status_dict=mgr.status_dict
    def status():
        if fault['status_error']:
            fault['status_error']=False;raise RuntimeError('fixture status failed')
        return status_dict()
    mgr.status_dict=status
    async def facts(request):
        return JSONResponse({'audit':audit,'launches':launches,'source':str(source),'port':model_port,
          'wire':[json.loads(line) for line in (run/'wire.jsonl').read_text().splitlines()] if (run/'wire.jsonl').exists() else [],
          'status':status_dict(),'settings_application':mgr.settings_application(seed),'pid':mgr._proc.pid if mgr._proc else None,
          'settings_unchanged':config.SETTINGS_PATH.read_bytes()==initial})
    async def control(request):
        action=(await request.json())['action']
        if action=='install-release':install_release.set()
        elif action=='status-error':fault['status_error']=True
        elif action=='before':fault['before']=True
        elif action=='after':fault['after']=True
        elif action=='malformed':fault['status']='malformed'
        elif action=='status-fail':fault['status']='fail'
        elif action=='status-clear':fault['status']=''
        elif action=='hold-start':start_release.clear()
        elif action=='release-start':start_release.set()
        elif action=='text-only':(run/'probe-mode').write_text('text-only')
        return JSONResponse({'ok':True})
    @contextlib.asynccontextmanager
    async def lifespan(app):
        try:yield
        finally:install_release.set();mgr.stop_server()
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),*collect_routes(data_dir=data)],lifespan=lifespan)
    app.state.drive_root=data;app.state.repo_dir=repo
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or not scope['path'].startswith('/api/'):return await app(scope,receive,send)
            record={'method':scope['method'],'path':scope['path']};audit.append(record);raw=bytearray();messages=[]
            async def input():
                message=await receive();raw.extend(message.get('body',b''));return message
            async def output(message):messages.append(message)
            if scope['path']=='/api/local-model/start' and fault['before']:
                fault['before']=False
                message=await input();record['body']=json.loads(raw);record['status']=503
                return await JSONResponse({'error':'fixture before acceptance'},status_code=503)(scope,receive,send)
            await app(scope,input,output)
            if raw:record['body']=json.loads(raw)
            record['status']=messages[0]['status']
            try:record['reply']=json.loads(b''.join(m.get('body',b'') for m in messages))
            except Exception:pass
            if scope['path']=='/api/local-model/status' and fault['status']:
                return await JSONResponse({} if fault['status']=='malformed' else {'error':'fixture unavailable'},status_code=200 if fault['status']=='malformed' else 503)(scope,receive,send)
            if scope['path']=='/api/local-model/start':
                await start_release.wait()
                if fault['after']:
                    fault['after']=False
                    return await JSONResponse({'error':'fixture after acceptance'},status_code=503)(scope,receive,send)
            for message in messages:await send(message)
    sock=socket.socket();sock.bind(('127.0.0.1',0));(run/'port').write_text(str(sock.getsockname()[1]))
    uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])

if __name__=='__main__':main()

