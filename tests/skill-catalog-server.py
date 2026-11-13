def main():
    """Real catalog, local Git source transport and lifecycle installation in temporary data."""
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
    from ouroboros.skill_install_record import read_install_record
    from tests._skill_source_fixtures import HubFixture,write_skill,join_source_refreshes
    hub=HubFixture(run/'source')
    for i in range(74):hub.add_hosted(f'fixture_{i:03}',official=True,recommended=i%10==0,
      category=['city' if i%2==0 else 'writing'],description=f'Fixture seven {i} <&> 🔧',body=f'About fixture {i} <&> 🔧')
    hub.add_hosted('withdrawn',official=True,withdrawn={'reason':'Fixture withdrawn <&>'})
    hub.add_hosted('community',category=['writing']);hub.commit()
    rows=hub.rows()[1:]
    seed=json.loads(config.SETTINGS_PATH.read_text());seed.update(OUROBOROS_SKILL_SOURCES=json.dumps(rows))
    config.SETTINGS_PATH.write_text(json.dumps(seed));initial=config.SETTINGS_PATH.read_bytes()
    (repo/'skills').mkdir();(repo/'skills/builtin.json').write_text('{"schema_version":1,"skills":[]}')
    refresh_source(data,rows[0])
    fault={'catalog':False,'search':False,'before':False,'after':False,'extensions':''};audit=[]
    detail_release=asyncio.Event();detail_release.set();search_release=asyncio.Event();search_release.set();post_release=asyncio.Event();post_release.set()
    extensions_release=asyncio.Event();extensions_release.set();queue_release=asyncio.Event();queue_release.set()
    async def facts(request):
        from ouroboros.skill_lifecycle_queue import queue_snapshot
        return JSONResponse({'audit':audit,'settings_unchanged':config.SETTINGS_PATH.read_bytes()==initial,
          'queue':queue_snapshot(),
          'installed':{name:read_install_record(data,name) for name in ('fixture_000','fixture_001','fixture_003','fixture_004')},
          'payloads':{p.name:(p/'SKILL.md').read_text() for p in (data/'skills/ouroboroshub').glob('fixture_*') if (p/'SKILL.md').exists()},
          'backups':{str(p.relative_to(data)):(p/'SKILL.md').read_text() for p in (data/'skills/external/.rollback').glob('fixture_001*') if (p/'SKILL.md').exists()}})
    async def control(request):
        body=await request.json();action=body['action']
        if action=='release-all':detail_release.set();search_release.set();post_release.set();extensions_release.set();queue_release.set()
        elif action=='hold-detail':detail_release.clear()
        elif action=='hold-search':search_release.clear()
        elif action=='catalog-fail':fault['catalog']=True
        elif action=='search-fail':fault['search']=True
        elif action=='before':fault['before']=True
        elif action=='after':fault['after']=True
        elif action=='hold-post':post_release.clear()
        elif action=='hold-extensions':extensions_release.clear()
        elif action=='hold-queue':queue_release.clear()
        elif action=='extensions-fail':fault['extensions']='fail'
        elif action=='extensions-malformed':fault['extensions']='malformed'
        elif action=='extensions-clear':fault['extensions']=''
        elif action=='occupant':write_skill(data/'skills/external','fixture_001',body='Original owner payload <&>')
        elif action=='release':
            hub.add_hosted('fixture_000','2.0.0',official=True,recommended=True,body='Second release <&> 🔧');hub.commit();await asyncio.to_thread(refresh_source,data,rows[0])
        elif action=='withdraw':
            hub.entries['fixture_002']['withdrawn']={'reason':'Later withdrawal'};hub.commit();await asyncio.to_thread(refresh_source,data,rows[0])
        return JSONResponse({'ok':True})
    @contextlib.asynccontextmanager
    async def lifespan(app):
        try:yield
        finally:
            detail_release.set();search_release.set();post_release.set();extensions_release.set();queue_release.set();join_source_refreshes()
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),*collect_routes(data_dir=data)],lifespan=lifespan)
    app.state.drive_root=data;app.state.repo_dir=repo
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or not scope['path'].startswith('/api/'):return await app(scope,receive,send)
            raw=bytearray();messages=[];record={'method':scope['method'],'path':scope['path'],'query':scope.get('query_string',b'').decode()};audit.append(record)
            async def input():
                message=await receive();raw.extend(message.get('body',b''));return message
            async def output(message):messages.append(message)
            if scope['path']=='/api/skill-catalog/install' and fault['before']:
                fault['before']=False;await input();record['body']=json.loads(raw);record['status']=503
                return await JSONResponse({'error':'fixture before acceptance'},status_code=503)(scope,receive,send)
            await app(scope,input,output)
            if raw:record['body']=json.loads(raw)
            record['status']=messages[0]['status']
            try:record['reply']=json.loads(b''.join(m.get('body',b'') for m in messages))
            except Exception:pass
            if scope['path'].startswith('/api/skill-catalog/item/'):await detail_release.wait()
            if scope['path']=='/api/skills/lifecycle-queue':await queue_release.wait()
            if scope['path']=='/api/extensions':
                await extensions_release.wait()
                if fault['extensions']:
                    return await JSONResponse({'skills':None} if fault['extensions']=='malformed' else {'error':'fixture extensions unavailable'},
                      status_code=200 if fault['extensions']=='malformed' else 503)(scope,receive,send)
            if scope['path']=='/api/skill-catalog/search':
                await search_release.wait()
                if fault['search']:
                    fault['search']=False
                    return await JSONResponse({'error':'fixture search unavailable'},status_code=503)(scope,receive,send)
            if scope['path']=='/api/skill-catalog' and fault['catalog']:
                fault['catalog']=False
                return await JSONResponse({'error':'fixture catalog unavailable'},status_code=503)(scope,receive,send)
            if scope['path']=='/api/skill-catalog/install':
                await post_release.wait()
                if fault['after']:
                    fault['after']=False
                    return await JSONResponse({'error':'fixture after acceptance'},status_code=503)(scope,receive,send)
            for message in messages:await send(message)
    sock=socket.socket();sock.bind(('127.0.0.1',0));(run/'port').write_text(str(sock.getsockname()[1]))
    uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])

if __name__=='__main__':main()

