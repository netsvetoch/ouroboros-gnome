def main():
    """Real source skill update/uninstall and lifecycle lane in a temporary installation."""
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
    from ouroboros.skill_source_catalog import refresh_source,find_item
    from ouroboros.skill_source_install import install_item,run_in_lane
    from ouroboros.skill_install_record import read_install_record,update_install_record
    from ouroboros.skill_loader import skill_state_dir_path
    from tests._skill_source_fixtures import HubFixture,join_source_refreshes
    from supervisor import message_bus
    bridge=message_bus.LocalChatBridge();message_bus.DATA_DIR=data;message_bus._BRIDGE=bridge
    hub=HubFixture(run/'source');names=('keep_fixture','replace_fixture','merge_fixture','no_base_fixture','skip_fixture')
    for name in names:hub.add_hosted(name,official=True,body='Initial source <&> 🔧')
    hub.commit();rows=hub.rows()[1:];version=1
    seed=json.loads(config.SETTINGS_PATH.read_text());seed.update(OUROBOROS_SKILL_SOURCES=json.dumps(rows))
    config.SETTINGS_PATH.write_text(json.dumps(seed));(repo/'skills').mkdir();(repo/'skills/builtin.json').write_text('{"schema_version":1,"skills":[]}')
    refresh_source(data,rows[0])
    for name in names:run_in_lane(data,'install',name,lambda name=name:install_item(data,'ouroboros/'+name,turn_on_when_ready=False,repo_dir=repo))
    for name in ('replace_fixture','merge_fixture','no_base_fixture'):
        with (data/'skills/ouroboroshub'/name/'SKILL.md').open('a') as f:f.write('\nLOCAL_'+name.upper()+' <&> 🔧\n')
    update_install_record(data,'no_base_fixture',base_digest='')
    state=skill_state_dir_path(data,'replace_fixture');state.mkdir(parents=True,exist_ok=True);(state/'settings.json').write_text('{"owner_preference":"retained"}')
    def publish_next():
        nonlocal version
        version+=1
        for name in names:hub.add_hosted(name,f'{version}.0.0',official=True,body=f'Source release {version} <&> 🔧')
        hub.commit();refresh_source(data,rows[0])
    publish_next();audit=[];fault={'uninstall':'','update_before':False,'update_after':False}
    release=asyncio.Event();release.set()
    async def facts(request):
        with bridge._inbox.mutex:inbox=list(bridge._inbox.queue)
        return JSONResponse({'audit':audit,'version':version,'records':{name:read_install_record(data,name) for name in names},
          'payloads':{name:(data/'skills/ouroboroshub'/name/'SKILL.md').read_text() if (data/'skills/ouroboroshub'/name/'SKILL.md').exists() else None for name in names},
          'previous':[str(p.relative_to(data)) for p in (data/'skills').rglob('SKILL.md') if 'LOCAL_REPLACE_FIXTURE' in p.read_text()],
          'inbox':inbox,'owner_settings':json.loads((state/'settings.json').read_text()),'tombstone':(state/'uninstalled.json').exists()})
    async def control(request):
        body=await request.json();action=body['action']
        if action=='publish':await asyncio.to_thread(publish_next)
        elif action=='modify-local':
            with (data/'skills/ouroboroshub/replace_fixture/SKILL.md').open('a') as f:f.write('LOCAL_CHANGED_AGAIN\n')
        elif action=='reject-review':
            rows[0]['trust']='review';doc=json.loads(config.SETTINGS_PATH.read_text());doc['OUROBOROS_SKILL_SOURCES']=json.dumps(rows);config.SETTINGS_PATH.write_text(json.dumps(doc))
            item=find_item(data,'ouroboros/skip_fixture',repo_dir=repo)[1]
            update_install_record(data,'skip_fixture',update_rejected={'version':item['version'],'digest':item['digest'],'reason':'review_blockers'},skipped_release_digest=item['digest'])
        elif action=='hold':release.clear()
        elif action=='release-all':release.set()
        elif action=='update-before':fault['update_before']=True
        elif action=='update-after':fault['update_after']=True
        elif action in ('uninstall-before','uninstall-after','uninstall-malformed'):fault['uninstall']=action[10:]
        return JSONResponse({'ok':True})
    @contextlib.asynccontextmanager
    async def lifespan(app):
        try:yield
        finally:release.set();join_source_refreshes()
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),*collect_routes(data_dir=data)],lifespan=lifespan)
    app.state.drive_root=data;app.state.repo_dir=repo
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or not scope['path'].startswith('/api/'):return await app(scope,receive,send)
            raw=bytearray();messages=[];record={'method':scope['method'],'path':scope['path']};audit.append(record)
            async def input():
                message=await receive();raw.extend(message.get('body',b''));return message
            async def output(message):messages.append(message)
            updating=scope['path'].endswith('/update') and scope['method']=='POST';uninstall=scope['path'].endswith('/uninstall') and scope['method']=='POST'
            if (updating and fault['update_before']) or (uninstall and fault['uninstall']=='before'):
                fault['update_before']=False;fault['uninstall']='';await input();record['body']=json.loads(raw or b'{}');record['status']=503
                return await JSONResponse({'error':'fixture before acceptance'},status_code=503)(scope,receive,send)
            await app(scope,input,output)
            if raw:record['body']=json.loads(raw)
            record['status']=messages[0]['status']
            try:record['reply']=json.loads(b''.join(m.get('body',b'') for m in messages))
            except Exception:pass
            if updating or uninstall:
                await release.wait()
                if updating and fault['update_after']:
                    fault['update_after']=False
                    return await JSONResponse({'error':'fixture accepted update'},status_code=503)(scope,receive,send)
                if uninstall and fault['uninstall'] in ('after','malformed'):
                    mode=fault['uninstall'];fault['uninstall']=''
                    return await JSONResponse({} if mode=='malformed' else {'error':'fixture accepted uninstall'},status_code=200 if mode=='malformed' else 503)(scope,receive,send)
            for message in messages:await send(message)
    sock=socket.socket();sock.bind(('127.0.0.1',0));(run/'port').write_text(str(sock.getsockname()[1]))
    uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])

if __name__=='__main__':main()

