def main():
    """Actual project deletion fence, supervisor cancellation worker and tombstone on owned data."""
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

    import asyncio,copy,threading
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    from ouroboros import projects_registry,dialogue_store
    from ouroboros.gateway.router import collect_routes
    from ouroboros.gateway.projects import api_project_delete
    from ouroboros.task_results import load_task_result
    from supervisor import state as supervisor_state,message_bus,queue_transitions
    supervisor_state.init(data);supervisor_state.init_state()
    projects={};audit=[];calls=[];events=[];broadcasts=[]
    for pid in ['del-main','del-error','del-before','del-after','del-malformed','del-refused','del-close','del-read','del-parent']:
        folder=run/'folders'/pid;folder.mkdir(parents=True)
        (folder/'keep.txt').write_text('Working folder <&> 🔧 '+pid)
        project=projects_registry.create_project(data,pid,name='Project <&> 🔧 '+pid,working_dir=str(folder));projects[pid]=project
        memory=data/'projects'/pid/'workpad.md';memory.parent.mkdir(parents=True,exist_ok=True);memory.write_text('Memory <&> 🔧 '+pid)
        dialogue_store.append(data,'chat',{'chat_id':project['chat_id'],'direction':'out','text':'History <&> 🔧 '+pid,'client_message_id':'history-'+pid,'ts':'2026-11-12T12:00:00Z'},emit_live=False,feed=True)
    from ouroboros.task_results import write_task_result
    write_task_result(data,'delete-bound','completed',chat_id=1,title='Bound archive',result='Kept bound task')
    projects_registry.bind_task_to_project(data,'delete-bound','del-main',origin={'absent':'post_hoc_unresolved'})
    queue.publish_queue_snapshot(reason='project_delete_fixture')
    initial=config.SETTINGS_PATH.read_bytes()
    state={'read':'','receipt':'','hold':'','worker_fail':False}
    release=asyncio.Event();release.set();worker_release=threading.Event();worker_release.set()
    original_live=queue_transitions._live_project_task_ids
    def live(*args,**kwargs):
        worker_release.wait()
        if state['worker_fail']:raise RuntimeError('Fixture quiescence lookup failure <&>')
        return original_live(*args,**kwargs)
    queue_transitions._live_project_task_ids=live
    class Bridge:
        def broadcast(self,event):broadcasts.append(copy.deepcopy(event))
    message_bus.get_bridge=lambda:Bridge()
    class EventQueue:
        def put(self,event):events.append(copy.deepcopy(event))
    workers.get_event_q=lambda **kwargs:EventQueue()

    async def delete(request):
        pid=request.path_params['project_id'];record={'project':pid};calls.append(record)
        if state['hold']=='post':await release.wait()
        mode=state['receipt']
        if mode in {'before','refused'}:
            record['status']=503 if mode=='before' else 403
            return JSONResponse({'error':'Fixture delete refused before fence'},status_code=record['status'])
        response=await api_project_delete(request);record.update(status=response.status_code,reply=json.loads(response.body))
        if mode=='after':return JSONResponse({'error':'Fixture lost acknowledgement after fence'},status_code=503)
        if mode=='malformed':
            body=json.loads(response.body);body['folder_untouched']=False
            return JSONResponse(body,status_code=response.status_code)
        return response

    async def control(request):
        body=await request.json()
        if body.get('action')=='release-all':state['hold']='';release.set();worker_release.set()
        if 'hold' in body:state['hold']=body['hold'];release.clear()
        if 'worker_hold' in body:
            if body['worker_hold']:worker_release.clear()
            else:worker_release.set()
        for key in ('read','receipt','worker_fail'):
            if key in body:state[key]=body[key]
        return JSONResponse({'ok':True})

    async def facts(request):
        reserved={pid:projects_registry.get_reserved_project(data,pid,strict=True) for pid in projects}
        return JSONResponse({'projects':projects,'reserved':reserved,'audit':audit,'calls':calls,'events':events,'broadcasts':broadcasts,
            'pending':workers.PENDING,'task':load_task_result(data,'delete-queued'),
            'binding':projects_registry.project_binding_for_task(data,'delete-bound',strict=True),
            'kept':{pid:{'folder':(pathlib.Path(p['working_dir'])/'keep.txt').read_text(),
                'memory':(data/'projects'/pid/'workpad.md').read_text(),
                'history':[row.row['text'] for row in dialogue_store.rows_by_client_id(data,'history-'+pid,chat_id=p['chat_id'])]}
                for pid,p in projects.items()},'settings_unchanged':config.SETTINGS_PATH.read_bytes()==initial})

    routes=[r for r in collect_routes(data_dir=data) if getattr(r,'path','')!='/api/projects/{project_id}/delete']
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),Route('/api/projects/{project_id}/delete',delete,methods=['POST']),*routes])
    app.state.drive_root=data;app.state.repo_dir=repo;app.state.supervisor_ready_event=threading.Event();app.state.supervisor_ready_event.set()
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or not scope['path'].startswith('/api/'):return await app(scope,receive,send)
            from urllib.parse import parse_qs
            record={'method':scope['method'],'path':scope['path'],'project':parse_qs(scope.get('query_string',b'').decode()).get('id',[''])[0]};audit.append(record)
            if scope['path']=='/api/projects' and scope['method']=='GET':
                if state['hold']=='get':await release.wait()
                captured=[]
                async def capture(message):captured.append(message)
                await app(scope,receive,capture)
                body=json.loads(b''.join(m.get('body',b'') for m in captured));mode=state['read']
                if mode=='http':return await JSONResponse({'error':'Fixture read unavailable'},status_code=503)(scope,receive,send)
                if mode=='malformed':body['projects']=[None]
                elif body.get('projects'):
                    if mode=='error':body['projects'][0]['delete_error']={'not':'a string'}
                    elif mode=='lifecycle':body['projects'][0]['lifecycle']=None
                    elif mode=='room':body['projects'][0]['chat_id']+=1
                return await JSONResponse(body,status_code=captured[0]['status'])(scope,receive,send)
            return await app(scope,receive,send)
    sock=socket.socket();sock.bind(('127.0.0.1',0));(run/'port').write_text(str(sock.getsockname()[1]))
    try:uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])
    finally:worker_release.set()

if __name__=='__main__':main()
