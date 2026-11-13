def main():
    """Actual task control handlers with inert queued work; no worker/model execution."""
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
    from ouroboros.gateway.tasks import api_task_cancel, api_task_resume, api_task_get, _record_stop
    from ouroboros.gateway.state import api_state
    from ouroboros.owner_mailbox import _mailbox_path, drain_owner_entries
    calls = []
    responses = []
    seen = set()
    audit = []
    receipt_rules = []
    hurry_contexts = {}
    from ouroboros.gateway import work_projection
    original_upkeep = work_projection._inflight_upkeep

    async def work_gap_control(request):
        body = await request.json()
        def unavailable(*args, **kwargs):
            raise OSError('fixture unreadable answer upkeep')
        work_projection._inflight_upkeep = unavailable if body.get('fail') else original_upkeep
        # A real state production must observe the changed reader, rather than a cached publication.
        request.app.state.state_publication = None
        with queue._queue_lock:
            queue.publish_queue_snapshot(reason='fixture_work_gap')
        return JSONResponse({'ok': True})

    async def attention_gap_control(request):
        body = await request.json()
        from ouroboros.projects_registry import create_project, get_project
        from ouroboros.task_results import write_task_result
        from ouroboros.model_wait import mutate_wait
        project = get_project(data, 'attention-project') or create_project(data, 'attention-project', name='Attention Project')
        tid = 'attention-gap-task'
        task = {'id':tid,'root_task_id':tid,'project_id':project['id'],'chat_id':project['chat_id'],
                'budget_drive_root':str(data),'_attempt':3}
        write_task_result(data,tid,'running',root_task_id=tid,project_id=project['id'],chat_id=project['chat_id'])
        old = {'wait_id':'main','revision':1,'task_attempt':3,'state':'waiting','reason':'auth',
               'requires_owner_action':True,'auto_continue':False}
        mutate_wait(data,tid,'main',lambda _: old)
        task['model_waits'] = {'main':{**old,'revision':'unreadable'} if body.get('fail') else old}
        with queue._queue_lock:
            workers.RUNNING[tid] = {'task':task,'attempt':3,'started_at':1.0}
            queue.publish_queue_snapshot(reason='fixture_attention_gap')
        request.app.state.state_publication = None
        return JSONResponse({'ok':True,'chat_id':project['chat_id']})

    project_registry_bytes = None

    async def project_hold_control(request):
        nonlocal project_registry_bytes
        body = await request.json()
        from ouroboros import projects_registry as registry
        from supervisor.task_admission import revalidate_project_holds
        path = registry._registry_path(data)
        if body['action'] == 'setup':
            return JSONResponse(registry.create_project(data, 'hold-project', name='Original Project'))
        with queue._queue_lock:
            if body['action'] == 'hold':
                assert queue.persist_queue_snapshot()
                project_registry_bytes = path.read_bytes()
                path.write_text('{torn', encoding='utf-8')
                workers.PENDING.clear()
                queue.restore_pending_from_snapshot()
                assert len(workers.PENDING) == 1
                assert workers.PENDING[0].get('_project_admission_restore_hold')
            elif body['action'] == 'heal':
                path.write_bytes(project_registry_bytes)
                revalidate_project_holds()
            queue.publish_queue_snapshot(reason='fixture_project_hold')
        request.app.state.state_publication = None
        return JSONResponse({'ok': True})

    async def hurry_control(request):
        body = await request.json()
        task_id = body['task_id']
        from ouroboros.owner_hurry import apply_latch, retry_reset
        from ouroboros.owner_mailbox import KIND_HURRY
        current = load_task_result(data, task_id)
        attempt = (current.get('owner_hurry') or {}).get('attempt_key', 1)
        if body['action'] == 'apply':
            ctx = hurry_contexts.setdefault((task_id, attempt), SimpleNamespace(task_id=task_id, task_attempt=attempt, drive_root=data))
            for entry in drain_owner_entries(data, task_id, seen_ids=set(), kinds={KIND_HURRY}):
                apply_latch(ctx, entry)
        elif body['action'] == 'retry':
            retry_reset(data, data, task_id, reason='fixture_same_id_retry')
            with queue._queue_lock:
                for task in workers.PENDING:
                    if task.get('id') == task_id:
                        task['_attempt'] = attempt + 1
                queue.publish_queue_snapshot(reason='fixture_hurry_retry')
        elif body['action'] == 'terminal':
            assert current.get('status') in {'completed', 'failed', 'cancelled', 'rejected_duplicate'}
            from supervisor.queue_transitions import reconcile_terminal_task_projections
            reconcile_terminal_task_projections(data, task_id)
        return JSONResponse({'ok': True})

    async def receipt_control(request):
        body = await request.json()
        if body.get('hard_intent'):
            import asyncio
            await asyncio.to_thread(_record_stop, body['hard_intent'], cascade=False, stop_action_id='fixture-hard-intent')
        receipt_rules[:] = body.get('rules', [])
        return JSONResponse({'ok': True})

    async def cancellation_control(request):
        body = await request.json()
        from ouroboros.task_results import write_task_result
        from ouroboros.cancel_intents import request_cancel, settle_intent
        task_id = body['task_id']
        if body['action'] == 'seed':
            write_task_result(data, task_id, 'running', result='Work in progress')
        elif body['action'] == 'request':
            request_cancel(data, task_id, reason=body.get('reason', ''), requested_stop_policy=body.get('policy', 'immediate'))
        elif body['action'] == 'settle':
            write_task_result(data, task_id, 'cancelled', result='Retained partial result')
            settle_intent(data, task_id, outcome='cancelled', detail='fixture terminal writer')
        with queue._queue_lock:
            queue.publish_queue_snapshot(reason='fixture_cancellation')
        return JSONResponse({'ok': True})

    async def stop_origin_control(request):
        body = await request.json()
        from ouroboros.task_results import write_task_result
        from ouroboros.task_status import observe_cancellation_target
        from ouroboros.cancel_intents import request_cancel, settle_intent
        from supervisor.cancel_publication import _intent_outcome_fields
        task_id = body['task_id']
        write_task_result(data, task_id, 'running', chat_id=1,
            parent_task_id=body.get('parent_task_id', ''), root_task_id=body.get('root_task_id', task_id))
        observation = observe_cancellation_target(data, task_id, request_origin=body.get('request_origin'))
        intent = request_cancel(data, task_id, source=body['source'], reason=body.get('reason', ''),
            requested_by=body.get('requested_by', ''), scope=body.get('scope', 'single'),
            requested_stop_policy='finalize_then_cancel' if body.get('harden') else body.get('policy', 'immediate'), observation=observation)
        if body.get('harden'):
            intent = request_cancel(data, task_id, source=body['source'], reason=body.get('reason', ''),
                requested_by=body.get('requested_by', ''), scope=body.get('scope', 'single'),
                requested_stop_policy='immediate', observation=observation)
        assert intent.get('request_id'), intent
        fields = _intent_outcome_fields(intent)
        write_task_result(data, task_id, 'cancelled', result='Fixture retained work', **fields)
        settle_intent(data, task_id, outcome='cancelled', detail='fixture stop origin publication writer')
        with queue._queue_lock: queue.publish_queue_snapshot(reason='fixture_stop_origin')
        return JSONResponse({'ok': True, 'origin': fields['cancel_origin']})

    async def reconciliation_control(request):
        body = await request.json()
        from ouroboros import delegate_custody as custody, delegate_terminal
        from ouroboros.task_results import write_task_result
        task_id = body['task_id']
        run_ids = [f'fixture-run-{n:02d}' for n in range(15)]
        if body['action'] == 'seed':
            write_task_result(data, task_id, 'completed', result='Retained original answer <&>',
                reason_code='delegated_custody_unreconciled',
                outcome_axes={'lifecycle':{'status':'completed'}, 'execution':{'status':'ok','reason_code':'final_message'},
                    'objective':{'status':'not_evaluated','warning':'delegated_custody_unreconciled',
                        'warnings':['delegated_custody_unreconciled','other_warning']}})
            for index, run_id in enumerate(run_ids):
                assert custody.emit(data, custody.STARTED, {'run_id':run_id,'task_id':task_id,'route':'fixture',
                    'model':f'fixture-model-{index:02d}','profile_id':'fixture-profile','selected_subagent_id':'fixture-agent',
                    'snapshot_id':f'fixture-snapshot-{index:02d}','shape':{}})
                if index < 14:
                    assert custody.emit(data, custody.SETTLED, {'run_id':run_id,'task_id':task_id,'route':'fixture',
                        'state':'cancelled','cost_usd':0.0,'cost_final':True,'spend_disclosed':True})
        elif body['action'] == 'settle':
            assert custody.emit(data, custody.SETTLED, {'run_id':run_ids[-1],'task_id':task_id,'route':'fixture',
                'state':'cancelled','cost_usd':0.0,'cost_final':True,'spend_disclosed':True})
            for run_id in run_ids:
                assert custody.emit(data, custody.PATCH_DISPOSED, {'run_id':run_id,'task_id':task_id,'disposition':'rejected'})
        changed = delegate_terminal.refresh_terminal_reconciliation(data, task_id, trigger='fixture_custody_refresh')
        with queue._queue_lock: queue.publish_queue_snapshot(reason='fixture_reconciliation')
        return JSONResponse({'ok': True,'changed':changed,'record':load_task_result(data,task_id)})

    source_artifacts = {}
    source_release = __import__('asyncio').Event(); source_release.set()
    source_root_wire = {'bad':False}
    async def retained_source_control(request):
        body = await request.json()
        from ouroboros import delegate_custody as custody, delegate_terminal
        from ouroboros.delegate_output import retain_terminal_bytes
        from ouroboros.task_results import write_task_result
        owner, stager = 'retained-publisher', 'retained-stager'
        action = body['action']
        if action == 'seed':
            os.environ['OUROBOROS_FILE_BROWSER_DEFAULT'] = str(data)
            write_task_result(data, owner, 'completed', result='Publisher answer stays intact', reason_code='final_message')
            write_task_result(data, stager, 'completed', result='Staging task')
            for n in range(3):
                run_id=f'file-run-{n}'
                text = ('Retained delegated output <&> Ω\n' + ('Partial observation' if n==1 else 'Full collected payload')) if n<2 else 'Large retained output\n'+'x'*300000
                artifact=retain_terminal_bytes(data, stager, run_id, text, text.encode())
                assert artifact
                source_artifacts[run_id]={'artifact':artifact, 'text':text}
                assert custody.emit(data,custody.STARTED,{'run_id':run_id,'task_id':owner,'route':'fixture','model':'fixture-model','shape':{}})
                assert custody.emit(data,custody.SETTLED,{'run_id':run_id,'task_id':owner,'route':'fixture','state':'succeeded','cost_usd':0.0,'cost_final':True,'spend_disclosed':True})
                assert custody.emit(data,custody.OUTPUT_SPILLED,{'run_id':run_id,'task_id':owner,'artifact':artifact['source']['path'],
                    'source':artifact['source'],'bytes':artifact['bytes'],'sha256':artifact['sha256'],'staged':True,'full_content':n!=1})
            delegate_terminal.refresh_terminal_reconciliation(data,owner,trigger='fixture_retained_source')
            with queue._queue_lock: queue.publish_queue_snapshot(reason='fixture_retained_source')
        elif action == 'root': os.environ['OUROBOROS_FILE_BROWSER_DEFAULT'] = str({'data':data,'broader':run,'outside':repo}[body['value']])
        elif action == 'corrupt':
            item=source_artifacts[body.get('run_id','file-run-0')]
            raw=item['text'].encode();pathlib.Path(item['artifact']['path']).write_bytes((bytes([raw[0]^1])+raw[1:]) if body.get('value',True) else raw)
        elif action == 'hold-root':source_release.clear()
        elif action == 'release-all':source_release.set()
        elif action == 'bad-root':source_root_wire['bad']=body.get('value',True)
        return JSONResponse({'ok':True,'artifacts':source_artifacts,
            'consumed':{row.run_id:row.output_consumed for row in custody.replay(data).values() if row.task_id==owner}})

    async def retention_control(request):
        # Seed actual stored placement facts; no filesystem promotion worker is run.
        body = await request.json()
        from ouroboros.task_results import write_task_result
        write_task_result(data, body['task_id'], 'completed', result='Fixture completed task',
                          child_ref_promotion=body['promotion'])
        with queue._queue_lock:
            queue.publish_queue_snapshot(reason='fixture_retention')
        return JSONResponse({'ok': True})

    def wire_response(task_id, action, response):
        for index, rule in enumerate(receipt_rules):
            if rule.get('task_id') != task_id or rule.get('action') != action:
                continue
            receipt_rules.pop(index)
            body = rule['body'] if 'body' in rule else {**json.loads(response.body), **rule.get('patch', {})}
            if isinstance(body, dict):
                for key in rule.get('omit', []):
                    body.pop(key, None)
            return JSONResponse(body, status_code=rule.get('status', response.status_code))
        return response

    async def detail(request):
        return wire_response(request.path_params['task_id'], 'detail', await api_task_get(request))

    async def state_view(request):
        return wire_response('', 'state', await api_state(request))

    async def control(request):
        action = request.url.path.rsplit('/', 1)[-1]
        body = await request.json()
        task_id = request.path_params['task_id']
        response = await {'pause': api_task_pause, 'hurry': api_task_hurry, 'cancel': api_task_cancel, 'resume': api_task_resume}[action](request)
        reply = json.loads(response.body)
        event = dict(task_id=task_id, action=action, body=body, status=response.status_code, reply=reply)
        responses.append(event)
        if action != 'resume':
            calls.append(event)
        if task_id in {'ctl-hurry-lost', 'ctl-pause-lost', 'ctl-pause-quick-lost', 'jr-pause-lost',
                       'jr-quick-lost', 'jr-hurry-lost', 'jr-stop-lost', 'jr-wrap-lost', 'jr-resume-lost', 'jr-native-lost'} and sum(row['task_id'] == task_id and row['action'] == action for row in calls) == 1 and response.status_code < 300:
            return JSONResponse({'error': 'fixture response unavailable after durable action'}, status_code=503)
        return wire_response(task_id, action, response)

    async def facts(request):
        ids = {row.get('id') for row in workers.PENDING} | {row['task_id'] for row in calls} | seen
        def mail(task):
            path = _mailbox_path(data, task)
            return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
        return JSONResponse(json.loads(json.dumps(dict(calls=calls, responses=responses, audit=audit, pending=workers.PENDING,
            chat_bytes=(data / 'logs/chat.jsonl').stat().st_size,
            hurry_events=[row for row in (json.loads(line) for line in (data / 'logs/events.jsonl').read_text().splitlines()) if row.get('type') == 'owner_hurry'] if (data / 'logs/events.jsonl').exists() else [],
            records={key: load_task_result(data, key) for key in ids},
            fences={key: read_fence(data, key) for key in ids}, mail={key: mail(key) for key in ids},
            drained_mail={key: drain_owner_entries(data, key, seen_ids=set()) for key in ids},
            snapshot=json.loads(queue.QUEUE_SNAPSHOT_PATH.read_text())), default=str)))

    routes = [route for route in collect_routes(data_dir=data) if not (getattr(route, 'path', '') in {'/api/state', '/api/tasks/{task_id}/pause', '/api/tasks/{task_id}/hurry', '/api/tasks/{task_id}/cancel', '/api/tasks/{task_id}/resume', '/api/tasks/{task_id}'})]
    app = Starlette(routes=[Route('/fixture/facts', facts), Route('/fixture/retained-source', retained_source_control, methods=['POST']), Route('/fixture/reconciliation', reconciliation_control, methods=['POST']), Route('/fixture/stop-origin', stop_origin_control, methods=['POST']), Route('/fixture/cancellation', cancellation_control, methods=['POST']), Route('/fixture/project-hold', project_hold_control, methods=['POST']), Route('/fixture/receipt', receipt_control, methods=['POST']), Route('/fixture/hurry', hurry_control, methods=['POST']), Route('/fixture/retention', retention_control, methods=['POST']), Route('/fixture/work-gap', work_gap_control, methods=['POST']), Route('/fixture/attention-gap', attention_gap_control, methods=['POST']),
        Route('/api/tasks/{task_id}', detail, methods=['GET']),
        Route('/api/state',state_view,methods=['GET']),
        Route('/api/tasks/{task_id}/pause', control, methods=['POST']),
        Route('/api/tasks/{task_id}/hurry', control, methods=['POST']),
        Route('/api/tasks/{task_id}/cancel', control, methods=['POST']),
        Route('/api/tasks/{task_id}/resume', control, methods=['POST']), *routes])
    app.state.drive_root = data
    app.state.repo_dir = repo
    app.state.supervisor_ready_event = threading.Event()
    app.state.supervisor_ready_event.set()
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    (run / 'port').write_text(str(sock.getsockname()[1]))
    class Observe:
        async def __call__(self, scope, receive, send):
            if scope['type'] == 'http' and scope['path'].startswith('/api/'):
                if scope['path'].startswith('/api/tasks/'):
                    seen.add(scope['path'].split('/')[3])
                event = dict(method=scope['method'], path=scope['path'], query=scope.get('query_string',b'').decode());audit.append(event)
                original_receive = receive
                chunks = []
                async def receive():
                    message = await original_receive()
                    if message['type'] == 'http.request':
                        chunks.append(message.get('body', b''))
                        if not message.get('more_body'):
                            try: event['body'] = json.loads(b''.join(chunks))
                            except Exception: pass
                    return message
            if scope['type']=='http' and scope['path']=='/api/files/list':
                messages=[]
                async def collect(message):messages.append(message)
                await app(scope,receive,collect)
                await source_release.wait()
                if source_root_wire['bad'] and messages[0]['status']==200:
                    payload=json.loads(b''.join(message.get('body',b'') for message in messages));payload['root_path']=42
                    return await JSONResponse(payload)(scope,receive,send)
                for message in messages:await send(message)
                return
            await app(scope, receive, send)
    uvicorn.Server(uvicorn.Config(Observe(), log_level='warning')).run(sockets=[sock])


# Stop can start the upstream event-queue manager with multiprocessing spawn.
# Its import of this module must not recreate the fixture or start another HTTP server.
if __name__ == "__main__":
    main()
