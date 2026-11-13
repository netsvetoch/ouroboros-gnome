def main():
    """Actual project placement, binding/state projection and durable outbox; inert delivery queue."""
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

    import asyncio, copy, hashlib, threading
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    from ouroboros.gateway.router import collect_routes
    from ouroboros.gateway.projects import api_project_from_task
    from ouroboros.task_results import write_task_result, load_task_result
    from ouroboros import projects_registry, dialogue_store
    from supervisor import state as supervisor_state, message_bus, terminal_delivery
    supervisor_state.init(data); supervisor_state.init_state()
    audit=[]; calls=[]; broadcasts=[]; events=[]; fault={'state':'','mode':'','hold':''}
    release=asyncio.Event(); release.set()
    tasks=['hf-plain','hf-options','hf-before','hf-after','hf-malformed','hf-unavailable','hf-close','hf-form','hf-settled','hf-revise']
    for task in tasks:
        title='Stored task title <&> '+task
        fields={}
        if task not in {'hf-plain','hf-before','hf-close','hf-form'}:
            text='Canonical owner request <&> 🔧 '+task
            ts='2026-11-12T12:00:00Z'
            ref={'chat_id':1,'client_message_id':'origin-'+task,'ts':ts,'text_sha256':hashlib.sha256(text.encode()).hexdigest()}
            dialogue_store.append(data,'chat',{'direction':'in','chat_id':1,'user_id':1,'task_id':task,'text':text,'ts':ts,'client_message_id':ref['client_message_id']},emit_live=False,feed=True)
            fields={'origin_message_text':text,'origin_message_ref':ref}
        write_task_result(data,task,'running',chat_id=1,root_task_id=task,title=title,**fields)
        write_task_result(data,task,'completed',result='Stored task result <&>',**fields)
    queue.publish_queue_snapshot(reason='handoff_fixture')
    class Bridge:
        def broadcast(self,event):broadcasts.append(copy.deepcopy(event))
    message_bus.get_bridge=lambda:Bridge()
    class DeliveryQueue:
        def put(self,event):
            if fault['mode']=='unavailable':raise RuntimeError('Fixture delivery queue unavailable')
            events.append(copy.deepcopy(event))
    workers.get_event_q=lambda **kwargs:DeliveryQueue()

    async def convert(request):
        body=await request.json();record={'body':copy.deepcopy(body)};calls.append(record)
        if fault['hold']=='convert':await release.wait()
        if fault['mode']=='before':
            record['status']=503
            return JSONResponse({'error':'Fixture lost response before placement'},status_code=503)
        response=await api_project_from_task(request)
        record.update(status=response.status_code,reply=json.loads(response.body))
        if response.status_code<300 and fault['mode']=='after':
            return JSONResponse({'error':'Fixture lost response after placement'},status_code=503)
        if response.status_code<300 and fault['mode']=='malformed':
            body=json.loads(response.body);body['binding']['task_id']='different-task'
            return JSONResponse(body)
        return response

    async def facts(request):
        registry=terminal_delivery._registry_path(data)
        return JSONResponse({'audit':audit,'calls':calls,'events':events,'broadcasts':broadcasts,
            'bindings':projects_registry.all_task_project_bindings(data,strict=True),
            'projects':projects_registry.list_projects(data),
            'outbox':json.loads(registry.read_text()) if registry.exists() else {},
            'records':{task:load_task_result(data,task) for task in tasks},
            'settings_unchanged':config.SETTINGS_PATH.read_bytes()==initial})

    async def control(request):
        body=await request.json()
        if body.get('action')=='release-all':fault['hold']='';release.set()
        if 'hold' in body:fault['hold']=body['hold'];release.clear()
        if 'mode' in body:fault['mode']=body['mode']
        if 'state' in body:fault['state']=body['state']
        if body.get('action')=='begin-delete':projects_registry.begin_project_deletion(data,body['project'])
        if body.get('action')=='settle':
            registry=terminal_delivery._read_registry(data)
            for identity,event in list(registry.get('pending',{}).items()):
                if event.get('task_id')==body['task']:terminal_delivery.register_delivery(data,identity)
        return JSONResponse({'ok':True})

    initial=config.SETTINGS_PATH.read_bytes()
    routes=[r for r in collect_routes(data_dir=data) if getattr(r,'path','')!='/api/projects/from-task']
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),Route('/api/projects/from-task',convert,methods=['POST']),*routes])
    app.state.drive_root=data;app.state.repo_dir=repo;app.state.supervisor_ready_event=threading.Event();app.state.supervisor_ready_event.set()
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or not scope['path'].startswith('/api/'):return await app(scope,receive,send)
            record={'method':scope['method'],'path':scope['path']};audit.append(record)
            if scope['path']=='/api/state':
                if fault['hold']=='state':await release.wait()
                captured=[]
                async def capture(message):captured.append(message)
                await app(scope,receive,capture)
                body=json.loads(b''.join(m.get('body',b'') for m in captured))
                record['revision']=body.get('task_bindings_revision')
                if fault['state']=='array':body['task_bindings']=[]
                elif fault['state']=='number':body['task_bindings_revision']=7
                elif fault['state']=='missing':body.pop('task_bindings_revision',None)
                elif fault['state']=='empty':body['task_bindings_revision']=''
                elif fault['state']=='binding':body['task_bindings']['hf-after']={'project_id':'broken','chat_id':1}
                return await JSONResponse(body,status_code=captured[0]['status'])(scope,receive,send)
            return await app(scope,receive,send)
    sock=socket.socket();sock.bind(('127.0.0.1',0));(run/'port').write_text(str(sock.getsockname()[1]))
    uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])

if __name__=='__main__':main()
