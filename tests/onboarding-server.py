def main():
    """Actual setup bootstrap/validation/atomic completion and attempt receipts; provisioning disabled."""
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
    from ouroboros.gateway.router import collect_routes
    from ouroboros.gateway import onboarding as setup
    from ouroboros.gateway.onboarding_host import api_onboarding_bootstrap
    from ouroboros.skill_sources import load_sources
    from ouroboros.settings_setup_contract import ONBOARDING_ATTEMPT_KEY,ONBOARDING_COMPLETED_KEY
    from supervisor import state as supervisor_state
    supervisor_state.init(data);supervisor_state.init_state()
    seed=json.loads(config.SETTINGS_PATH.read_text());seed.update(OUROBOROS_SKILL_SOURCES=json.dumps([{'id':'builtin','kind':'builtin','name':'Built in','trust':'review','confirmed':True}]),OPENAI_API_KEY='fixture-setup-key',OUROBOROS_MODEL='openai::gpt-4.1',TOTAL_BUDGET=100,OUROBOROS_PER_TASK_COST_USD=10)
    config.SETTINGS_PATH.write_text(json.dumps(seed));config.apply_settings_to_env(seed)
    initial_settings=config.SETTINGS_PATH.read_bytes()
    skill=repo/'skills/native_fixture';skill.mkdir(parents=True)
    (skill/'SKILL.md').write_text(chr(10).join(['---','name: native_fixture','description: Native fixture starter','---','Inert starter payload.','']))
    (repo/'skills/builtin.json').write_text(json.dumps({'skills':[{'name':'native_fixture','recommended':True,'category':['fixture']}]}))
    provision=[];audit=[];calls=[];release=asyncio.Event();release.set();fault={'bootstrap':'','attempt':'','starter':'','mode':'','hold':'','preview':''}
    setup.after_onboarding=lambda root,choices:provision.append({'choices':choices})
    async def facts(request):
        settings=config.load_settings()
        response=await api_onboarding_bootstrap(request);body=json.loads(response.body)
        return JSONResponse({'audit':audit,'calls':calls,'provision':provision,'contract':body['bootstrap']['contract'],'sources':load_sources(settings),
            'attempt':settings.get(ONBOARDING_ATTEMPT_KEY),'completed':bool(settings.get(ONBOARDING_COMPLETED_KEY)),
            'settings_unchanged':config.SETTINGS_PATH.read_bytes()==initial_settings,'stored_key':settings.get('OPENAI_API_KEY')=='fixture-setup-key','budget':settings.get('TOTAL_BUDGET'),'starters':settings.get('OUROBOROS_STARTER_SKILLS')})
    async def control(request):
        body=await request.json()
        if body.get('action')=='release-all':fault['hold']='';release.set()
        if body.get('action') in {'unready','ready'}:
            settings=config.load_settings();settings['OPENAI_API_KEY']='' if body['action']=='unready' else 'fixture-setup-key'
            config.SETTINGS_PATH.write_text(json.dumps(settings));config.apply_settings_to_env(settings)
        if 'hold' in body:fault['hold']=body['hold'];release.clear()
        for key in ('bootstrap','attempt','starter','mode','preview'):
            if key in body:fault[key]=body[key]
        return JSONResponse({'ok':True})
    async def complete(request):
        body=await request.json();record={'attempt':body.get('attempt_id'),'body':copy.deepcopy(body)};calls.append(record)
        if fault['hold']=='post':await release.wait()
        if fault['mode']=='before':return JSONResponse({'error':'Fixture lost response before admission'},status_code=503)
        response=await setup.api_onboarding_complete(request);record.update(status=response.status_code,reply=json.loads(response.body))
        if fault['mode']=='after' and response.status_code==200:return JSONResponse({'error':'Fixture lost save response'},status_code=503)
        if fault['mode']=='receipt' and response.status_code==200:
            body=json.loads(response.body);body['preset']=None
            return JSONResponse(body)
        return response
    routes=[r for r in collect_routes(data_dir=data) if not (getattr(r,'path','')=='/api/onboarding/complete' and 'POST' in getattr(r,'methods',set()))]
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),Route('/api/onboarding/complete',complete,methods=['POST']),*routes]);app.state.drive_root=data;app.state.repo_dir=repo
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or not scope['path'].startswith('/api/'):return await app(scope,receive,send)
            path=scope['path'];record={'path':path,'method':scope['method'],'query':scope.get('query_string',b'').decode(),'authorized':any(k==b'authorization' for k,v in scope.get('headers',[]))};audit.append(record)
            if scope['method']=='GET' or path.endswith('/subagents/preview'):
                messages=[]
                async def output(message):messages.append(message)
                raw=bytearray()
                async def input():
                    message=await receive();raw.extend(message.get('body',b''));return message
                await app(scope,input,output)
                if raw:record['body']=json.loads(raw)
                record['status']=messages[0]['status'];content=b''.join(m.get('body',b'') for m in messages)
                if fault['hold']==path:await release.wait()
                mode=fault['bootstrap'] if path.endswith('/bootstrap') else fault['attempt'] if path=='/api/onboarding/complete' else fault['starter'] if path.endswith('/starter-skills') else fault['preview'] if path.endswith('/subagents/preview') else ''
                if mode=='http':return await JSONResponse({'error':'Fixture setup read unavailable'},status_code=503)(scope,receive,send)
                if content and messages[0]['status']==200 and path!='/api/onboarding':
                    body=json.loads(content)
                    if path.endswith('/bootstrap'):
                        if mode=='contract':body['bootstrap']['contract']['modelSlots']=[None]
                        elif mode=='state':body['bootstrap']['initialState']=[]
                    elif path=='/api/onboarding/complete' and mode=='receipt':body['receipt']={}
                    elif path.endswith('/starter-skills') and mode=='groups':body['groups']=[None]
                    elif path.endswith('/subagents/preview'):
                        if mode=='offer':body['model_settings']={'OUROBOROS_MODEL_LIGHT':'openai::fixture-light'}
                        elif mode=='row':body['available_subagents']['items'][0]['route']['target_id']=[]
                        elif mode=='models':body['model_settings']['OUROBOROS_MODEL']=False
                        elif mode=='options':body['model_settings']['OUROBOROS_PROCESSING_PREFERENCE']={}
                        elif mode=='diagnostics':body['diagnostics']=[None]
                        elif mode=='duplicate':body['available_subagents']['items'].append(body['available_subagents']['items'][0])
                    record['saved']=body.get('saved')
                    return await JSONResponse(body,status_code=messages[0]['status'])(scope,receive,send)
                for message in messages:await send(message)
                return
            return await app(scope,receive,send)
    sock=socket.socket();sock.bind(('127.0.0.1',0));(run/'port').write_text(str(sock.getsockname()[1]))
    uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])

if __name__=='__main__':main()
