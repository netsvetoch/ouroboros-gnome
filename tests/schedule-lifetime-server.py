def main():
    """Actual scheduled occurrence admission with inert workers; no execution or provider calls."""
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

    from ouroboros.task_results import load_task_result
    from supervisor import queue_schedules as schedules
    attachment=repo/'native-input.txt'
    attachment.write_text('Scheduled fixture input <&>\n')
    import asyncio
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    from ouroboros.gateway.router import collect_routes
    audit=[];fault={'read':'','hold':'','method':'','write':''};release=asyncio.Event();release.set()
    async def facts(request):
        table=schedules.load_schedule_store(data)
        ids={row.get('last_task_id') for row in table['tasks'] if row.get('last_task_id')}
        return JSONResponse(json.loads(json.dumps({'audit':audit,'store':table,'pending':list(workers.PENDING),'attachment':str(attachment),
          'records':{tid:load_task_result(data,tid,strict=True) for tid in ids}},default=str)))
    async def control(request):
        body=await request.json()
        if body.get('action')=='tick':await asyncio.to_thread(queue.check_scheduled_tasks)
        if body.get('action')=='release-all':fault['hold']='';release.set()
        for key in ('read','hold','method','write'):
            if key in body:fault[key]=body[key]
        if body.get('hold'):release.clear()
        return JSONResponse({'ok':True})
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),*collect_routes(data_dir=data)])
    app.state.drive_root=data;app.state.repo_dir=repo
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or not scope['path'].startswith('/api/'):return await app(scope,receive,send)
            raw=bytearray();messages=[];record={'method':scope['method'],'path':scope['path']}
            async def input():
                message=await receive();raw.extend(message.get('body',b''));return message
            async def output(message):messages.append(message)
            held=scope['path']==fault['hold'] and (not fault['method'] or fault['method']==scope['method'])
            mode=fault['read']
            await app(scope,input,output)
            if raw:record['body']=json.loads(raw)
            record['status']=messages[0]['status']
            try:record['reply']=json.loads(b''.join(m.get('body',b'') for m in messages))
            except Exception:pass
            audit.append(record)
            if held:await release.wait()
            if fault['write']=='after' and scope['method']=='POST' and scope['path']=='/api/schedules':
                fault['write']=''
                assert record['status']==200, messages
                return await JSONResponse({'error':'Fixture acknowledgement lost after upsert'},status_code=503)(scope,receive,send)
            if mode and scope['path']=='/api/schedules' and scope['method']=='GET':
                body=record['reply']
                if mode=='http':return await JSONResponse({'error':'Fixture read unavailable'},status_code=503)(scope,receive,send)
                if mode=='duplicate':body['tasks'].append(dict(body['tasks'][0]))
                elif mode=='name':body['tasks'][0]['name']=[]
                elif mode=='trigger':body['tasks'][0]['trigger']={'type':'once','run_at':[]}
                elif mode=='task':body['tasks'][0]['task']['text']=[]
                elif mode=='hold':body['tasks'][0]['followup_hold']=[]
                elif mode=='outcome':body['tasks'][0]['outcome']={'quiet':'false'}
                elif mode=='effort':body['tasks'][0]['task']['reasoning_effort']='fixture-future-effort'
                return await JSONResponse(body)(scope,receive,send)
            for message in messages:await send(message)
    sock=socket.socket();sock.bind(('127.0.0.1',0));(run/'port').write_text(str(sock.getsockname()[1]))
    uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])

if __name__=='__main__':main()
