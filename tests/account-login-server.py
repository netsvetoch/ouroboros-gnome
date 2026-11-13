def main():
    """Real login gateway/proxy; only daemon provisioning and CLI execution are simulated."""
    import asyncio
    import contextlib
    import copy
    import hashlib
    import json
    import os
    import pathlib
    import socket
    import sys
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
    from ouroboros.gateway.claudexor_accounts import api_claudexor_login,api_claudexor_login_job,api_claudexor_login_job_reconcile
    sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    endpoint=claudexor.DaemonEndpoint('127.0.0.1',port,'fixture-daemon-bearer')
    @contextlib.contextmanager
    def owned():
        with claudexor.ClaudexorGateway(endpoint) as gateway:
            gateway.handshake();yield gateway
    claudexor_daemon.ensure_owned_gateway=owned
    claudexor_daemon.owned_config_dir=lambda:run/'engine'
    claudexor.discover_daemon_at=lambda *args,**kwargs:endpoint
    claudexor_daemon.resolve_attach_login_argv=lambda engine:['/fixture/managed/claudexor','setup','attach']
    jobs={};profiles=set();wire=[];audit=[];fault={'input':'normal','cancel_unknown':False,'reconcile_empty':False,'get':'','create_lost':False,'stale_after_input':False,'wire_hold':'','wire_method':'','envelope':''}
    release=asyncio.Event();release.set()
    def bare(entry):return {k:v for k,v in entry.items() if k not in ('sequence','flow','transport','stale')}
    def snapshot(entry):
        if entry.get('stale'):
            entry['stale']=False;old={**bare(entry),'state':'waiting_for_input','phase':'old snapshot'}
            return {'job':old,'sequence':entry['sequence']-2,'cursor':'old','deviceCode':{'flow':'oauth_url_input','verificationUrl':'https://provider.example.invalid/login'}}
        answer={'job':bare(entry),'sequence':entry['sequence'],'cursor':'fixture-cursor'}
        if entry['state']=='waiting_for_input' and entry.get('transport')!='client_pty':
            answer['deviceCode']={'flow':entry['flow'],'verificationUrl':'https://provider.example.invalid/login',**({'userCode':'ABCD-EFGH'} if entry['flow']=='device_auth' else {})}
        return answer
    async def daemon(request):
        path=request.url.path;body=await request.json() if request.method=='POST' and await request.body() else {}
        record={'method':request.method,'path':path,'authorized':request.headers.get('authorization')=='Bearer fixture-daemon-bearer','protocol':request.headers.get('x-claudexor-protocol-major')}
        if path.endswith('/input'):
            value=body.get('value','');record.update(value_sha256=hashlib.sha256(value.encode()).hexdigest(),chars=len(value))
        else:record['body']=body
        wire.append(record)
        if not record['authorized']:return JSONResponse({'code':'unauthorized'},status_code=401)
        if path=='/v2/handshake':return JSONResponse({'compatible':True,'protocolMajor':config.CLAUDEXOR_PROTOCOL_MAJOR,'engine':{'version':config.CLAUDEXOR_MIN_VERSION,'sha':'a'*40,'entry':'/fixture/managed/engine.cjs'}})
        if path=='/v2/agent-capabilities':return JSONResponse({'harnesses':[{'id':id,'setupLogin':{'mode':'in_app'}} for id in ('claude','codex')]})
        if path=='/v2/credential-profiles':
            key=(body['harnessId'],body['profileId'])
            if key in profiles:return JSONResponse({'code':'credential_profile_exists','message':'Already exists'},status_code=409)
            profiles.add(key);return JSONResponse({'harness_id':key[0],'profile_id':key[1]},status_code=201)
        if path=='/v2/setup/jobs':
            id=f'fixture-job-{len(jobs)+1}';jobs[id]={'id':id,'harness':body['harness'],'profileId':body.get('profileId',''),
              'state':'waiting_for_input','phase':'authorization','message':'Fixture authorization <&> 🔧','sequence':10,
              'flow':'device_auth' if body['harness']=='codex' else 'oauth_url_input','transport':body.get('transport','')}
            return JSONResponse(bare(jobs[id]))
        id=request.path_params.get('job_id');entry=jobs.get(id)
        if not entry:return JSONResponse({'code':'setup_job_not_found','message':'Job unavailable'},status_code=404)
        if path.endswith('/snapshot'):
            if fault['get']=='gone':return JSONResponse({'code':'setup_job_not_found','message':'Job gone'},status_code=410)
            if fault['get']=='fail':return JSONResponse({'code':'fixture_failure','message':'Read unavailable'},status_code=503)
            if fault['get']=='malformed':return JSONResponse({'job':{'id':'another-job','state':'running'},'sequence':entry['sequence']})
            return JSONResponse(snapshot(entry))
        if path.endswith('/input'):
            if fault['input']=='unsupported':return JSONResponse({'code':'route_missing','message':'No input route'},status_code=404)
            if fault['input']=='opaque':return JSONResponse({'code':body['value'],'message':body['value']},status_code=409)
            if fault['input']=='malformed':return JSONResponse({})
            entry.update(state='running',phase='input accepted',sequence=entry['sequence']+1)
            if fault['stale_after_input']:entry['stale']=True;fault['stale_after_input']=False
            return JSONResponse(bare(entry))
        if path.endswith('/cancel'):
            entry.update(state='interrupted_unknown' if fault['cancel_unknown'] else 'cancelled',sequence=entry['sequence']+1)
            if fault['cancel_unknown']:entry.update(outcome={'reason':'termination_unconfirmed'},terminationReconciliation={'status':'unknown'})
            return JSONResponse(bare(entry))
        if path.endswith('/reconcile'):
            if not fault['reconcile_empty']:return JSONResponse({'code':'setup_termination_unconfirmed','message':'Process may remain','requiredActions':['retry_setup_reconciliation']},status_code=409)
            entry.update(state='cancelled',terminationReconciliation={'status':'empty'},sequence=entry['sequence']+1);return JSONResponse(bare(entry))
        return JSONResponse({'code':'unexpected_route'},status_code=404)
    async def facts(request):return JSONResponse({'jobs':{id:bare(job) for id,job in jobs.items()},'wire':wire,'audit':audit,'profiles':list(profiles),'settings_unchanged':config.SETTINGS_PATH.read_bytes()==initial})
    async def control(request):
        body=await request.json();action=body['action']
        if action=='hold':fault['wire_hold']='';release.clear()
        elif action=='wire-hold':fault['wire_hold']=body['path'];fault['wire_method']=body.get('method','POST');release.clear()
        elif action=='wire-pass':fault['wire_hold']='/fixture/no-hold'
        elif action=='envelope':fault['envelope']=body.get('mode','')
        elif action=='wait-input':jobs[body['id']].update(state='waiting_for_input',phase='authorization',flow='oauth_url_input',sequence=jobs[body['id']]['sequence']+1)
        elif action=='release-all':fault['wire_hold']='';release.set()
        elif action=='get-fail':fault['get']='fail'
        elif action=='get-gone':fault['get']='gone'
        elif action=='get-malformed':fault['get']='malformed'
        elif action=='get-clear':fault['get']=''
        elif action=='input-opaque':fault['input']='opaque'
        elif action=='input-malformed':fault['input']='malformed'
        elif action=='input-unsupported':fault['input']='unsupported'
        elif action=='input-normal':fault['input']='normal'
        elif action=='input-old-snapshot':fault['stale_after_input']=True
        elif action=='cancel-unknown':fault['cancel_unknown']=True
        elif action=='reconcile-empty':fault['reconcile_empty']=True
        elif action=='create-lost':fault['create_lost']=True
        elif action=='create-envelope':fault['create_envelope']=body.get('mode','')
        elif action=='succeed':
            entry=jobs[body['id']];entry.update(state='succeeded',phase='done',sequence=entry['sequence']+1)
        return JSONResponse({'ok':True})
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),
      Route('/v2/handshake',daemon,methods=['POST']),Route('/v2/agent-capabilities',daemon),Route('/v2/credential-profiles',daemon,methods=['POST']),
      Route('/v2/setup/jobs',daemon,methods=['POST']),Route('/v2/setup/jobs/{job_id}/{op}',daemon,methods=['GET','POST']),
      Route('/api/claudexor/login',api_claudexor_login,methods=['POST']),Route('/api/claudexor/login/{job_id}',api_claudexor_login_job,methods=['GET','DELETE']),
      Route('/api/claudexor/login/{job_id}/input',api_claudexor_login_job,methods=['POST']),Route('/api/claudexor/login/{job_id}/reconcile',api_claudexor_login_job_reconcile,methods=['POST'])])
    app.state.drive_root=data;app.state.repo_dir=repo
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or not scope['path'].startswith('/api/'):return await app(scope,receive,send)
            raw=bytearray();messages=[];record={'method':scope['method'],'path':scope['path']};audit.append(record)
            async def input():
                message=await receive();raw.extend(message.get('body',b''));return message
            async def output(message):messages.append(message)
            held=scope['path']==fault['wire_hold'] and scope['method']==fault['wire_method']
            envelope=fault['envelope']
            await app(scope,input,output);record['status']=messages[0]['status']
            if raw:
                body=json.loads(raw)
                record['body']={'value_sha256':hashlib.sha256(body['value'].encode()).hexdigest(),'chars':len(body['value'])} if 'value'in body else body
            if not scope['path'].endswith('/input'):
                try:record['reply']=json.loads(b''.join(m.get('body',b'') for m in messages))
                except Exception:pass
            if held or scope['method']=='GET' and not fault['wire_hold']:await release.wait()
            if envelope and scope['method']=='GET' and record['status']==200:
                body=json.loads(b''.join(m.get('body',b'') for m in messages))
                if envelope=='id':body['job']['id']=''
                elif envelope=='job_id':body['job_id']='foreign'
                elif envelope=='phase':body['job']['phase']=[]
                elif envelope=='device':body['deviceCode']={'flow':'oauth_url_input','userCode':[]}
                elif envelope=='outcome':body['job']['outcome']={'reason':[]}
                elif envelope=='reconciliation':body['job']['terminationReconciliation']={'status':[]}
                elif envelope=='attach':body['attach_command']=[]
                return await JSONResponse(body)(scope,receive,send)
            if scope['path']=='/api/claudexor/login' and fault['create_lost']:
                fault['create_lost']=False
                return await JSONResponse({'error':'fixture lost create receipt'},status_code=503)(scope,receive,send)
            if scope['path']=='/api/claudexor/login' and fault.get('create_envelope') and record['status']==200:
                mode=fault.pop('create_envelope');body=json.loads(b''.join(m.get('body',b'') for m in messages))
                if mode=='missing':body.pop('job',None)
                elif mode=='state':body['job'].pop('state',None)
                elif mode=='phase':body['job']['phase']=[]
                elif mode=='foreign':body['job']['id']='foreign-job'
                elif mode=='device':body['deviceCode']={'flow':'oauth_url_input','userCode':[]}
                elif mode=='attach':body['attach_command']=[]
                return await JSONResponse(body)(scope,receive,send)
            for message in messages:await send(message)
    (run/'port').write_text(str(port));uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])

if __name__=='__main__':main()
