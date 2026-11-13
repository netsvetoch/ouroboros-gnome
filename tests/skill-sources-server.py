def main():
    """Real skill-source CRUD, probes and Git refresh in a temporary installation."""
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
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    from ouroboros.gateway.router import collect_routes
    from ouroboros.skill_source_catalog import refresh_source
    from ouroboros.skill_sources import load_sources
    from tests._skill_source_fixtures import HubFixture,write_skill,join_source_refreshes,git,commit_all,publish
    hub=HubFixture(run/'hub');hub.add_hosted('fixture',official=True);hub.commit()
    rows=hub.rows()[1:];rows[0].update(confirmed=False,managed=True)
    local=run/'local';write_skill(local,'local_fixture',body='Local payload <&> 🔧')
    work=run/'git-work';work.mkdir();git('init','-q',cwd=work)
    write_skill(work/'nested','git_fixture',body='Git payload <&> 🔧');commit=commit_all(work)
    bare=run/'plain.git';publish(work,bare)
    seed=json.loads(config.SETTINGS_PATH.read_text());seed.update(OUROBOROS_SKILL_SOURCES=json.dumps(rows),GITHUB_TOKEN='')
    config.SETTINGS_PATH.write_text(json.dumps(seed));refresh_source(data,rows[0]);initial=config.SETTINGS_PATH.read_bytes()
    (repo/'skills').mkdir();(repo/'skills/builtin.json').write_text('{"schema_version":1,"skills":[]}')
    fault={'before':False,'after':False,'read':False};audit=[]
    probe_release=asyncio.Event();probe_release.set();write_release=asyncio.Event();write_release.set()
    async def facts(request):return JSONResponse({'audit':audit,'sources':load_sources(),
      'local':str(local),'url':bare.as_uri(),'commit':commit,'local_payload':(local/'local_fixture/SKILL.md').read_text(),
      'settings':json.loads(config.SETTINGS_PATH.read_text())})
    async def control(request):
        nonlocal commit
        action=(await request.json())['action']
        if action=='release-all':probe_release.set();write_release.set()
        elif action=='hold-probe':probe_release.clear()
        elif action=='hold-write':write_release.clear()
        elif action=='before':fault['before']=True
        elif action=='after':fault['after']=True
        elif action=='read-fail':fault['read']=True
        elif action=='new-commit':
            write_skill(work/'nested','git_fixture','2.0.0');commit=commit_all(work);publish(work,bare)
        return JSONResponse({'ok':True})
    @contextlib.asynccontextmanager
    async def lifespan(app):
        try:yield
        finally:probe_release.set();write_release.set();join_source_refreshes()
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),*collect_routes(data_dir=data)],lifespan=lifespan)
    app.state.drive_root=data;app.state.repo_dir=repo
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or not scope['path'].startswith('/api/'):return await app(scope,receive,send)
            raw=bytearray();messages=[];record={'method':scope['method'],'path':scope['path']};audit.append(record)
            async def input():
                message=await receive();raw.extend(message.get('body',b''));return message
            async def output(message):messages.append(message)
            writing=scope['method']=='POST' and scope['path'].startswith('/api/skill-sources') and not scope['path'].endswith('/probe')
            if writing and fault['before']:
                fault['before']=False;await input();record['body']=json.loads(raw or b'{}');record['status']=503
                return await JSONResponse({'error':'fixture before acceptance'},status_code=503)(scope,receive,send)
            await app(scope,input,output)
            if raw:record['body']=json.loads(raw)
            record['status']=messages[0]['status']
            try:record['reply']=json.loads(b''.join(m.get('body',b'') for m in messages))
            except Exception:pass
            if scope['path'].endswith('/probe'):await probe_release.wait()
            if writing:
                await write_release.wait()
                if fault['after']:
                    fault['after']=False
                    return await JSONResponse({'error':'fixture after acceptance'},status_code=503)(scope,receive,send)
            if scope['path']=='/api/skill-sources' and scope['method']=='GET' and fault['read']:
                fault['read']=False
                return await JSONResponse({'error':'fixture unavailable'},status_code=503)(scope,receive,send)
            for message in messages:await send(message)
    sock=socket.socket();sock.bind(('127.0.0.1',0));(run/'port').write_text(str(sock.getsockname()[1]))
    uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])

if __name__=='__main__':main()

