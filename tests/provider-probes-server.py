def main():
    """Real interface-language/memory API with no generator or model execution."""
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
    from ouroboros.gateway.router import collect_routes
    sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];base=f'http://127.0.0.1:{port}'
    seed=json.loads(config.SETTINGS_PATH.read_text());seed.update(OPENAI_COMPATIBLE_API_KEY='fixture-dedicated',OPENAI_COMPATIBLE_BASE_URL=base+'/dedicated/v1',
      OPENAI_API_KEY='fixture-legacy',OPENAI_BASE_URL=base+'/legacy/v1',OUROBOROS_MODEL='openai-compatible::fixture-probe',
      OUROBOROS_CONNECTIONS=[{'kind':'openai-compatible','name':'extra','api_key':'fixture-named','base_url':base+'/named/v1'}])
    config.SETTINGS_PATH.write_text(json.dumps(seed));initial=config.SETTINGS_PATH.read_bytes()
    audit=[];wire=[];fault={'deny':False,'receipt':'','hold':''};release=asyncio.Event();release.set()
    keys=['fixture-dedicated','fresh-dedicated','fixture-legacy','fresh-legacy','fixture-named','fresh-named']
    async def provider(request):
        auth=request.headers.get('authorization','').removeprefix('Bearer ')
        record={'method':request.method,'path':request.url.path,'credential':keys.index(auth) if auth in keys else -1};wire.append(record)
        if request.method=='GET':return JSONResponse({'data':[{'id':m} for m in ['fixture-probe','second-model','last-model']]})
        body=await request.json();record['body']=body
        if fault['deny']:
            fault['deny']=False
            return JSONResponse({'error':{'message':'Rejected '+auth,'type':'authentication_error','code':'invalid_api_key'}},status_code=401)
        return JSONResponse({'id':'fixture-completion','object':'chat.completion','created':1700000000,'model':body['model'],
          'choices':[{'index':0,'message':{'role':'assistant','content':'OK'},'finish_reason':'stop'}],
          'usage':{'prompt_tokens':2,'completion_tokens':1,'total_tokens':3}})
    async def facts(request):return JSONResponse({'audit':audit,'wire':wire,'base':base,'settings_unchanged':config.SETTINGS_PATH.read_bytes()==initial})
    async def control(request):
        body=await request.json()
        if not body:fault['deny']=True
        if 'receipt' in body:fault['receipt']=body['receipt']
        if 'hold' in body:fault['hold']=body['hold'];release.clear()
        if body.get('action')=='release':fault['hold']='';release.set()
        return JSONResponse({'ok':True})
    routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST'])]
    for name in ['dedicated','legacy','named','other']:
        routes.extend([Route('/'+name+'/v1/models',provider),Route('/'+name+'/v1/chat/completions',provider,methods=['POST'])])
    app=Starlette(routes=[*routes,*collect_routes(data_dir=data)]);app.state.drive_root=data;app.state.repo_dir=repo
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or not scope['path'].startswith('/api/'):return await app(scope,receive,send)
            raw=bytearray();messages=[];record={'method':scope['method'],'path':scope['path']}
            async def input():
                message=await receive();raw.extend(message.get('body',b''));return message
            async def output(message):messages.append(message)
            held=fault['hold']==scope['path'];mode=fault['receipt']
            await app(scope,input,output)
            if raw:
                body=json.loads(raw)
                if 'apiKey' in body:body['apiKey']='<selected synthetic key>'
                if isinstance(body.get('overrides'),dict):
                    body['overrides']={k:'<selected synthetic key>' if 'KEY' in k or k=='api_key' else v for k,v in body['overrides'].items()}
                record['body']=body
            record['status']=messages[0]['status'];audit.append(record)
            if held:await release.wait()
            if mode:
                body=json.loads(b''.join(m.get('body',b'') for m in messages))
                if mode=='ok' and scope['path']=='/api/providers/test':body['ok']='false'
                elif mode=='error' and scope['path']=='/api/providers/test':body['error']=[]
                elif mode=='models' and scope['path']=='/api/openai-compatible/models':body['models']=['first',{}]
                return await JSONResponse(body)(scope,receive,send)
            for message in messages:await send(message)
    (run/'port').write_text(str(port));uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])

if __name__=='__main__':main()
