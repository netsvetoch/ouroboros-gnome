"""Real account status fan-out, facet memory and profile proxy over local HTTP.
Only daemon discovery/liveness are substituted; vendor credentials never touched."""
def main():
    import asyncio, copy, json, os, pathlib, socket, sys
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    run=pathlib.Path(sys.argv[1]);data=run/'data';repo=run/'repo';data.mkdir();repo.mkdir()
    for key in list(os.environ):
        if key.startswith('OUROBOROS_'):os.environ.pop(key)
    os.environ.update(OUROBOROS_APP_ROOT=str(run),OUROBOROS_DATA_DIR=str(data),OUROBOROS_REPO_DIR=str(repo),OUROBOROS_SETTINGS_PATH=str(data/'settings.json'))
    from ouroboros import config,claudexor_daemon
    from ouroboros.settings_setup_contract import SECRET_SETTING_KEYS
    for key in SECRET_SETTING_KEYS:os.environ.pop(key,None)
    config.initialize_runtime_mode_baseline('light');config.SETTINGS_PATH.write_text('{}');initial=config.SETTINGS_PATH.read_bytes()
    from ouroboros.gateways import claudexor
    from ouroboros.gateway.claudexor_accounts import api_claudexor_status,api_claudexor_credential_profile,api_claudexor_wake,api_claudexor_restart
    sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    endpoint=claudexor.DaemonEndpoint('127.0.0.1',port,'fixture-daemon-bearer')
    claudexor_daemon.owned_config_dir=lambda:run/'engine'
    claudexor.discover_daemon_at=lambda *args,**kwargs:endpoint
    class Daemon:
        def status_dict(self):return {'state':'stopped' if executions_mode and life['offline'] else 'running','version':'fixture-daemon'}
    claudexor_daemon.get_owned_daemon=lambda:Daemon()
    executions_mode='--executions' in sys.argv
    session_mode='--session-picker' in sys.argv
    lifecycle_mode='--lifecycle' in sys.argv
    life={'stops':[],'starts':[],'latches':[],'stop':'stopped','start_refused':False,'provisioned':True,'offline':False,'runs_fail':False}
    live=[]
    if lifecycle_mode:
        import contextlib
        from types import SimpleNamespace
        from ouroboros import store_import,claudexor_restart
        from ouroboros.delegate_custody import emit,STARTED
        (data/'logs').mkdir(exist_ok=True)
        store_import.ensure_current_store(data,with_children=False)
        assert emit(data,STARTED,{'run_id':'fixture-own-run','task_id':'fixture-task','category':'delegate','delegated':True})
        live.extend([{'runId':'fixture-own-run','state':'running','primaryHarness':'claude','startedAt':'2026-11-01T00:00:00Z','project':{'projectName':'Owned <&> 🔧'}},
          {'runId':'fixture-child-run','state':'queued','delegatedFromRunId':'fixture-own-run','primaryHarness':'codex','startedAt':'2026-11-01T00:00:01Z'},
          *({'runId':f'fixture-other-{i:02}','state':'running','primaryHarness':'claude','startedAt':f'2026-11-01T00:01:{i:02}Z'} for i in range(53))])
        class LifecycleDaemon:
            def status_dict(self):return {'state':'running' if life['provisioned'] else 'stopped','version':'fixture-daemon'}
            def clear_start_failure_latch(self,*,cleared_by):life['latches'].append(cleared_by)
            def stop_outcome(self):
                life['stops'].append(life['stop'])
                if life['stop']!='unconfirmed':life['provisioned']=False;live.clear()
                return life['stop']
        def ensure():
            life['starts'].append('ensure')
            if life['start_refused']:raise claudexor.ClaudexorUnavailable('fixture_start_refused','Fixture start refused',status_code=503)
            life['provisioned']=True
            gateway=claudexor.ClaudexorGateway(endpoint);gateway.handshake();return gateway
        @contextlib.contextmanager
        def read_owned(**kwargs):
            if life['offline']:raise claudexor.ClaudexorUnavailable('daemon_unreachable','Fixture engine offline',status_code=503)
            with claudexor.ClaudexorGateway(endpoint) as gateway:
                gateway.handshake();yield gateway
        claudexor_daemon.get_owned_daemon=lambda:LifecycleDaemon()
        claudexor_daemon.ensure_owned_gateway=ensure
        claudexor_daemon.read_owned_gateway=read_owned
        claudexor_daemon.owned_daemon_provisioned=lambda:life['provisioned']
        claudexor_restart._next_start_pin=lambda:SimpleNamespace(version='3.0.0',build_sha='b'*40)
    history_path=data/'state/subagent_last_delegation.json'
    baseline_history=None
    if executions_mode:
        from ouroboros import store_import
        from ouroboros.subagent_history import record_task_execution,record_last_delegation,execution_identity
        (data/'logs').mkdir(exist_ok=True)
        store_import.ensure_current_store(data,with_children=False)
        target='claudexor::opaque-source=requested-model'
        actor={'route':{'kind':'api_model','target_id':target,'credential_profile_id':'profile-a'},'selected_subagent_id':'worker','effort':'high','processing_preference':'standard'}
        task={'id':'history-task','type':'task','configured_subagent':actor}
        calls=[{'model':target,'requested_profile':'profile-a','failure_code':'quota_exhausted','llm_call_id':'failed-call','ts':'2026-11-12T00:00:00Z',
                'observed_route':{'source':'opaque-source','model':'attempt-model <&> 🔧','credentialProfileId':'profile-a','processing':{'requested':'fast','submitted':'standard'}}},
               {'model':'openai::fallback','requested_profile':'','usable_solve_response':True,'llm_call_id':'fallback-call','ts':'2026-11-12T00:00:01Z',
                'observed_route':{'source':'fallback-source','model':'served-fallback','credentialProfileId':'fallback-profile'}}]
        record_task_execution(task,{'llm_call_refs':calls},drive_root=data)
        unknown={'route':{'kind':'api_model','target_id':'openai::unreported'},'selected_subagent_id':'unreported','effort':'','processing_preference':'standard'}
        record_last_delegation(route='api_model',requested_model='openai::unreported',applied_model='',requested_profile='',applied_profile='',run_id='unknown-run',
            selected_subagent_id='unreported',identity=execution_identity(unknown),occurred_at='2026-11-11T00:00:00Z',outcome='succeeded',drive_root=data)
        record_last_delegation(route='codex',requested_model='old-model',applied_model='old-served',requested_profile='old-pin',applied_profile='old-profile',run_id='removed-run',
            selected_subagent_id='removed',identity={'kind':'agent_session','target_id':'codex=old-model','credential_profile_id':'old-pin','access':'readonly','effort':'','processing_preference':''},
            occurred_at='2026-11-10T00:00:00Z',outcome='completed',drive_root=data)
        baseline_history=history_path.read_bytes()
    primary='work-🔧 & profile'
    profiles=[{'profile':{'harness_id':'claude','profile_id':primary,'display_name':'Work <&> 🔧','enabled':True},
      'status':{'verification':'passed','verification_source':'vendor','availability':'available','last_verified_at':'fixture-vendor-verified'},'identity':{'email':'work@example.invalid','plan':'Pro'}},
      {'profile':{'harness_id':'codex','profile_id':'local-store','display_name':'Local account','enabled':False},
       'status':{'verification':'passed','verification_source':'local_store','availability':'unknown'}}]
    if session_mode:
        profiles.extend([{'profile':{'harness_id':'claude','profile_id':id,'display_name':id,'enabled':True}} for id in ('alternate','unread')])
    baseline=copy.deepcopy(profiles);wire=[];audit=[];fault={'roster':'','models':False,'receipt':'','refuse':False,'api_status':'','keep_remove':False}
    release=asyncio.Event();release.set()
    async def daemon(request):
        path=request.url.path;body=await request.json() if request.method=='PATCH' else {}
        wire.append({'method':request.method,'path':path,'raw_path':request.scope['raw_path'].decode(),'query':request.url.query,'body':body,'authorized':request.headers.get('authorization')=='Bearer fixture-daemon-bearer'})
        if not wire[-1]['authorized']:return JSONResponse({'code':'unauthorized'},status_code=401)
        if path=='/v2/handshake':return JSONResponse({'compatible':True,'protocolMajor':config.CLAUDEXOR_PROTOCOL_MAJOR,'engine':{'version':'99.0.0' if lifecycle_mode else config.CLAUDEXOR_MIN_VERSION,'sha':'a'*40,'entry':'/fixture/engine.cjs'}})
        if path=='/v2/operations':return JSONResponse({'operations':[{'method':'GET','path':'/v2/runs','parameters':[{'name':'state','location':'query','enum':['queued','running']}]}] if lifecycle_mode else [{'method':'GET','path':'/v2/harnesses/:id/models','parameters':[{'name':'view','location':'query','enum':['accounts']}]}] if session_mode else []})
        if path=='/v2/daemon/status':return JSONResponse({'admission':{'active':{'model':3},'queued':{'model':2}}})
        if path=='/v2/runs':
            if life['runs_fail']:return JSONResponse({'code':'fixture_runs_unavailable'},status_code=503)
            rows=[row for row in live if row['state']==request.query_params.get('state')]
            # Deliberately use two pages to exercise the real keyset reader.
            cursor=request.query_params.get('cursor');part=rows[30:] if cursor else rows[:30]
            return JSONResponse({'runs':part,'hasMore':len(rows)>30 and not cursor,'nextCursor':'fixture-page-2' if len(rows)>30 and not cursor else None})
        if path=='/v2/agent-capabilities' and session_mode and fault['api_status']=='facet-catalog-fail':return JSONResponse({'code':'fixture_catalog_failed'},status_code=503)
        if path=='/v2/agent-capabilities':return JSONResponse({'harnesses':[{'id':id,'displayName':name,'status':'available','enabled':True} for id,name in [('claude','Claude fixture'),('codex','Codex fixture'),('raw-api','API only fixture')]]})
        if path=='/v2/harnesses':return JSONResponse({'harnesses':[{'id':id,'manifest':{'capability_profile':{'auth':{'supported_sources':['native_session' if id!='raw-api' else 'api_key']}}}} for id in ('claude','codex','raw-api')]})
        if path=='/v2/quota':return JSONResponse({'snapshots':[],'absences':[]})
        if path.endswith('/models'):
            if fault['models']:return JSONResponse({'code':'fixture_models_unavailable','message':'Fixture catalog refused'},status_code=503)
            if session_mode:
                ids=[primary,'alternate','unread'] if request.path_params['harness']=='claude' else ['local-store']
                accounts=[]
                for id in ids:
                    catalog=None if id=='unread' else {'source':'fixture-session','credentialProfileId':id,'models':[{'id':'shared','label':'Shared '+id+' <&>'},{'id':'only-'+('a' if id==primary else 'b'),'label':'Only '+id}]}
                    accounts.append({'credentialProfileId':id,'catalog':catalog,'problem':{'message':'Fixture unread <&>'} if id=='unread' else None})
                return JSONResponse({'accounts':accounts,'partial':any(a['catalog'] is None for a in accounts)})
            return JSONResponse({'models':[{'id':'fixture-model','displayName':'Fixture model <&>'}]})
        if path=='/v2/credential-profiles':
            if fault['roster']=='fail':return JSONResponse({'code':'fixture_roster_unavailable','message':'Fixture accounts refused'},status_code=503)
            if fault['roster']=='malformed':return JSONResponse({'profiles':[None],'accountPools':[]})
            return JSONResponse({'profiles':profiles,'accountPools':[{'harness_id':'claude','next_up':{'kind':'profile','profileId':primary,'route':'fixture-profile-route'}},{'harness_id':'codex','next_up':{'kind':'api_key_route','route':'fixture-key-route'}}]})
        h,p=request.path_params['harness'],request.path_params['profile_id'];entry=next((e for e in profiles if e['profile']['harness_id']==h and e['profile']['profile_id']==p),None)
        if fault['refuse']:return JSONResponse({'code':'fixture_profile_refused','message':'Fixture profile refused'},status_code=409)
        if entry is None:return JSONResponse({'code':'profile_not_found'},status_code=404)
        if request.method=='PATCH':entry['profile']['enabled']=body['enabled'];return JSONResponse({'profile':entry['profile']})
        if fault['keep_remove']:
            fault['keep_remove']=False
            return JSONResponse({'profile':entry['profile'],'removed':False,'credentialCleanup':'none'})
        profiles.remove(entry)
        return JSONResponse({'profile':entry['profile'],'removed':True,'credentialCleanup':'config_dir_removed','cleanupWarning':'fixture cleanup needs inspection <&>',
          'vendorCredentialDisposition':{'owner':'vendor','state':'left_unchanged','scope':'os_user'}})
    async def facts(request):return JSONResponse({'wire':wire,'audit':audit,'profiles':profiles,'settings_unchanged':config.SETTINGS_PATH.read_bytes()==initial,'lifecycle':life,'live':live,'history':json.loads(history_path.read_text()) if history_path.exists() else {}})
    async def control(request):
        body=await request.json();action=body['action']
        if action=='hold':release.clear()
        elif action=='release-all':life['hold_post']=False;release.set()
        elif action=='roster':fault['roster']=body['mode']
        elif action=='receipt':fault['receipt']=body['mode']
        elif action=='refuse':fault['refuse']=body['value']
        elif action=='models':fault['models']=body['value']
        elif action=='status':fault['api_status']=body['mode']
        elif action=='hold-post':life['hold_post']=True;release.clear()
        elif action=='lifecycle':life.update(body['values'])
        elif action=='add-run':live.append({'runId':f'fixture-added-{len(live)}','state':'running','primaryHarness':'codex','startedAt':'2026-11-02T00:00:00Z'})
        elif action=='keep-remove':fault['keep_remove']=True
        elif action=='restore':profiles[:]=copy.deepcopy(baseline)
        elif action=='empty':profiles.clear()
        elif action=='history':
            mode=body['mode'];life['offline']=mode=='offline'
            if mode=='empty':history_path.write_text('{}')
            elif mode=='legacy':history_path.write_text(json.dumps({'route':'api_model','requested_model':'legacy/model','applied_model':'','run_id':'legacy-run','outcome':'unknown'}))
            elif mode=='restore':history_path.write_bytes(baseline_history)
        return JSONResponse({'ok':True})
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),
      Route('/api/claudexor/status',api_claudexor_status),Route('/api/claudexor/wake',api_claudexor_wake,methods=['POST']),Route('/api/claudexor/restart',api_claudexor_restart,methods=['GET','POST']),Route('/api/claudexor/credential-profiles/{harness}/{profile_id}',api_claudexor_credential_profile,methods=['PATCH','DELETE']),
      Route('/v2/handshake',daemon,methods=['POST']),Route('/v2/runs',daemon),Route('/v2/daemon/status',daemon),Route('/v2/operations',daemon),Route('/v2/agent-capabilities',daemon),Route('/v2/harnesses',daemon),Route('/v2/quota',daemon),
      Route('/v2/harnesses/{harness}/models',daemon),Route('/v2/credential-profiles',daemon),Route('/v2/credential-profiles/{harness}/{profile_id}',daemon,methods=['PATCH','DELETE'])])
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or not scope['path'].startswith('/api/'):return await app(scope,receive,send)
            raw=bytearray();messages=[];record={'path':scope['path'],'method':scope['method'],'query':scope['query_string'].decode()};audit.append(record)
            async def input():
                message=await receive();raw.extend(message.get('body',b''));return message
            async def output(message):messages.append(message)
            await app(scope,input,output)
            if raw:record['body']=json.loads(raw)
            record['status']=messages[0]['status'];record['reply']=json.loads(b''.join(m.get('body',b'') for m in messages))
            if scope['method']!='GET' and life.get('hold_post'):await release.wait()
            if scope['method']=='GET':
                await release.wait()
                if fault['api_status']=='malformed' and scope['path'].endswith('/restart'):return await JSONResponse({'token':'fixture-incomplete-preview','engine':{}})(scope,receive,send)
                if fault['api_status']=='malformed':return await JSONResponse({'reads':{'accounts':'ok'},'profiles':{'profiles':[None]}})(scope,receive,send)
                if executions_mode and fault['api_status'].startswith('history-'):
                    body=copy.deepcopy(record['reply']);history=body['subagent_last_delegation'];mode=fault['api_status']
                    if mode=='history-missing':body.pop('subagent_last_delegation')
                    elif mode=='history-map':history['latest_by_subagent']=[]
                    elif mode=='history-foreign':history['latest_by_subagent']['worker']['selected_subagent_id']='foreign'
                    elif mode=='history-identity':history['latest_by_subagent']['worker']['identity']['effort']=[]
                    elif mode=='history-observed':history['latest_by_subagent']['worker']['observed_route']['model']=[]
                    elif mode=='history-fallback':history['latest_by_subagent']['worker']['fallback']['observed_route']['credentialProfileId']=[]
                    return await JSONResponse(body)(scope,receive,send)
                if session_mode and fault['api_status'].startswith('nested-'):
                    body=copy.deepcopy(record['reply']);mode=fault['api_status']
                    if mode=='nested-model':body['harnesses'][0]['models'][0]['label']=[]
                    elif mode=='nested-envelope':body['harnesses'][0]['model_catalog']['accounts']=[None]
                    elif mode=='nested-profile':body['profiles']['profiles'][0]['profile']['display_name']=[]
                    elif mode=='nested-duplicate':body['harnesses'].append(copy.deepcopy(body['harnesses'][0]))
                    return await JSONResponse(body)(scope,receive,send)
                if fault['api_status']=='fail':return await JSONResponse({'error':'fixture status failure'},status_code=503)(scope,receive,send)
            else:
                mode=fault['receipt'];fault['receipt']=''
                if mode=='lost':return await JSONResponse({'error':'fixture lost profile receipt'},status_code=503)(scope,receive,send)
                if mode=='malformed':return await JSONResponse({})(scope,receive,send)
                if mode=='bad-restart-status':return await JSONResponse({**record['reply'],'status':None})(scope,receive,send)
                if mode=='foreign':
                    body={**record['reply']};body['profile']={**body.get('profile',{}),'profile_id':'foreign-profile'}
                    return await JSONResponse(body)(scope,receive,send)
            for message in messages:await send(message)
    (run/'port').write_text(str(port));uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])
if __name__=='__main__':main()
