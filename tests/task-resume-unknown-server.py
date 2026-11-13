def main():
    """Real Resume/custody/owner-pause reducers over retained dispatch facts; no workers run."""
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

    import uvicorn
    import threading
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    from ouroboros.gateway.router import collect_routes
    from ouroboros.task_results import load_task_result
    from ouroboros.owner_pause import read_fence
    from ouroboros.gateway.task_pause import api_task_pause
    from ouroboros.gateway.task_hurry import api_task_hurry
    from ouroboros.owner_mailbox import _mailbox_path, drain_owner_entries
    calls = []
    seen = set()
    audit = []
    fault={"mode":""}

    async def control(request):
        action = request.url.path.rsplit('/', 1)[-1]
        body = await request.json()
        task_id = request.path_params['task_id']
        response = await {'pause': api_task_pause, 'hurry': api_task_hurry}[action](request)
        reply = json.loads(response.body)
        calls.append(dict(task_id=task_id, action=action, body=body, status=response.status_code, reply=reply))
        if task_id in {'ctl-hurry-lost', 'ctl-pause-lost'} and sum(row['task_id'] == task_id and row['action'] == action for row in calls) == 1 and response.status_code < 300:
            return JSONResponse({'error': 'fixture response unavailable after durable action'}, status_code=503)
        return response

    async def unknown(request):
        from ouroboros.task_results import write_task_result
        body=await request.json();tid=body['task_id']
        row=load_task_result(data,tid) or {}
        claims={op:{'tool':'run_command','task_id':tid,'root_task_id':tid,'state':'returned',
          'claimed_at':'2026-11-01T00:00:00+00:00','external_pending':{'token-'+op:'mcp_transport'}} for op in body.get('ops',['unknown-a','unknown-b'])}
        write_task_result(data,tid,row.get('status') or 'paused',launch_handoffs=claims)
        with queue._queue_lock:
            for task in workers.PENDING:
                if task.get('id')==tid:task['admitted_dispatch']='possible'
        queue.publish_queue_snapshot(reason='fixture_retained_admitted_dispatch')
        return JSONResponse({'ok':True})

    async def fixture_control(request):
        fault['mode']=(await request.json()).get('mode','')
        return JSONResponse({'ok':True})

    async def facts(request):
        ids = {row.get('id') for row in workers.PENDING} | {row['task_id'] for row in calls} | seen
        def mail(task):
            path = _mailbox_path(data, task)
            return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
        return JSONResponse(json.loads(json.dumps(dict(calls=calls, audit=audit, pending=workers.PENDING,
            records={key: load_task_result(data, key) for key in ids},
            fences={key: read_fence(data, key) for key in ids}, mail={key: mail(key) for key in ids},
            drained_mail={key: drain_owner_entries(data, key, seen_ids=set()) for key in ids},
            snapshot=json.loads(queue.QUEUE_SNAPSHOT_PATH.read_text())), default=str)))

    routes = [route for route in collect_routes(data_dir=data) if not (getattr(route, 'path', '') in {'/api/tasks/{task_id}/pause', '/api/tasks/{task_id}/hurry'})]
    app = Starlette(routes=[Route('/fixture/facts', facts), Route('/fixture/control',fixture_control,methods=['POST']), Route('/fixture/unknown',unknown,methods=['POST']),
        Route('/api/tasks/{task_id}/pause', control, methods=['POST']),
        Route('/api/tasks/{task_id}/hurry', control, methods=['POST']), *routes])
    app.state.drive_root = data
    app.state.repo_dir = repo
    app.state.supervisor_ready_event = threading.Event()
    app.state.supervisor_ready_event.set()
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    (run / 'port').write_text(str(sock.getsockname()[1]))
    class Observe:
        async def __call__(self, scope, receive, send):
            if scope['type']!='http' or not scope['path'].startswith('/api/'):
                return await app(scope,receive,send)
            if scope['path'].startswith('/api/tasks/'):seen.add(scope['path'].split('/')[3])
            record={'method':scope['method'],'path':scope['path']};audit.append(record);raw=bytearray()
            async def input():
                message=await receive();raw.extend(message.get('body',b''))
                if raw and not message.get('more_body'):record['body']=json.loads(raw)
                return message
            if not scope['path'].endswith('/resume'):
                async def output(message):
                    if message['type']=='http.response.start':record['status']=message['status']
                    await send(message)
                return await app(scope,input,output)
            messages=[]
            async def output(message):messages.append(message)
            await app(scope,input,output)
            record['status']=messages[0]['status'];record['reply']=json.loads(b''.join(m.get('body',b'') for m in messages))
            mode=fault['mode'];body=record['reply']
            if mode=='lost' and record.get('body',{}).get('accept_unknown'):
                fault['mode']=''
                return await JSONResponse({'error':'Fixture receipt lost after real decision'},status_code=503)(scope,receive,send)
            if record['status']==409 and mode in ('bad-offer','wrong-target'):
                body={**body, **({'acceptable_unknown':[42]} if mode=='bad-offer' else {'task_id':'foreign-task'})}
                return await JSONResponse(body,status_code=409)(scope,receive,send)
            for message in messages:await send(message)
    uvicorn.Server(uvicorn.Config(Observe(), log_level='warning')).run(sockets=[sock])


# Stop can start the upstream event-queue manager with multiprocessing spawn.
# Its import of this module must not recreate the fixture or start another HTTP server.
if __name__ == "__main__":
    main()
