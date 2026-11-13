def main():
    """Real follow-up controls over isolated schedules; no task is admitted or executed."""
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

    from ouroboros.task_results import write_task_result
    from ouroboros.cancel_intents import request_cancel
    from supervisor import queue_schedules as schedules
    from supervisor.followup_policy import refresh_policy
    binding={'billing_group_id':'schedule-origin','billing_group_limit_usd':10.0,
      'billing_group_limit_source':'initial_task_admission','billing_group_limit_revision':'fixture-original-revision'}
    write_task_result(data,'schedule-origin','running',root_task_id='schedule-origin',billing_group=binding,deadline_at='2099-01-01T00:00:00+00:00')
    for sid in ('related-followup','independent-followup','racing-followup','loss-followup'):
        queue.upsert_scheduled_task({'id':sid,'name':sid,'source':'task_followup','enabled':True,
          'trigger':{'type':'once','run_at':'2098-01-01T00:00:00+00:00'},
          'task':{'type':'task','text':'Future work <&>','metadata':{'origin_task_id':'schedule-origin'}}},drive_root=data)
    def stop():request_cancel(data,'schedule-origin',reason='Fixture explicit Stop',source='http_single',requested_by='owner')
    stop()
    def persist():
        table=schedules.load_schedule_store(data)
        for row in table['tasks']:refresh_policy(data,table,row)
        schedules._write_scheduled_tasks(table,data)
    import asyncio
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    from ouroboros.gateway.router import collect_routes
    audit=[];hold={'value':None,'lose':False,'read':False}
    async def facts(request):
        return JSONResponse({'audit':audit,'store':schedules.load_schedule_store(data),'pending':list(workers.PENDING),'binding':binding,
          'held':bool(hold['value'] and hold['value']['ready'])})
    async def control(request):
        body=await request.json()
        if 'read' in body:hold['read']=body['read']
        if body['action']=='persist':persist()
        elif body['action']=='stop':stop();persist()
        elif body['action']=='hold':hold['value']={'ready':False,'event':asyncio.Event()}
        elif body['action']=='release':hold['value']['event'].set()
        elif body['action']=='lose':hold['lose']=True
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
            if scope['method']=='POST' and scope['path'].endswith('/action'):
                pending=hold['value']
                if pending and not pending['ready']:
                    pending['ready']=True;await pending['event'].wait()
            await app(scope,input,output)
            if raw:record['body']=json.loads(raw)
            record['status']=messages[0]['status']
            try:record['reply']=json.loads(b''.join(m.get('body',b'') for m in messages))
            except Exception:pass
            audit.append(record)
            if hold['read'] and scope['method']=='GET' and scope['path']=='/api/schedules':
                return await JSONResponse({'error':'private-read-diagnostic-738'},status_code=503)(scope,receive,send)
            if scope['method']=='POST' and scope['path'].endswith('/action') and hold['lose']:
                hold['lose']=False
                return await JSONResponse({'error':'fixture lost successful action response'},status_code=503)(scope,receive,send)
            for message in messages:await send(message)
    sock=socket.socket();sock.bind(('127.0.0.1',0));(run/'port').write_text(str(sock.getsockname()[1]))
    uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])

if __name__=='__main__':main()
