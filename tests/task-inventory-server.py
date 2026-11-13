def main():
    """Actual task list/detail projection and queue publication over isolated task stores."""
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
    from ouroboros.task_results import write_task_result
    from ouroboros.gateway.router import collect_routes
    a=projects_registry.create_project(data,'inventory-a',name='Project A <&> 🔧')
    b=projects_registry.create_project(data,'inventory-b',name='Project B <&> 🔧')
    for index in range(132):
        task=f'inventory-{index:03}';p=a if index%2==0 else b
        write_task_result(data,task,'running',title=f'AlphaTask {index:03} <&> 🔧',description=f'Description {index:03}',chat_id=p['chat_id'],project_id=p['id'],root_task_id=task)
        if index%4!=3:write_task_result(data,task,['completed','failed','cancelled'][index%4],result='Stored result <&> 🔧')
    projects_registry.bind_task_to_project(data,'inventory-001',a['id'],origin={'absent':'post_hoc_unresolved'})
    def task(tid,p):return {'id':tid,'type':'task','text':'Queue task '+tid,'title':'Queue title '+tid,'chat_id':p['chat_id'],'project_id':p['id']}
    workers.PENDING.extend([task('inventory-002',a),task('queue-native',a)])
    workers.RUNNING.update({'inventory-003':{'task':task('inventory-003',b),'worker_id':0},'queue-running-native':{'task':task('queue-running-native',b),'worker_id':0}})
    queue.publish_queue_snapshot(reason='inventory_fixture')
    audit=[];fault='';release=asyncio.Event();release.set();initial=config.SETTINGS_PATH.read_bytes()
    async def facts(request):
        return JSONResponse({'audit':audit,'a':a,'b':b,'bindings':projects_registry.all_task_project_bindings(data,strict=True),
            'settings_unchanged':config.SETTINGS_PATH.read_bytes()==initial})
    async def control(request):
        nonlocal fault
        body=await request.json()
        if body.get('action')=='release-all':release.set()
        elif body.get('action')=='hold':release.clear()
        elif body.get('action')=='queue-change':
            workers.PENDING[:]=[task(body.get('id','queue-new'),a)]
            queue.publish_queue_snapshot(reason='inventory_changed')
        if 'fault' in body:fault=body['fault']
        return JSONResponse({'ok':True})
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),*collect_routes(data_dir=data)])
    app.state.drive_root=data;app.state.repo_dir=repo
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or not scope['path'].startswith('/api/'):return await app(scope,receive,send)
            from urllib.parse import parse_qs
            record={'method':scope['method'],'path':scope['path'],'query':parse_qs(scope.get('query_string',b'').decode())};audit.append(record)
            if scope['path']=='/api/tasks':
                mode=fault;captured=[]
                async def capture(message):captured.append(message)
                await app(scope,receive,capture);body=json.loads(b''.join(m.get('body',b'') for m in captured))
                record['status']=captured[0]['status'];record['count']=len(body.get('tasks',[]));record['queue']=copy.deepcopy(body.get('queue'))
                await release.wait()
                if mode=='http':return await JSONResponse({'error':'Fixture inventory unavailable'},status_code=503)(scope,receive,send)
                if mode=='tasks':body['tasks']=None
                elif mode=='ignored':body['tasks'].extend([None,{'task_id':0,'id':'false-archive'}])
                elif mode=='count':body['queue']['pending_count']='2'
                elif mode=='identity':body['queue']['pending']=[{'id':0,'task':{'id':'false-queue'}}];body['queue']['pending_count']=1
                elif mode=='duplicate':body['queue']['pending'].append(copy.deepcopy(body['queue']['pending'][0]));body['queue']['pending_count']=len(body['queue']['pending'])
                elif mode=='empty':body={'tasks':[],'queue':{'running':[],'pending':[],'running_count':0,'pending_count':0}}
                return await JSONResponse(body,status_code=captured[0]['status'])(scope,receive,send)
            return await app(scope,receive,send)
    sock=socket.socket();sock.bind(('127.0.0.1',0));(run/'port').write_text(str(sock.getsockname()[1]))
    uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])

if __name__=='__main__':main()
