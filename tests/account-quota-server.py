"""Native quota fixture. Real refresh/reset proxy + HTTPX daemon transport;
status observation is a controlled payload, no vendor/provider operations."""
def main():
    import asyncio, copy, json, os, pathlib, socket, sys
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    run=pathlib.Path(sys.argv[1]); data=run/'data'; repo=run/'repo'; data.mkdir(); repo.mkdir()
    for key in list(os.environ):
        if key.startswith('OUROBOROS_'):os.environ.pop(key)
    os.environ.update(OUROBOROS_APP_ROOT=str(run),OUROBOROS_DATA_DIR=str(data),OUROBOROS_REPO_DIR=str(repo),OUROBOROS_SETTINGS_PATH=str(data/'settings.json'))
    from ouroboros import config, claudexor_daemon
    from ouroboros.settings_setup_contract import SECRET_SETTING_KEYS
    for key in SECRET_SETTING_KEYS:os.environ.pop(key,None)
    config.initialize_runtime_mode_baseline('light'); config.SETTINGS_PATH.write_text('{}'); initial=config.SETTINGS_PATH.read_bytes()
    from ouroboros.gateways import claudexor
    from ouroboros.gateway.claudexor_quota import api_claudexor_quota_refresh,api_claudexor_account_reset
    sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    endpoint=claudexor.DaemonEndpoint('127.0.0.1',port,'fixture-daemon-bearer')
    claudexor_daemon.owned_config_dir=lambda:run/'engine'
    claudexor.discover_daemon_at=lambda *args,**kwargs:endpoint
    target={'harness':'claude','profile_id':'quota-profile'}
    wire=[];audit=[];receipts={};fault={'status':'','reset':'','unsupported':False,'refresh':''};epoch=1
    refresh_release=asyncio.Event();refresh_release.set();refresh_held=False;i18n_audit=[]
    release=asyncio.Event();release.set()
    def status_body():
        return {'view':'quota','reads':{'quota':'ok'},'resource_capabilities_read':'ok',
          'resource_capabilities':{'read':True,'refresh':True,'reset':True,'inspect_reset':True},
          'quota':[{'subject':{'harness':'claude','subject_id':'quota-profile'},'freshness':'fresh','observed_at':f'epoch-{epoch}',
            'constraints':[{'label':'Five hours <&>','used_ratio':.25,'freshness':'fresh','applies_to_models':['model-x'],'request_kinds':['chat']}]},
            {'subject':{'harness':'codex','subject_id':'other-profile'},'constraints':[{'label':'Other account window'}]}],
          'quota_absences':[{'subject':{'harness':'claude','subject_id':'quota-profile'},'reason':'unsupported_monthly'}],
          'resources':[{'target':target,'balances':{'freshness':'fresh','value':[{'label':'Credits','amount':'1234567890123456789','decimal_places':2,'currency':'USD'}]},
            'spending':{'freshness':'stale','last_error':{'code':'fixture_spend_gap'},'value':[{'label':'Monthly','used':'400','limit':'10000','decimal_places':2,'currency':'USD'}]},
            'resets':{'freshness':'fresh','value':[{'id':'offer-1','label':'Reset offer','eligible':True,'usable_now':True,'available_count':2,
              'grants':[{'id':'grant-1','label':'Fixture grant','usable_now':True,'available_count':1}]}]}}]}
    async def status(request):
        body=status_body();mode=fault['status']
        record={'path':request.url.path,'method':'GET','epoch':epoch};audit.append(record)
        if mode=='failed':return JSONResponse({'error':'fixture status unavailable'},status_code=503)
        if mode=='malformed':body['resources'][0]['resets']['value']=[None]
        if mode=='partial':body.update(reads={'quota':'failed'},quota=[],resources=[],quota_absences=[])
        if mode=='empty':body.update(quota=[],quota_absences=[],resources=[])
        await release.wait()
        return JSONResponse(body)
    async def daemon(request):
        nonlocal epoch,refresh_held
        path=request.url.path; body=await request.json() if request.method=='POST' and await request.body() else {}
        wire.append({'method':request.method,'path':path,'query':request.url.query,'body':body,
          'key':request.headers.get('idempotency-key'),'authorized':request.headers.get('authorization')=='Bearer fixture-daemon-bearer'})
        if not wire[-1]['authorized']:return JSONResponse({'code':'unauthorized'},status_code=401)
        if path=='/v2/handshake':return JSONResponse({'compatible':True,'protocolMajor':config.CLAUDEXOR_PROTOCOL_MAJOR,'engine':{'version':config.CLAUDEXOR_MIN_VERSION,'sha':'a'*40,'entry':'/fixture/engine.cjs'}})
        if path=='/v2/operations':
            ops=[] if fault['unsupported'] else [{'id':'post:account-resets'},{'id':'get:account-resets.id'},*({'method':method,'path':'/v2/quota','parameters':[{'name':'view','location':'query','enum':['resources']}]} for method in ('GET','POST'))]
            return JSONResponse({'operations':ops})
        if path=='/v2/quota':
            epoch+=1
            mode=fault['refresh']
            if mode=='lost':return JSONResponse({'code':'fixture_refresh_reply_lost'},status_code=503)
            if mode=='wire':return JSONResponse(fault['refresh_wire'])
            reply={'snapshots':[],'resources':[]}
            if mode in ('published','hold'):
                observed=status_body()
                reply={'snapshots':observed['quota'],'absences':observed['quota_absences'],'resources':observed['resources'],
                    'refreshed_at':f'fixture-refresh-{epoch}',
                    'refresh_skipped':{'reason':'fixture_cooldown <&>','account':target,'future':0}}
            if mode=='hold':
                refresh_held=True
                try:await refresh_release.wait()
                finally:refresh_held=False
            return JSONResponse(reply)
        if path=='/v2/account-resets':
            key=request.headers['idempotency-key']
            if key not in receipts:receipts[key]={'id':f'reset-{len(receipts)+1}','request':body,'state':'running','outcome':'pending'}
            result=copy.deepcopy(receipts[key]); mode=fault['reset'];fault['reset']=''
            if mode=='lost':return JSONResponse({'code':'fixture_lost_reply'},status_code=503)
            if mode=='malformed':result['state']='unrecognized'
            if mode=='foreign':result['request']={**body,'offer_id':'foreign-offer'}
            return JSONResponse(result)
        id=request.path_params['operation_id']; result=next((r for r in receipts.values() if r['id']==id),None)
        if result is None:return JSONResponse({'code':'not_found'},status_code=404)
        return JSONResponse(result)
    async def facts(request):return JSONResponse({'wire':wire,'audit':audit,'receipts':receipts,'epoch':epoch,'settings_unchanged':config.SETTINGS_PATH.read_bytes()==initial,'refresh_held':refresh_held,'i18n_audit':i18n_audit})
    async def control(request):
        body=await request.json();action=body['action']
        if action=='hold':release.clear()
        elif action=='release-all':release.set();refresh_release.set()
        elif action=='status':fault['status']=body['mode']
        elif action=='refresh':
            fault['refresh']=body['mode'];fault['refresh_wire']=body.get('reply')
            if body['mode']=='hold':refresh_release.clear()
        elif action=='reset':fault['reset']=body['mode']
        elif action=='unsupported':fault['unsupported']=True
        elif action=='complete':
            for receipt in receipts.values():receipt.update(state='completed',outcome='reset',readback={'state':'failed','detail':'fixture readback unavailable'})
        return JSONResponse({'ok':True})
    from ouroboros.gateway.router import collect_routes
    i18n_routes=[route for route in collect_routes(data_dir=data) if getattr(route,'path','').startswith('/api/ui/i18n')]
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),
      Route('/api/claudexor/status',status),Route('/api/claudexor/quota/refresh',api_claudexor_quota_refresh,methods=['POST']),
      Route('/api/claudexor/account-resets',api_claudexor_account_reset,methods=['POST']),Route('/api/claudexor/account-resets/{operation_id}',api_claudexor_account_reset),
      Route('/v2/handshake',daemon,methods=['POST']),Route('/v2/operations',daemon),Route('/v2/quota',daemon,methods=['POST']),
      Route('/v2/account-resets',daemon,methods=['POST']),Route('/v2/account-resets/{operation_id}',daemon),*i18n_routes])
    app.state.drive_root=data;app.state.repo_dir=repo
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']=='http' and scope['path'].startswith('/api/ui/i18n'):
                event={'path':scope['path'],'method':scope['method']};i18n_audit.append(event);original_receive=receive;raw=bytearray()
                async def receive():
                    msg=await original_receive();raw.extend(msg.get('body',b''))
                    if not msg.get('more_body') and raw:
                        try:event['body']=json.loads(raw)
                        except Exception:pass
                    return msg
            await app(scope,receive,send)
    (run/'port').write_text(str(port));uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])
if __name__=='__main__':main()
