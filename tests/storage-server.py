def main():
    """Real storage routes, counter and FreeSpace, operating only on temporary test data."""
    import json
    import os
    import pathlib
    import socket
    import sys
    from types import SimpleNamespace

    run = pathlib.Path(sys.argv[1])
    manual_mode = len(sys.argv)>2 and sys.argv[2]=="manual"
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
    from ouroboros import storage, startup_historical_audit
    from ouroboros.storage_free import FreeSpace
    from ouroboros.gateway.storage import storage_routes
    from tests._store_shared import seed_result

    reference=pathlib.Path(config.__file__).resolve().parent.parent
    for name in ('ouroboros','supervisor'):(repo/name).symlink_to(reference/name,target_is_directory=True)
    (repo/'VERSION').write_text('7.10.0')

    seed=json.loads(config.SETTINGS_PATH.read_text())
    for key,name in [('OUROBOROS_SUBAGENT_WORKTREE_ROOT','copies'),('OUROBOROS_SUBAGENT_PROJECTS_ROOT','projects'),('OUROBOROS_DELIVERABLES_ROOT','deliverables')]:
        seed[key]=str(run/name);(run/name).mkdir()
    config.SETTINGS_PATH.write_text(json.dumps(seed));initial=config.SETTINGS_PATH.read_bytes()
    live={'live':True}
    for task_id in [*(f'fixture_{i:03}' for i in range(75)),'live']:
        drive=data/'task_drives'/task_id;drive.mkdir(parents=True);(drive/'scratch <&> 🔧.txt').write_text('fixture data '+task_id)
        seed_result(data,task_id,{'task_id':task_id,'status':'completed','ts':'2026-11-01T00:00:00+00:00',
          'title':'Storage <&> 🔧 '+task_id,'objective':'Storage <&> 🔧 '+task_id,'child_drive_root':str(drive)})
    copies={};manual_initial={};manual_source=run/'manual-source';commit_tip='';artifact_before={}
    if manual_mode:
        os.environ.update({key:value for key,value in seed.items() if key in ('OUROBOROS_SUBAGENT_WORKTREE_ROOT','OUROBOROS_SUBAGENT_PROJECTS_ROOT','OUROBOROS_DELIVERABLES_ROOT')})
        import hashlib
        import subprocess
        from ouroboros import subagent_worktrees as sw, owner_keep
        from ouroboros.workspace_patch_capture import write_workspace_patch_artifacts
        from ouroboros.headless import task_artifacts_dir
        def git(path,*args):
            return subprocess.run(['git',*args],cwd=path,check=True,capture_output=True,text=True).stdout.strip()
        manual_source.mkdir()
        git(manual_source,'init','-q');git(manual_source,'config','user.name','Native fixture');git(manual_source,'config','user.email','fixture@localhost')
        (manual_source/'base.txt').write_text('base remains\n')
        git(manual_source,'add','base.txt');git(manual_source,'commit','-qm','fixture baseline')
        for task in ['manual_001','manual_002','manual_commits','manual_live','manual_kept']:
            handle=sw.provision_worktree(repo_dir=manual_source,task_id=task,worktree_root=run/'copies',data_dir=data)
            path=pathlib.Path(handle.path);copies[task]=handle
            seed_result(data,task,{'task_id':task,'status':'completed','title':task,'ts':'2026-11-01T00:00:00+00:00'})
            if task=='manual_001':
                (path/'saved.txt').write_text('captured before unique scratch\n')
                write_workspace_patch_artifacts(path,task_artifacts_dir(data,task),task={'id':task,'task_constraint':{
                    'mode':'acting_subagent','surface':'self_worktree','base_sha':handle.base_sha,'write_root':handle.path,
                    'parent_only_commit':True,'return_kind':'workspace_patch'}})
                artifact_before={str(p.relative_to(task_artifacts_dir(data,task))):hashlib.sha256(p.read_bytes()).hexdigest()
                    for p in task_artifacts_dir(data,task).rglob('*') if p.is_file()}
                for number in range(60):(path/f'unique {number:02} & 🔧.tmp').write_bytes(b'x'*(number+1))
            elif task=='manual_commits':
                (path/'committed.txt').write_text('kept in branch\n');git(path,'add','committed.txt')
                git(path,'-c','user.name=Native fixture','-c','user.email=fixture@localhost','commit','-qm','retained work')
                commit_tip=git(path,'rev-parse','HEAD')
                (path/'scratch.txt').write_text('lost only after explicit choice\n')
            else:(path/'scratch.txt').write_text('unique '+task+'\n')
            manual_initial[task]={str(p.relative_to(path)):hashlib.sha256(p.read_bytes()).hexdigest()
                for p in path.rglob('*') if p.is_file() and '.git' not in p.parts}
        live['manual_live']=True
        owner_keep.set_owner_keep(data,'manual_kept',keep=True,source={'basis':'native fixture'})
    @contextlib.contextmanager
    def guard(stop=None):yield not (callable(stop) and stop())
    counter=storage.StorageCounter();tray=FreeSpace(live=lambda task_id:live.get(task_id,False),guard=guard,offered=('working_copies',) if manual_mode else ('work_folders',))
    barriers={'count':False,'preview':False,'run':False};count_release=threading.Event();preview_release=threading.Event();run_release=threading.Event()
    get_release=asyncio.Event();get_release.set()
    items_release=asyncio.Event();items_release.set()
    fault={'before':False,'after':False,'get':'','items':False};audit=[];spawned=[];first_item=[None]
    real_spawn=startup_historical_audit.spawn_maintenance_job
    def spawn(*args,**kwargs):
        purpose=args[2] if len(args)>2 else kwargs.get('purpose')
        if purpose=='storage':
            sizing=bool(kwargs.get('args'))
            if barriers['preview' if sizing else 'count']:(preview_release if sizing else count_release).wait(15)
            spawned.append('sizing' if sizing else 'count')
        return real_spawn(*args,**kwargs)
    startup_historical_audit.spawn_maintenance_job=spawn
    original_free=tray._free_drives
    def free_drives(root,candidates,receipt):
        if barriers['run'] and candidates:
            original_free(root,candidates[:1],receipt);run_release.wait(15);return original_free(root,candidates[1:],receipt)
        return original_free(root,candidates,receipt)
    tray._free_drives=free_drives
    def manual_facts():
        if not manual_mode:return {}
        from ouroboros.task_results import load_task_result
        present={task:pathlib.Path(handle.path).exists() for task,handle in copies.items()}
        unchanged={task:all((pathlib.Path(copies[task].path)/rel).is_file() and hashlib.sha256((pathlib.Path(copies[task].path)/rel).read_bytes()).hexdigest()==digest
            for rel,digest in paths.items()) for task,paths in manual_initial.items() if present[task]}
        artifacts={str(p.relative_to(task_artifacts_dir(data,'manual_001'))):hashlib.sha256(p.read_bytes()).hexdigest()
            for p in task_artifacts_dir(data,'manual_001').rglob('*') if p.is_file()}
        projection=tray.projection(data)
        page=tray.items(data,projection['plan'],'manual',0,500,None) if projection.get('plan') and projection['state']!='listing' else None
        return {'copies':present,'copy_paths':{task:handle.path for task,handle in copies.items()},'unchanged':unchanged,
            'artifacts_unchanged':bool(artifact_before) and artifacts==artifact_before,
            'branch_retained':git(manual_source,'rev-parse','refs/heads/'+copies['manual_commits'].branch)==commit_tip,
            'results':{task:load_task_result(data,task)['status'] for task in copies},'page':page}
    async def facts(request):
        return JSONResponse({'audit':audit,'spawned':spawned,'free':tray.projection(data),'count':counter.projection(data,free=tray),
          'manual':manual_facts(),'present':sorted(p.name for p in (data/'task_drives').iterdir()),'settings_unchanged':config.SETTINGS_PATH.read_bytes()==initial})
    async def control(request):
        action=(await request.json())['action']
        if action in ('hold-count','hold-preview','hold-run'):
            name=action[5:];barriers[name]=True
            {'count':count_release,'preview':preview_release,'run':run_release}[name].clear()
        elif action=='release-all':
            count_release.set();preview_release.set();run_release.set();get_release.set();items_release.set()
            for key in barriers:barriers[key]=False
        elif action=='hold-get':get_release.clear()
        elif action=='release-get':get_release.set()
        elif action=='hold-items':items_release.clear()
        elif action=='release-items':items_release.set()
        elif action.startswith('items-'):fault['items']=action[6:]
        elif action=='clear-items':fault['items']=False
        elif action=='before':fault['before']=True
        elif action=='after':fault['after']=True
        elif action=='get-fail':fault['get']='fail'
        elif action=='malformed':fault['get']='malformed'
        elif action=='get-clear':fault['get']=''
        elif action=='hold-selected':live['fixture_000']=True
        elif action=='manual-late-write':(pathlib.Path(copies['manual_001'].path)/'late.txt').write_text('arrived after preview\n')
        elif action=='manual-live':live['manual_002']=True
        elif action=='manual-not-live':live['manual_002']=False
        elif action=='replace-plan':
            assert tray.preview(data,repo)
        return JSONResponse({'ok':True})
    @contextlib.asynccontextmanager
    async def lifespan(app):
        try:yield
        finally:
            count_release.set();preview_release.set();run_release.set();counter.stop();tray.stop()
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),*storage_routes(data,repo_dir=repo,owner=counter,free_owner=tray)],lifespan=lifespan)
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or not scope['path'].startswith('/api/'):return await app(scope,receive,send)
            raw=bytearray();messages=[];record={'method':scope['method'],'path':scope['path'],'query':scope.get('query_string',b'').decode()};audit.append(record)
            async def input():
                message=await receive();raw.extend(message.get('body',b''));return message
            async def output(message):messages.append(message)
            if scope['path']=='/api/storage/free' and fault['before']:
                fault['before']=False;await input();record['body']=json.loads(raw);record['status']=503
                return await JSONResponse({'error':'fixture before acceptance'},status_code=503)(scope,receive,send)
            await app(scope,input,output)
            if raw:record['body']=json.loads(raw)
            record['status']=messages[0]['status'];record['no_store']=any(k==b'cache-control' and v==b'no-store' for k,v in messages[0].get('headers',[]))
            try:record['reply']=json.loads(b''.join(m.get('body',b'') for m in messages))
            except Exception:pass
            if scope['path']=='/api/storage/free/items':
                await items_release.wait()
                if fault['items'] or b'cursor=0' in scope.get('query_string',b''):
                    body=json.loads(b''.join(m.get('body',b'') for m in messages))
                    if b'cursor=0' in scope.get('query_string',b'') and body.get('items'):first_item[0]=body['items'][0]['id']
                    mode=fault['items']
                    if mode=='cursor':body['next_cursor']=0
                    elif mode=='total':body['total']='75'
                    elif mode=='version':body['version']=''
                    elif mode=='counts':body['counts']={'kept':-1}
                    elif mode=='duplicate':body['items'].append(body['items'][0])
                    elif mode=='manual':body['items'][0]['manual']={'keeps_commits':True,'not_proven_saved':None}
                    elif mode=='entry':body['items'][-1]['bytes']='123'
                    elif mode=='cross':body['items'][0]['id']=first_item[0]
                    return await JSONResponse(body,headers={'Cache-Control':'no-store'})(scope,receive,send)
            if scope['path']=='/api/storage/measure/cancel':count_release.set()
            if scope['path']=='/api/storage/free/cancel':preview_release.set();run_release.set()
            if scope['path']=='/api/storage/free' and fault['after']:
                fault['after']=False
                return await JSONResponse({'error':'fixture after acceptance'},status_code=503)(scope,receive,send)
            if scope['path']=='/api/storage':
                await get_release.wait()
                if fault['get']:
                    return await JSONResponse({'free':None} if fault['get']=='malformed' else {'error':'fixture read failed'},status_code=200 if fault['get']=='malformed' else 503)(scope,receive,send)
            for message in messages:await send(message)
    sock=socket.socket();sock.bind(('127.0.0.1',0));(run/'port').write_text(str(sock.getsockname()[1]))
    uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])

if __name__=='__main__':main()

