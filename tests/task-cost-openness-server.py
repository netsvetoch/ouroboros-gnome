def main():
    """Real task cost projections from imported physical-attempt facts; no calls execute."""
    import json, os, pathlib, socket, sys
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    run = pathlib.Path(sys.argv[1]); data = run / 'data'; repo = run / 'repo'
    for key in list(os.environ):
        if key.startswith('OUROBOROS_'): os.environ.pop(key)
    os.environ.update(OUROBOROS_APP_ROOT=str(run), OUROBOROS_DATA_DIR=str(data), OUROBOROS_REPO_DIR=str(repo), OUROBOROS_SETTINGS_PATH=str(data/'settings.json'))
    for p in (data/'logs', data/'state', data/'memory', repo): p.mkdir(parents=True, exist_ok=True)
    from ouroboros import config, store_import, usage_store
    from ouroboros.settings_setup_contract import SECRET_SETTING_KEYS
    for key in SECRET_SETTING_KEYS: os.environ.pop(key, None)
    config.initialize_runtime_mode_baseline('light'); config.SETTINGS_PATH.write_text('{}'); initial = config.SETTINGS_PATH.read_bytes()
    rows = []
    for name, task, states, bound, price in (
        ('reserved', 'cost-root', ['reserved'], .5, None),
        ('unresolved', 'cost-root', ['reserved','dispatched'], .75, None),
        ('settled', 'cost-root', ['reserved','dispatched','settled'], .5, .2),
        ('child', 'cost-child', ['reserved','dispatched','settled'], .5, .4),
    ):
        for state in states:
            rows.append(dict(seq=len(rows)+1, kind='attempt', attempt_id='fixture-'+name, state=state,
                task_id=task, root_task_id='cost-root', provider='fixture-provider', model='fixture-model', category='task',
                reservation_upper_bound_usd=bound, pricing_known=True, ts='2026-11-13T00:00:00Z',
                **(dict(cost_usd=price,cost_final=True) if state=='settled' else {})))
    roots = {'healthy':data, 'degraded':run/'degraded'}
    from ouroboros.task_results import write_task_result
    for name, root in roots.items():
        for p in (root/'logs',root/'state',root/'memory'): p.mkdir(parents=True, exist_ok=True)
        for log in ('chat','progress'): (root/'logs'/f'{log}.jsonl').write_text('')
        (root/'state/usage_attempts.jsonl').write_text(''.join(json.dumps(row)+'\n' for row in rows) + ('{"seq":' if name=='degraded' else ''))
        store_import.ensure_current_store(root)
        usage_store.migrate_from_journal(root)
        from supervisor.state import reconstruct_task_cost
        write_task_result(root,'cost-root','scheduled',chat_id=1,description='Synthetic cost projection task',**reconstruct_task_cost('cost-root',fields=True,drive_root=root))
        write_task_result(root,'cost-child','scheduled',chat_id=1,parent_task_id='cost-root',root_task_id='cost-root',**reconstruct_task_cost('cost-child',fields=True,drive_root=root))
    from supervisor import queue, workers, state
    from types import SimpleNamespace
    state.init(data); queue.init(data); queue.init_queue_refs(workers.PENDING,workers.RUNNING,workers.QUEUE_SEQ_COUNTER_REF)
    workers.WORKERS={0:SimpleNamespace(busy_task_id=None,reaping=False)}
    workers._WORKER_POOL_DISABLED_REASON=''
    from ouroboros.gateway.tasks import api_task_get
    from ouroboros.gateway.router import collect_routes
    selected = {'root':'healthy'}; audit=[]
    async def facts(request):
        return JSONResponse(dict(audit=audit,selected=selected,settings_unchanged=config.SETTINGS_PATH.read_bytes()==initial,
            integrity={name:usage_store.integrity_degraded(root) for name,root in roots.items()}))
    async def control(request):
        body=await request.json(); selected['root']=body['root']; app.state.drive_root=roots[body['root']]
        return JSONResponse({'ok':True})
    routes=collect_routes(data_dir=data)
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),
        Route('/api/tasks/{task_id}',api_task_get),*routes]); app.state.drive_root=data;app.state.repo_dir=repo
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']=='http' and scope['path'].startswith('/api/tasks/'):
                audit.append({'method':scope['method'],'path':scope['path'],'root':selected['root']})
            await app(scope,receive,send)
    sock=socket.socket();sock.bind(('127.0.0.1',0));(run/'port').write_text(str(sock.getsockname()[1]))
    uvicorn.Server(uvicorn.Config(Observe(),log_level='warning',lifespan='off')).run(sockets=[sock])
if __name__=='__main__':main()
