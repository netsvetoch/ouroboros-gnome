"""Real maintenance handlers/service/negotiated HTTP transport, simulated CLI jobs.
Runtime preparation returns a fixture Node path; no installer or npm runs."""
def main():
    import asyncio, contextlib, copy, datetime, json, os, pathlib, socket, sys
    from types import SimpleNamespace
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    run=pathlib.Path(sys.argv[1]);data=run/'data';repo=run/'repo';data.mkdir();repo.mkdir()
    for key in list(os.environ):
        if key.startswith('OUROBOROS_'):os.environ.pop(key)
    os.environ.update(OUROBOROS_APP_ROOT=str(run),OUROBOROS_DATA_DIR=str(data),OUROBOROS_REPO_DIR=str(repo),OUROBOROS_SETTINGS_PATH=str(data/'settings.json'))
    from ouroboros import config,claudexor_daemon,claudexor_runtime
    from ouroboros.settings_setup_contract import SECRET_SETTING_KEYS
    for key in SECRET_SETTING_KEYS:os.environ.pop(key,None)
    config.initialize_runtime_mode_baseline('light');config.SETTINGS_PATH.write_text('{}');initial=config.SETTINGS_PATH.read_bytes()
    from ouroboros.gateways import claudexor
    from ouroboros import harness_maintenance as service
    from ouroboros.gateway.harness_maintenance import harness_maintenance_routes
    sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    endpoint=claudexor.DaemonEndpoint('127.0.0.1',port,'fixture-daemon-bearer')
    now=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat()
    operations={'fixture-existing':{'id':'fixture-existing','state':'running','harness':'claude','target':{'kind':'latest'},'phase':'installing','mutation':'unknown','termination':'not_applicable','progress':['Fixture progress <&> 🔧'],'startedAt':now()}}
    keys={};wire=[];audit=[];prep=[];versions={'claude':'1.0.0'};installed={'claude':'1.0.0'};fault={'inventory':'','create':'','npm_missing':False,'prep_fail':False,'ensure_fail':False,'cancel_unknown':False,'read':''}
    release=asyncio.Event();release.set()
    @contextlib.contextmanager
    def read_owned():
        with claudexor.ClaudexorGateway(endpoint) as gateway:gateway.handshake();yield gateway
    def ensure():
        if fault['ensure_fail']:raise claudexor.ClaudexorUnavailable('fixture_preparation_unavailable','Fixture ensure failed',status_code=503)
        gateway=claudexor.ClaudexorGateway(endpoint);gateway.handshake();return gateway
    service.read_owned_gateway=read_owned;service.ensure_owned_gateway=ensure
    def prepare():
        prep.append('prepare_node_toolchain')
        if fault['prep_fail']:raise claudexor_runtime.ClaudexorRuntimeError('fixture_node_unavailable','Fixture Node preparation failed')
        return '/fixture/node/bin/node'
    claudexor_runtime.get_runtime_manager=lambda:SimpleNamespace(prepare_node_toolchain=prepare)
    def active(h):return next((o for o in reversed(list(operations.values())) if o['harness']==h and (o['state'] in ('queued','running') or o.get('termination')=='unconfirmed')),None)
    def inventory(h):
        last=next((o for o in reversed(list(operations.values())) if o['harness']==h),None)
        return {'harness':h,'observedAt':now(),'maintainable':h!='codex','canCheckLatest':True,'mechanism':'managed_npm',
          'targets':['latest','version','previous','baseline'] if h!='codex' else [],
          'selection':{'kind':'override' if h=='codex' else 'managed','version':versions.get(h,'1.0.0'),'binary':'/fixture/tool','overrideEnv':'FIXTURE_CODEX_BIN' if h=='codex' else None},
          'installed':{'version':installed.get(h,'1.0.0')},'available':{'version':'2.0.0','observedAt':now()},'previous':{'version':'0.9.0'},
          'releaseTested':{'version':'1.1.0','verification':'fixture release tested'},'remedy':'Override selected; manage the selected executable' if h=='codex' else '',
          'availableProblem':{'code':'embedded_npm_missing','message':'Fixture embedded npm missing'} if fault['npm_missing'] else None,'operation':last}
    async def daemon(request):
        path=request.url.path;body=await request.json() if request.method=='POST' and await request.body() else {}
        wire.append({'method':request.method,'path':path,'query':request.url.query,'body':body,'key':request.headers.get('idempotency-key'),'authorized':request.headers.get('authorization')=='Bearer fixture-daemon-bearer'})
        if not wire[-1]['authorized']:return JSONResponse({'code':'unauthorized'},status_code=401)
        if path=='/v2/handshake':return JSONResponse({'compatible':True,'protocolMajor':config.CLAUDEXOR_PROTOCOL_MAJOR,'engine':{'version':config.CLAUDEXOR_MIN_VERSION,'sha':'a'*40,'entry':'/fixture/engine.cjs'}})
        if path=='/v2/operations':return JSONResponse({'operations':[{'id':id} for id in ('get:maintenance.harnesses','post:maintenance.operations','get:maintenance.operations.id','post:maintenance.operations.id.cancel')]})
        if path.endswith('/harnesses'):
            if fault['inventory']=='fail':return JSONResponse({'code':'fixture_inventory_unavailable','message':'Fixture inventory failed'},status_code=503)
            names=request.query_params.getlist('harness') or list(dict.fromkeys(['claude','codex',*(o['harness'] for o in operations.values())]))
            return JSONResponse({'observedAt':now(),'harnesses':[None] if fault['inventory']=='malformed' else [inventory(h) for h in names]})
        if path=='/v2/maintenance/operations':
            key=request.headers.get('idempotency-key');h=body['harness'];mode=fault['create'];fault['create']=''
            if mode=='refuse':return JSONResponse({'code':'maintenance_target_refused','message':'Fixture target refused'},status_code=409)
            if mode=='already-active':return JSONResponse({'code':'maintenance_already_active','message':'Fixture already active','context':{'operationId':'fixture-existing'}},status_code=409)
            if key not in keys:
                busy=active(h)
                if busy:return JSONResponse({'code':'maintenance_already_active','message':'Fixture already active','context':{'operationId':busy['id']}},status_code=409)
                id=f'fixture-op-{len(keys)+1}';keys[key]=id;operations[id]={'id':id,'state':'running','harness':h,'target':body['target'],'targetVersion':body['target'].get('version',{'latest':'2.0.0','previous':'0.9.0','baseline':'1.1.0'}.get(body['target']['kind'],'2.0.0')),'before':{'version':versions.get(h,'1.0.0')},'phase':'installing','mutation':'unknown','termination':'not_applicable','progress':['Fixture installing <&> 🔧'],'limitations':['Fixture only'],'startedAt':now()}
            answer=copy.deepcopy(operations[keys[key]])
            if mode=='lost':return JSONResponse({'code':'daemon_unreachable','message':'Fixture lost create receipt'},status_code=503)
            if mode=='bad-state':answer['state']='unrecognized'
            if mode=='foreign-target':answer['target']={'kind':'version','version':'foreign-version'}
            return JSONResponse(answer,status_code=202)
        id=request.path_params['operation_id'];entry=operations.get(id)
        if not entry:return JSONResponse({'code':'operation_not_found','message':'Fixture operation gone'},status_code=404)
        if path.endswith('/cancel'):
            entry.update(state='cancelled',termination='unconfirmed' if fault['cancel_unknown'] else 'confirmed',mutation='unknown',finishedAt=now())
            return JSONResponse(entry)
        if fault['read']=='fail':return JSONResponse({'code':'fixture_read_unavailable','message':'Fixture read failed'},status_code=503)
        if fault['read']=='foreign':return JSONResponse({**entry,'id':'foreign-operation'})
        return JSONResponse(entry)
    async def facts(request):return JSONResponse({'wire':wire,'audit':audit,'operations':operations,'keys':keys,'preparation':prep,'settings_unchanged':config.SETTINGS_PATH.read_bytes()==initial})
    async def control(request):
        body=await request.json();action=body['action']
        if action=='hold':release.clear()
        elif action=='release-all':release.set()
        elif action=='fault':fault.update(body['values'])
        elif action=='complete':
            entry=operations[body['id']];entry.update(state=body.get('state','succeeded'),termination='confirmed',phase='finished',mutation='applied',after={'version':entry.get('targetVersion','2.0.0'),'selected':body.get('selected',True)},finishedAt=now());installed[entry['harness']]=entry['after']['version']
            if entry['after']['selected']:versions[entry['harness']]=entry['after']['version']
        elif action=='external':
            operations['fixture-external']={'id':'fixture-external','harness':body.get('harness','claude'),'state':'running','target':{'kind':'latest'},'phase':'installing','mutation':'unknown','termination':'not_applicable'}
        return JSONResponse({'ok':True})
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),*harness_maintenance_routes(),
      Route('/v2/handshake',daemon,methods=['POST']),Route('/v2/operations',daemon),Route('/v2/maintenance/harnesses',daemon),Route('/v2/maintenance/operations',daemon,methods=['POST']),Route('/v2/maintenance/operations/{operation_id}',daemon),Route('/v2/maintenance/operations/{operation_id}/cancel',daemon,methods=['POST'])])
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or not scope['path'].startswith('/api/'):return await app(scope,receive,send)
            raw=bytearray();messages=[];record={'method':scope['method'],'path':scope['path'],'query':scope['query_string'].decode()};audit.append(record)
            async def input():message=await receive();raw.extend(message.get('body',b''));return message
            async def output(message):messages.append(message)
            await app(scope,input,output);record['status']=messages[0]['status']
            if raw:record['body']=json.loads(raw)
            record['reply']=json.loads(b''.join(m.get('body',b'') for m in messages))
            if scope['method']=='GET':await release.wait()
            for message in messages:await send(message)
    (run/'port').write_text(str(port));uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])
if __name__=='__main__':main()
