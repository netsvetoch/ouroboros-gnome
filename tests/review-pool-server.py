def main():
    """Real review-pool projection over an isolated roster, usage ledger and execution receipts."""
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
    history=[]
    for wave,costs in enumerate(((.1,.2,.01),(.5,.4,.01),(1,1.5,.02))):
        for index,cost in enumerate(costs):
            attempt={'attempt_id':f'fixture-{wave}-{index}','kind':'attempt','root_task_id':'fixture','task_id':'fixture',
              'provider':'openrouter','model':'openrouter/fake-reviewer' if index<2 else 'openrouter/fake-light',
              'category':'multi_model_review_review','review_wave_id':f'wave-{wave}','review_slot_id':'critic',
              'reservation_upper_bound_usd':5.0,'pricing_known':True,'ts':'2026-11-01T00:00:00Z'}
            for state in ('reserved','dispatched','settled'):
                history.append({**attempt,'state':state,**({'cost_usd':cost,'cost_final':True} if state=='settled' else {})})
    journal=data/'state/usage_attempts.jsonl';journal.parent.mkdir(parents=True,exist_ok=True)
    journal.write_text(''.join(json.dumps({'seq':i+1,**row})+'\n' for i,row in enumerate(history)))
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
    from ouroboros.gateway.router import collect_routes
    from ouroboros.reviewer_slot_config import review_pool_slots,record_reviewer_slot_executions
    def row(name,target,**fields):return {'subagent_id':name,'recommended_use':'Fixture <&> 🔧',
      'route':{'kind':'api_model','target_id':target},'review_eligible':True,**fields}
    items=[row('critic','openrouter/fake-reviewer',effort='medium',delivery='packet'),row('local','fixture (local)'),
      {'subagent_id':'session','recommended_use':'Session fixture','route':{'kind':'agent_session','target_id':'codex=gpt-5.6-sol','credential_profile_id':'requested-profile'},
       'effort':'high','access':'readonly','processing_preference':'economy','review_eligible':True},
      row('unknown','openrouter/no-history'),row('off','openrouter/off',enabled=False),
      row('helper','openrouter/helper',review_eligible=False)]
    roster={'enabled':False,'items':items}
    def configure(raw):
        seed=json.loads(config.SETTINGS_PATH.read_text());seed['OUROBOROS_SUBAGENTS']=raw;config.SETTINGS_PATH.write_text(json.dumps(seed));os.environ['OUROBOROS_SUBAGENTS']=raw
    configure(json.dumps(roster));os.environ['USE_LOCAL_MAIN']='0'
    slots={slot.slot_id:slot for slot in review_pool_slots()}
    actors=[SimpleNamespace(slot_id='critic',status='ok',usage={'cost':.13,'verdict_method':'fixture-json <&>',
      'processing':{'requested':'standard','submitted':'standard'},'effort_resolution':{'submitted':'medium','observed':'medium','observedSource':'fixture-provider'}}),
      SimpleNamespace(slot_id='session',status='ok',usage={'delegated_route':'codex','applied_profile':'applied-profile',
        'applied_access':'readonly','resolved_model':'','verdict_method':'fixture-session','processing':{'requested':'economy','submitted':'standard','reason':'fixture fallback <&> 🔧'},
        'effort_resolution':{'submitted':'high','observed':'medium','observedSource':'fixture-engine'},
        'observed_attempt':{'prompt_cache_ttl':{'requested':'1h','submitted':'1h','observed':'1h','write_1h_tokens':17,'write_5m_tokens':0}},
        'capability_delta':[{'name':'fixture capability <&> 🔧','before':True,'after':False}]})]
    record_reviewer_slot_executions('fixture_review',actors,slots,record_id='fixture-review-record')
    record_reviewer_slot_executions('older_review',[SimpleNamespace(slot_id='retired',status='failed',usage={})],
      {'retired':SimpleNamespace(slot_id='retired',model='openrouter/old',route=SimpleNamespace(value='api_chat'),effort='low')},record_id='old-record')
    initial=config.SETTINGS_PATH.read_bytes();audit=[];fault={'mode':''};release=asyncio.Event();release.set()
    async def facts(request):
        return JSONResponse({'audit':audit,'settings_unchanged':config.SETTINGS_PATH.read_bytes()==initial,
          'last':json.loads((data/'state/reviewer_slot_last_execution.json').read_text()) if (data/'state/reviewer_slot_last_execution.json').exists() else {}})
    async def control(request):
        action=(await request.json())['action']
        if action=='hold':release.clear()
        elif action=='release-all':release.set()
        elif action=='fail':fault['mode']='fail'
        elif action=='malformed':fault['mode']='malformed'
        elif action=='malformed-row':fault['mode']='malformed-row'
        elif action=='clear':fault['mode']=''
        elif action=='empty':configure(json.dumps({'enabled':False,'items':[]}))
        elif action=='invalid':configure('{not valid json')
        elif action=='restore':configure(json.dumps(roster))
        return JSONResponse({'ok':True})
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),*collect_routes(data_dir=data)])
    app.state.drive_root=data;app.state.repo_dir=repo
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or not scope['path'].startswith('/api/'):return await app(scope,receive,send)
            messages=[];record={'method':scope['method'],'path':scope['path']};audit.append(record)
            async def output(message):messages.append(message)
            await app(scope,receive,output);record['status']=messages[0]['status']
            try:record['reply']=json.loads(b''.join(m.get('body',b'') for m in messages))
            except Exception:pass
            if scope['path']=='/api/review-pool':
                await release.wait()
                mode=fault['mode']
                if mode:
                    return await JSONResponse({'error':'fixture review-pool unavailable'} if mode=='fail' else {'pool':[None] if mode=='malformed-row' else None,'excluded':[]},
                      status_code=503 if mode=='fail' else 200)(scope,receive,send)
            for message in messages:await send(message)
    sock=socket.socket();sock.bind(('127.0.0.1',0));(run/'port').write_text(str(sock.getsockname()[1]))
    uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])

if __name__=='__main__':main()

