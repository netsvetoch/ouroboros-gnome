def main():
    """Real registered task-artifact endpoint with controlled post-handler wire faults."""
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
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    from ouroboros.artifacts import store_task_artifact_bytes,task_artifact_dir_path,artifact_record
    from ouroboros.task_results import write_task_result
    from ouroboros.gateway.tasks import api_task_artifact,api_task_get
    task='artifact-root';write_task_result(data,task,'completed',result='Fixture artifacts')
    payloads={'small.json':json.dumps({'title':'Native <&> 🔧','status':'retained'},ensure_ascii=False).encode(),'large.bin':b'Large artifact\n'+bytes(range(256))*5000}
    identities={name:{'size':ref['bytes'],'sha256':ref['sha256']} for name,body in payloads.items() for ref in [store_task_artifact_bytes(data,task,name,body)]}
    pdf_task='pdf-root'
    pdf_files={'preview.pdf':(pathlib.Path(__file__).parent/'fixtures/native-preview.pdf').read_bytes(),
        'locked.pdf':(pathlib.Path(__file__).parent/'fixtures/native-preview-locked.pdf').read_bytes(),'broken.pdf':b'Not a PDF document'}
    pdf_identities={name:{'size':ref['bytes'],'sha256':ref['sha256']} for name,body in pdf_files.items() for ref in [store_task_artifact_bytes(data,pdf_task,name,body)]}
    write_task_result(data,pdf_task,'completed',result='Native PDF fixtures')
    root=task_artifact_dir_path(data,task,create=True)
    nested={'bundle/a/report.txt':b'First nested report <&>', 'bundle/b/report.txt':'Второй вложенный отчёт 🔧'.encode()}
    rows=[{**artifact_record(root/name),'immutable':True} for name in payloads]
    for relative,body in nested.items():
        target=root/relative;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(body)
        rows.append({**artifact_record(target),'immutable':True,'relpath':relative})
    write_task_result(data,task,'completed',artifacts=rows)
    from ouroboros.owner_stop_receipt import capture_receipt,wrap_up_document_view,write_wrap_up_document
    from ouroboros.task_results import load_task_result
    import io
    wrap_task='wrap-root';child='wrap-child';child_text='Retained child **answer** <&> 🔧\n'+('Saved work line\n'*80)+'END-OF-SAVED-WORK'
    write_task_result(data,wrap_task,'cancelled',result='Owner requested finalization')
    write_task_result(data,child,'completed',root_task_id=wrap_task,parent_task_id=wrap_task,result=child_text,terminal_origin='model_final')
    def capture_stop(request_id):return capture_receipt(data,wrap_task,{child:'completed'},stop=(wrap_task,request_id))
    capture_stop('fixture-stop-1')
    def wrap_facts():
        result=load_task_result(data,wrap_task);sink=io.BytesIO();write_wrap_up_document(data,result,sink)
        return {'task':wrap_task,'document':wrap_up_document_view(result),'text':sink.getvalue().decode(),'child_text':child_text}
    audit=[];fault={'mode':''};release=asyncio.Event();release.set();initial=config.SETTINGS_PATH.read_bytes()
    async def facts(request):return JSONResponse({'task':task,'wrap':wrap_facts(),'pdf':{'task':pdf_task,'identities':pdf_identities},'identities':identities,'small':payloads['small.json'].decode(),'nested':{k:v.decode() for k,v in nested.items()},'audit':audit,'settings_unchanged':config.SETTINGS_PATH.read_bytes()==initial})
    async def control(request):
        body=await request.json()
        if body['action']=='change-stop':capture_stop('fixture-stop-2')
        if body['action']=='inspect-zip':
            import zipfile
            with zipfile.ZipFile(run/'bundle.zip') as archive:return JSONResponse({name:archive.read(name).decode() for name in archive.namelist()})
        if body['action']=='fault':fault['mode']=body.get('mode','')
        elif body['action']=='hold':fault['mode']='hold';release.clear()
        elif body['action']=='release-all':release.set();fault['mode']=''
        return JSONResponse({'ok':True})
    from ouroboros.gateway.router import collect_routes
    i18n_routes=[route for route in collect_routes(data_dir=data) if getattr(route,'path','').startswith('/api/ui/i18n')]
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),Route('/api/tasks/{task_id}/artifacts/{name}',api_task_artifact),Route('/api/tasks/{task_id}',api_task_get),*i18n_routes]);app.state.drive_root=data;app.state.repo_dir=repo
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or not scope['path'].startswith('/api/'):return await app(scope,receive,send)
            record={'method':scope['method'],'path':scope['path'],'query':scope.get('query_string',b'').decode(),'sent':0};audit.append(record);messages=[]
            if scope['path']=='/api/ui/i18n/missing':
                chunks=[]
                while True:
                    message=await receive();chunks.append(message.get('body',b''))
                    if not message.get('more_body'):break
                body=b''.join(chunks);record['body']=json.loads(body)
                async def replay():return {'type':'http.request','body':body,'more_body':False}
                receive=replay
            async def output(message):messages.append(message)
            await app(scope,receive,output);record['status']=messages[0]['status'];mode=fault['mode'] if '/artifacts/' in scope['path'] else ''
            if mode=='fail':return await JSONResponse({'error':'Fixture artifact unavailable'},status_code=503)(scope,receive,send)
            start=messages[0];body=b''.join(m.get('body',b'') for m in messages)
            if record['status']!=200:
                for m in messages:await send(m)
                return
            if mode=='corrupt':body=body[:4]+bytes([body[4]^1])+body[5:]
            if mode=='short':body=body[:-1]
            if mode=='long':body+=b'x'
            start['headers']=[(k,v) for k,v in start['headers'] if k.lower()!=b'content-length']+[(b'content-length',str(len(body)).encode())]
            await send(start)
            chunk_size=min(65536,max(1,len(body)//2)) if mode=='hold' else 65536
            for i in range(0,len(body),chunk_size):
                chunk=body[i:i+chunk_size];await send({'type':'http.response.body','body':chunk,'more_body':True});record['sent']+=len(chunk)
                if mode=='hold' and i==0:await release.wait()
            await send({'type':'http.response.body','body':b'','more_body':False})
    sock=socket.socket();sock.bind(('127.0.0.1',0));(run/'port').write_text(str(sock.getsockname()[1]));uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])

if __name__=='__main__':main()
