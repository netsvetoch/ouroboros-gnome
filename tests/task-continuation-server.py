def main():
    """Real continuation admission and owner-keep API; no worker/model execution."""
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
        "OUROBOROS_SUBAGENTS_MODE": "off", "TOTAL_BUDGET": 0, "OUROBOROS_SUBAGENT_WORKTREE_ROOT": str(run / "copies")}))
    (run / "copies").mkdir()
    os.environ["OUROBOROS_SUBAGENT_WORKTREE_ROOT"] = str(run / "copies")
    store_import.ensure_current_store(data)
    from ouroboros.usage_store import migrate_from_journal
    migrate_from_journal(data)
    from supervisor import queue, workers
    queue.init(data)
    queue.init_queue_refs(workers.PENDING, workers.RUNNING, workers.QUEUE_SEQ_COUNTER_REF)
    workers.WORKERS = {0: SimpleNamespace(busy_task_id=None, reaping=False)}
    workers._WORKER_POOL_DISABLED_REASON = ""

    from supervisor import state
    state.init(data, total_budget_limit=100)
    queue.publish_queue_snapshot(reason='continuation_fixture')
    from ouroboros.task_results import write_task_result, load_task_result
    from ouroboros.owner_mailbox import write_owner_message, KIND_OWNER_TEXT, KIND_TASK_MESSAGE
    predecessors = ['cont-before', 'cont-after', 'cont-bound', 'cont-native', 'cont-stopped', 'cont-expired']
    for task in predecessors:
        write_task_result(data, task, 'running', chat_id=1, project_id='', root_task_id=task,
            title='Прерванная задача <&>', origin_message_text='Сохранить исходный запрос <&>',
            origin_message_ref={'chat_id': 1, 'client_message_id': 'origin-'+task},
            deadline_at='2000-01-01T00:00:00+00:00' if task == 'cont-expired' else '2099-01-01T00:00:00+00:00', billing_group={
                'billing_group_id': task, 'billing_group_limit_usd': 20.0,
                'billing_group_limit_source': 'initial_task_admission', 'billing_group_limit_revision': 'fixture-admission'})
        write_task_result(data, task, 'cancelled', result='Прервано', cancel_origin={
            'source': 'http_single' if task == 'cont-stopped' else 'snapshot_restore',
            'reason': 'Stop now' if task == 'cont-stopped' else 'server_shutdown'})
        write_owner_message(data, 'Добавить уточнение владельца', task, msg_id='owner-extra', kind=KIND_OWNER_TEXT)
        write_owner_message(data, 'Контекст от помощника', task, msg_id='peer-extra', kind=KIND_TASK_MESSAGE)
    keep_drive = data / 'state/headless_tasks/keep-root'
    keep_drive.mkdir(parents=True)
    (keep_drive / 'material.txt').write_text('Сохранённый материал <&>')
    write_task_result(data, 'keep-root', 'completed', result='Готово', child_drive_root=str(keep_drive))

    import uvicorn
    import asyncio, threading
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    from ouroboros.gateway.router import collect_routes
    from ouroboros.gateway.task_continue import api_task_continue
    from ouroboros.gateway.task_owner_keep import api_task_owner_keep
    calls = []
    keep_reads=[];keep_i18n=[]
    keep_fault={'refuse':False,'lost':False,'wire':None,'bad_get':False,'hold_get':False,'hold_post':False}
    keep_release=asyncio.Event();keep_release.set()
    custody_release=threading.Event();custody_release.set()
    custody={'locked':False};custody_thread=None
    async def keep_control(request):
        nonlocal custody_thread
        body=await request.json();action=body['action']
        if action=='fault':
            keep_fault.update({key:body.get(key,False if key!='wire' else None) for key in keep_fault})
            if keep_fault['hold_get'] or keep_fault['hold_post']:keep_release.clear()
        elif action=='release-all':keep_release.set();custody_release.set()
        elif action=='lock':
            from ouroboros.task_custody import task_custody_lock
            ready=threading.Event();custody_release.clear()
            def hold():
                with task_custody_lock(data,'keep-root',timeout_sec=2) as locked:
                    custody['locked']=locked;ready.set();custody_release.wait(40)
                custody['locked']=False
            custody_thread=threading.Thread(target=hold,daemon=True);custody_thread.start()
            await asyncio.to_thread(ready.wait,3)
        elif action=='seed':
            from ouroboros.task_store import patch_document
            from ouroboros.review_thread_retention import RELEASES
            backup=run/'keep-test-backup'
            if backup.exists() and not keep_drive.exists():backup.rename(keep_drive)
            mode=body.get('mode','normal')
            if mode=='retired' and keep_drive.exists():keep_drive.rename(backup)
            release={'fixture-thread':{'state':'bound' if mode=='unconfirmed' else 'accepted' if mode=='partial' else 'not_found'}} if mode in {'unconfirmed','partial','unknown'} else {}
            def patch(row):
                result={**row,RELEASES:release};result.pop('owner_keep',None)
                return result
            patch_document(data,'keep-root',patch)
        return JSONResponse({'ok':True,'locked':custody['locked']})


    async def control(request):
        action = request.url.path.rsplit('/', 1)[-1]
        body = await request.json()
        task_id = request.path_params['task_id']
        attempt = sum(row['task_id'] == task_id and row['action'] == action for row in calls) + 1
        call = dict(task_id=task_id, action=action, body=body)
        calls.append(call)
        if action=='owner-keep' and keep_fault['refuse']:
            return JSONResponse({'error':'fixture prewrite refusal','reason_code':'unexpected_fields','task_id':task_id},status_code=400)
        if task_id == 'cont-before' and attempt == 1:
            call['fault'] = 'before'
            return JSONResponse({'error': 'fixture unavailable before admission'}, status_code=503)
        publish = queue.publish_queue_snapshot
        if task_id == 'cont-bound' and attempt == 1:
            # Inject a failed durability barrier; the actual handler must roll back
            # the queued successor and retain its bound claim for the same nonce.
            queue.publish_queue_snapshot = lambda reason='': False if reason == 'owner_continue_admitted' else publish(reason=reason)
        try:
            response = await {'continue': api_task_continue, 'owner-keep': api_task_owner_keep}[action](request)
        finally:
            queue.publish_queue_snapshot = publish
        call.update(status=response.status_code, reply=json.loads(response.body))
        if task_id == 'cont-after' and attempt == 1 and response.status_code == 200:
            call['fault'] = 'after'
            return JSONResponse({'error': 'fixture unavailable after admission'}, status_code=503)
        if action=='owner-keep':
            if keep_fault['hold_post']:
                call['held']=True;await keep_release.wait();call['released']=True
            if keep_fault['lost']:
                return JSONResponse({'error':'fixture lost response after actual keep writer'},status_code=503)
            if keep_fault['wire'] is not None:return JSONResponse(keep_fault['wire'])
        return response

    async def facts(request):
        ids = set(predecessors) | {'keep-root'} | {row['id'] for row in workers.PENDING}
        return JSONResponse(json.loads(json.dumps(dict(calls=calls, keep_reads=keep_reads, keep_i18n=keep_i18n, custody=custody, pending=workers.PENDING,
            records={key: load_task_result(data, key) for key in ids}, keep_drive=str(keep_drive),
            material=((keep_drive if keep_drive.exists() else run/'keep-test-backup') / 'material.txt').read_text(),
            snapshot=json.loads(queue.QUEUE_SNAPSHOT_PATH.read_text())), default=str)))

    routes = [route for route in collect_routes(data_dir=data) if getattr(route, 'path', '') not in {
        '/api/tasks/{task_id}/continue', '/api/tasks/{task_id}/owner-keep'}]
    app = Starlette(routes=[Route('/fixture/facts', facts),Route('/fixture/keep',keep_control,methods=['POST']),
        Route('/api/tasks/{task_id}/continue', control, methods=['POST']),
        Route('/api/tasks/{task_id}/owner-keep', control, methods=['POST']), *routes])
    app.state.drive_root = data
    app.state.repo_dir = repo
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    (run / 'port').write_text(str(sock.getsockname()[1]))
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']=='http' and scope['path']=='/api/ui/i18n/missing':
                raw=bytearray()
                async def capture():
                    message=await receive();raw.extend(message.get('body',b''))
                    if not message.get('more_body') and raw:keep_i18n.append(json.loads(raw))
                    return message
                return await app(scope,capture,send)
            if scope['type']=='http' and scope['method']=='GET' and scope['path']=='/api/tasks/keep-root':
                messages=[]
                async def collect(message):messages.append(message)
                await app(scope,receive,collect)
                record={'held':keep_fault['hold_get']};keep_reads.append(record)
                if record['held']:await keep_release.wait();record['released']=True
                if keep_fault['bad_get']:return await JSONResponse({'task_id':'keep-root','status':'completed','owner_keep':42})(scope,receive,send)
                for message in messages:await send(message)
            else:await app(scope,receive,send)
    uvicorn.Server(uvicorn.Config(Observe(), log_level='warning')).run(sockets=[sock])


if __name__ == '__main__':
    main()
