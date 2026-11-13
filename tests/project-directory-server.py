def main():
    """Real complete/addressed project listing over an isolated 236-room registry."""
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

    import asyncio,copy
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    from ouroboros import projects_registry
    from ouroboros.gateway.projects import api_projects_list
    for index in range(235):
        pid=f'catalog-{index:03}'
        projects_registry.create_project(data,pid,name=f'Project {index:03} <&> 🔧')
    projects_registry.create_project(data,'unicode-project',name='Café Ёж <&> 🔧')
    projects_registry.update_project(data,'catalog-005',pinned=True)
    projects_registry.update_project(data,'catalog-006',closed={'at':'2026-11-12T12:00:00Z','by':'owner','note':'Kept closed'})
    projects_registry.begin_project_deletion(data,'catalog-007')
    projects_registry.fail_project_deletion(data,'catalog-007','Pending cleanup <&>')
    if '--details' in sys.argv:
        workspace=run/'registered workspace <&>';workspace.mkdir()
        projects_registry.update_project(data,'unicode-project',working_dir=str(workspace),provenance='cloned',clone_url='ssh://example.invalid/owner/project.git',trusted_at='2026-11-13T01:02:03Z',closed={'at':'2026-11-13T02:03:04Z','by':'ouroboros:recorded-task','note':'Literal closure <&> Ω'})
    registry=projects_registry._registry_path(data);initial_registry=registry.read_bytes();initial_settings=config.SETTINGS_PATH.read_bytes()
    audit=[];state={'fault':'','scope':'list','hold':''};release=asyncio.Event();release.set()
    async def facts(request):
        return JSONResponse({'audit':audit,'projects':projects_registry.list_projects(data),
            'registry_unchanged':registry.read_bytes()==initial_registry,'settings_unchanged':config.SETTINGS_PATH.read_bytes()==initial_settings})
    async def control(request):
        body=await request.json()
        if body.get('action')=='release-all':state['hold']='';release.set()
        if 'hold' in body:state['hold']=body['hold'];release.clear()
        for key in ('fault','scope'):
            if key in body:state[key]=body[key]
        return JSONResponse({'ok':True})
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),Route('/api/projects',api_projects_list)])
    app.state.drive_root=data;app.state.repo_dir=repo
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or scope['path']!='/api/projects':return await app(scope,receive,send)
            from urllib.parse import parse_qs
            query=parse_qs(scope.get('query_string',b'').decode());addressed=bool('id' in query or 'chat_id' in query)
            record={'method':scope['method'],'query':query};audit.append(record);captured=[]
            mode=state['fault'] if state['scope']=='all' or not addressed else ''
            held=state['hold']==('lookup' if addressed else 'list')
            async def capture(message):captured.append(message)
            await app(scope,receive,capture);body=json.loads(b''.join(m.get('body',b'') for m in captured))
            record['count']=len(body.get('projects',[]));record['status']=captured[0]['status']
            if held:await release.wait()
            if mode=='http':return await JSONResponse({'error':'Fixture catalog unavailable'},status_code=503)(scope,receive,send)
            if captured[0]['status']==200:
                if mode=='empty':body['projects']=[]
                elif mode=='malformed':body['projects']=[None]
                elif mode=='tombstone':body['projects']=[{'lifecycle':'tombstoned'}]
                elif body.get('projects'):
                    if mode=='facts':body['projects'][0].update(provenance={},has_thread_activity='unknown')
                    elif mode=='binding':body['projects'][0]['chat_id']+=1
                    elif mode=='future':body['projects'][0]['provenance']='constructor'
                    elif mode=='name':body['projects'][0]['name']={'wrong':'type'}
                    elif mode=='pinned':body['projects'][0]['pinned']='yes'
                    elif mode=='closed':body['projects'][0]['closed']=[]
                    elif mode=='lifecycle':body['projects'][0]['lifecycle']=None
                    elif mode=='revision':body['projects'][0]['visible_revision']='1'
                    elif mode=='duplicate':body['projects'].append(copy.deepcopy(body['projects'][0]))
            await JSONResponse(body,status_code=captured[0]['status'])(scope,receive,send)
    sock=socket.socket();sock.bind(('127.0.0.1',0));(run/'port').write_text(str(sock.getsockname()[1]))
    uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])

if __name__=='__main__':main()
