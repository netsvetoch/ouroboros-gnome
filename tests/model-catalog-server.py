def main():
    """Real model-catalog/provider fetch API; account inventory is isolated, no inference."""
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
    from ouroboros.gateway import models
    sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    seed=json.loads(config.SETTINGS_PATH.read_text())
    seed.update(OPENAI_COMPATIBLE_API_KEY='fixture-catalog-key',OPENAI_COMPATIBLE_BASE_URL=f'http://127.0.0.1:{port}/provider/v1',
      OUROBOROS_CONNECTIONS=[{'kind':'openai-compatible','name':'broken','api_key':'fixture-broken-key','base_url':f'http://127.0.0.1:{port}/broken/v1'}])
    config.SETTINGS_PATH.write_text(json.dumps(seed))
    # Keep account-daemon discovery isolated. The ordinary provider fetch/parser below is real HTTP.
    def subscription(source_id='',profile_id=''):
        return {'items':[], 'errors':[], 'model_sources':[{'id':'fixture-source','label':'Fixture source'}],
          'account_catalogs':[{'source':'fixture-source','accounts':[{'credentialProfileId':'fixture-profile','label':'Fixture profile'}]}], 'partial':False}
    if '--accounts' not in sys.argv[2:]:models._subscription_model_catalog=subscription
    else:
        from ouroboros import claudexor_daemon as owned
        accounts=[]
        for suffix,availability in [('a','available'),('b','unavailable'),('c','unknown'),('d','available')]:
            profile='fixture-'+suffix
            catalog=None if suffix=='c' else {'source':'fixture-source','credentialProfileId':profile,
              'accountFingerprint':'fingerprint-'+suffix,'provenance':'native account fixture','observedAt':None if suffix=='b' else '2026-11-12T00:00:00Z',
              'models':[] if suffix=='d' else [{'id':'shared','label':'Shared '+suffix.upper(),
                'contextWindow':{'value':1000000,'basis':'reported context'} if suffix=='b' else 272000,
                'maxContextWindow':1000000,'maxOutputTokens':8192,'reasoningEfforts':['high' if suffix=='b' else 'medium'],
                'defaultReasoningEffort':'high' if suffix=='b' else 'medium','inputModalities':['text','image'],
                'supportedOptions':['processingPreference'],'processing':{'modes':['standard','fast'] if suffix=='b' else ['standard'],'eligible':None}},
                {'id':'only-'+suffix,'label':'Only '+suffix.upper()}]}
            problem={'code':'subscription_window_exhausted','message':'Window spent <&> 🔧','context':{}} if suffix=='b' else {'code':'model_catalog_unavailable','message':'Could not read account C <&>','context':{}} if suffix=='c' else None
            accounts.append({'credentialProfileId':profile,'label':'Account '+suffix.upper(),'availability':availability,'problem':problem,'catalog':catalog})
        class AccountGateway:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def operations(self):return [{'method':'GET','path':path,'parameters':[{'name':'view','location':'query','enum':['accounts']}]} for path in ('/v2/model-sources','/v2/model-sources/:id/models')]
            def list_model_sources(self,**kwargs):
                account_calls.append({'op':'sources','options':kwargs})
                return {'sources':[{'id':'fixture-source','label':'Fixture CLI','credentialHarness':'codex','processingPreferences':['standard','fast'],'accountCatalog':True}]}
            def list_source_models(self,source,credential_profile_id=None,**kwargs):
                account_calls.append({'op':'models','source':source,'profile':credential_profile_id,'options':kwargs})
                selected=[row for row in accounts if not credential_profile_id or row['credentialProfileId']==credential_profile_id]
                return {'source':source,'accounts':selected,'partial':any(row['catalog'] is None for row in selected)}
        owned.owned_daemon_provisioned=lambda:True
        owned.read_owned_gateway=lambda:AccountGateway()
    account_calls=[]
    initial_settings=config.SETTINGS_PATH.read_bytes()
    status_mode={'value':''}
    audit=[];provider_reads=[];hold={'value':None,'malformed':False,'fault':''}
    async def provider(request):
        broken=request.url.path.startswith('/broken')
        provider_reads.append({'path':request.url.path,'credential_matches':request.headers.get('authorization')==('Bearer fixture-broken-key' if broken else 'Bearer fixture-catalog-key')})
        if broken:return JSONResponse({'error':'fixture provider unavailable'},status_code=503)
        return JSONResponse({'data':[{'id':f'model-{i:03d}','name':f'Fixture model {i:03d} <&> 🔧'} for i in range(160)]})
    async def facts(request):return JSONResponse({'settings_unchanged':config.SETTINGS_PATH.read_bytes()==initial_settings,'account_calls':account_calls,'audit':audit,'providers':provider_reads,'held':bool(hold['value'] and hold['value']['ready']),'served':bool(hold['value'] and hold['value'].get('served'))})
    async def control(request):
        body=await request.json()
        if body['action']=='hold':hold['value']={'ready':False,'served':False,'event':asyncio.Event()}
        elif body['action']=='release':hold['value']['event'].set()
        elif body['action']=='malformed':hold['malformed']=True
        elif body['action']=='status':status_mode['value']=body['mode']
        elif body['action']=='shape':hold['fault']=body.get('mode','')
        return JSONResponse({'ok':True})
    async def availability_status(request):
        if status_mode['value']=='http':return JSONResponse({'error':'Fixture status unavailable'},status_code=503)
        if status_mode['value']=='malformed':return JSONResponse({'harnesses':[None]})
        return JSONResponse({'reads':{'catalog':'ok','accounts':'ok','quota':'ok'},
            'harnesses':[{'id':'codex','enabled':True,'access_profiles_supported':['readonly','full'],'models':[{'id':'shared','credential_profile_id':'fixture-a'}]}],
            'profiles':{'profiles':[{'profile':{'harness_id':'codex','profile_id':'fixture-a','enabled':True},'status':{'verification':'passed'}}]},
            'quota':[],'quota_absences':[]})
    extra=[Route('/api/claudexor/status',availability_status)] if '--availability' in sys.argv else []
    app=Starlette(routes=[*extra,Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),Route('/provider/v1/models',provider),Route('/broken/v1/models',provider),*collect_routes(data_dir=data)])
    app.state.drive_root=data;app.state.repo_dir=repo
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or not scope['path'].startswith('/api/'):return await app(scope,receive,send)
            messages=[]
            async def output(message):messages.append(message)
            await app(scope,receive,output)
            audit.append({'method':scope['method'],'path':scope['path'],'query':scope.get('query_string',b'').decode(),'status':messages[0]['status']})
            if scope['path']!='/api/model-catalog':
                for message in messages:await send(message)
                return
            pending=hold['value']
            if pending and not pending['ready']:
                pending['ready']=True;await pending['event'].wait();pending['served']=True
            if hold['fault']:
                body=json.loads(b''.join(m.get('body',b'') for m in messages));mode=hold['fault'];hold['fault']=''
                if mode=='http':return await JSONResponse({'error':'Fixture catalog unavailable'},status_code=503)(scope,receive,send)
                if mode=='label':body['items'][-1]['label']=[]
                elif mode=='modalities':body['items'][-1]['input_modalities']={}
                elif mode=='default':body['items'][-1]['is_default']='true'
                elif mode=='source':body['model_sources'][0]['label']=[]
                elif mode=='foreign-source':body['items'][0]['source_id']='foreign-source'
                elif mode=='foreign-profile':body['items'][0]['credential_profile_id']='foreign-profile'
                elif mode=='unscoped-profile':
                    for item in body['items']:item.pop('credential_profile_id',None)
                    body['account_catalogs']=[]
                elif mode=='account':body['account_catalogs'][0]['accounts'][0]['label']=[]
                return await JSONResponse(body)(scope,receive,send)
            if hold['malformed']:
                hold['malformed']=False
                return await JSONResponse({'items':None,'errors':[],'model_sources':[]})(scope,receive,send)
            for message in messages:await send(message)
    (run/'port').write_text(str(port))
    uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])

if __name__=='__main__':main()
