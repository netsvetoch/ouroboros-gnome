def main():
    """Real MCP probe/status APIs and SDK transport in an isolated installation."""
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
    import base64
    import contextlib
    import hashlib
    import secrets
    import urllib.parse
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse, RedirectResponse
    from starlette.routing import Route,Mount
    from ouroboros.gateway.router import collect_routes
    from mcp.server.lowlevel import Server
    from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
    import mcp.types as types
    sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    status_mode='--status' in sys.argv[2:]
    oauth_mode='--sign-in' in sys.argv[2:]
    fault={'mode':'normal','status_fail':False,'malformed':False,'scope':False,'revoke_fail':False,'sign_in_fail':False,'import_reply':'','probe_reply':''}
    import_release=asyncio.Event();import_release.set()
    probe_release=asyncio.Event();probe_release.set()
    sign_in_release=asyncio.Event();sign_in_release.set()
    base=f'http://127.0.0.1:{port}'
    token='fixture-mcp-auth-token-937561'
    seed=json.loads(config.SETTINGS_PATH.read_text());seed.update(MCP_ENABLED=status_mode or oauth_mode,MCP_TOOL_TIMEOUT_SEC=12,
      MCP_SERVERS=[{'id':'native_fixture','name':'Native MCP','enabled':True,'transport':'streamable_http',
        'url':f'http://127.0.0.1:{port}/mcp/','auth_header':'X-Legacy','auth_token':token,
        'headers':{'Accept-Language':'en','X-Extra':'fixture-extra'}}])
    if oauth_mode:
        for key in ('headers','auth_header','auth_token'):seed['MCP_SERVERS'][0].pop(key,None)
    config.SETTINGS_PATH.write_text(json.dumps(seed));initial=config.SETTINGS_PATH.read_bytes()
    oauth={'register':0,'authorize':0,'exchange':0,'revoke':0,'pkce_ok':False,'owner_ok':False}
    clients={};codes={};access=set();refresh=set()
    async def resource_metadata(request):return JSONResponse({'resource':base+'/mcp/','authorization_servers':[base],
      'scopes_supported':['mcp'],'bearer_methods_supported':['header']})
    async def metadata(request):return JSONResponse({'issuer':base,'authorization_endpoint':base+'/authorize',
      'token_endpoint':base+'/token','registration_endpoint':base+'/register','revocation_endpoint':base+'/revoke',
      'response_types_supported':['code'],'grant_types_supported':['authorization_code','refresh_token'],
      'code_challenge_methods_supported':['S256'],'token_endpoint_auth_methods_supported':['none','client_secret_post'],
      'scopes_supported':['mcp'],'authorization_response_iss_parameter_supported':True})
    async def register(request):
        body=await request.json();oauth['register']+=1;client_id='fixture-client-'+str(oauth['register']);clients[client_id]=body
        return JSONResponse({**body,'client_id':client_id},status_code=201)
    async def authorize(request):
        params=dict(request.query_params);oauth['authorize']+=1;code=secrets.token_urlsafe(20);codes[code]=params
        return RedirectResponse(params['redirect_uri']+'?'+urllib.parse.urlencode({'code':code,'state':params['state'],'iss':base}),status_code=302)
    async def exchange(request):
        params=dict(await request.form());oauth['exchange']+=1;grant=codes.pop(params.get('code',''),None)
        if not grant:return JSONResponse({'error':'invalid_grant'},status_code=400)
        challenge=base64.urlsafe_b64encode(hashlib.sha256(params.get('code_verifier','').encode()).digest()).decode().rstrip('=')
        oauth['pkce_ok']=challenge==grant['code_challenge'] and grant['code_challenge_method']=='S256' and params.get('redirect_uri')==grant['redirect_uri']
        oauth['owner_ok']=params.get('client_id')=='owner-app' and params.get('client_secret')=='fixture-owner-secret-937561'
        if not oauth['pkce_ok'] or params.get('client_id')!=grant['client_id'] or (grant['client_id']=='owner-app' and not oauth['owner_ok']):
            return JSONResponse({'error':'invalid_client'},status_code=400)
        bearer=secrets.token_urlsafe(24);renew=secrets.token_urlsafe(24);access.add(bearer);refresh.add(renew)
        return JSONResponse({'access_token':bearer,'refresh_token':renew,'token_type':'Bearer','expires_in':3600,'scope':grant.get('scope','mcp')})
    async def revoke(request):
        params=dict(await request.form());oauth['revoke']+=1
        if fault['revoke_fail']:return JSONResponse({'error':'temporarily_unavailable'},status_code=503)
        access.discard(params.get('token'));refresh.discard(params.get('token'));return JSONResponse({})
    async def browser_return(request):
        import httpx
        url=(await request.json())['url'];assert url.startswith(base+'/authorize?')
        async with httpx.AsyncClient(follow_redirects=False) as http:answer=await http.get(url)
        assert answer.status_code==302
        return JSONResponse({'returned_url':answer.headers['location']})
    server=Server('native-fixture',instructions='Server instructions seven <&> 🔧 '+token)
    pages=[]
    @server.list_tools()
    async def list_tools(request:types.ListToolsRequest):
        cursor=request.params.cursor if request.params else None;pages.append(cursor)
        if fault['mode']=='fail':raise RuntimeError('Fixture listing temporarily unavailable')
        if fault['mode']=='empty':return types.ListToolsResult(tools=[])
        start=40 if cursor else 0;end=75 if cursor else 40
        tools=[types.Tool(name=f'fixture_{i:03d}',description=f'Tool seven {i} <&> 🔧',
          title=f'Metadata seven {i}',inputSchema={'type':'object','properties':{}},
          annotations=types.ToolAnnotations(readOnlyHint=True),
          outputSchema={'type':'object','properties':{'language':{'const':'en'}}}) for i in range(start,end)]
        if not cursor and not oauth_mode:
            tools[0].outputSchema={'const':token}
            tools.append(types.Tool(name='secret_literal',description='Must be withheld',inputSchema={'const':token}))
        return types.ListToolsResult(tools=tools,nextCursor=None if cursor else 'next-page')
    manager=StreamableHTTPSessionManager(app=server,json_response=True,stateless=True)
    wire=[];audit=[]
    class McpWire:
        async def __call__(self,scope,receive,send):
            if oauth_mode:
                credential=dict(scope.get('headers',[])).get(b'authorization',b'').decode()
                authorized=credential.startswith('Bearer ') and credential[7:] in access
                wire.append({'method':scope['method'],'authorized':authorized})
                if fault['scope']:
                    return await JSONResponse({'error':'insufficient_scope'},status_code=403,
                      headers={'WWW-Authenticate':'Bearer error="insufficient_scope", scope="mcp admin"'})(scope,receive,send)
                if not authorized:
                    return await JSONResponse({'error':'sign_in_required'},status_code=401,
                      headers={'WWW-Authenticate':f'Bearer resource_metadata="{base}/.well-known/oauth-protected-resource"'})(scope,receive,send)
                return await manager.handle_request(scope,receive,send)
            record={'method':scope['method'],'legacy_ok':dict(scope.get('headers',[])).get(b'x-legacy')==token.encode(),
              'language_ok':dict(scope.get('headers',[])).get(b'accept-language')==b'en'}
            wire.append(record)
            async def input():
                message=await receive()
                if message.get('body'):
                    try:record['rpc']=json.loads(message['body']).get('method')
                    except Exception:pass
                return message
            await manager.handle_request(scope,input,send)
    @contextlib.asynccontextmanager
    async def lifespan(app):
        async with manager.run():yield
    async def facts(request):
        oauth_docs=[json.loads(p.read_text()) for p in (data/'state/mcp/oauth').glob('server-*.json')]
        return JSONResponse({'wire':wire,'audit':audit,'pages':pages,'stdio_python':sys.executable,'stdio_script':str(pathlib.Path(__file__).resolve().parent/'mcp-stdio-fixture.py'),'stdio_receipt':str(run/'stdio-argv.json'),'stdio_argv':json.loads((run/'stdio-argv.json').read_text()) if (run/'stdio-argv.json').exists() else None,'settings_unchanged':config.SETTINGS_PATH.read_bytes()==initial,
          'oauth':{**oauth,'stored_token':any(bool(doc.get('tokens')) for doc in oauth_docs),'pending':any(bool(doc.get('pending')) for doc in oauth_docs)},
          'catalogs':{p.name:json.loads(p.read_text()) for p in (data/'state/mcp/catalogs').glob('*.json')}})
    async def allowlist(request):
        from ouroboros.mcp_client import MCPManager
        candidate=(await request.json())['server']
        owner=MCPManager()
        owner.reconfigure({'MCP_ENABLED':True,'MCP_TOOL_TIMEOUT_SEC':12,'MCP_SERVERS':[{**candidate,'enabled':True}]})
        result=await asyncio.to_thread(owner.refresh_server,candidate['id'])
        return JSONResponse({'listing':result,'registry':owner.list_tools_for_registry(),'status':owner.status_payload()})
    async def control(request):
        body=await request.json()
        if body['action']=='mode':fault['mode']=body['mode']
        elif body['action']=='status-fail':fault['status_fail']=True
        elif body['action']=='malformed':fault['malformed']=True
        elif body['action']=='hold-probe':probe_release.clear()
        elif body['action']=='release-probe':probe_release.set()
        elif body['action']=='probe-reply':fault['probe_reply']=body.get('mode','')
        elif body['action']=='import-reply':fault['import_reply']=body.get('mode','')
        elif body['action']=='hold-import':import_release.clear()
        elif body['action']=='release-import':import_release.set()
        elif body['action']=='hold-sign-in':sign_in_release.clear()
        elif body['action']=='release-sign-in':sign_in_release.set()
        elif body['action']=='scope':fault['scope']=True
        elif body['action']=='scope-clear':fault['scope']=False
        elif body['action']=='revoke-fail':fault['revoke_fail']=True
        elif body['action']=='sign-in-fail':fault['sign_in_fail']=True
        return JSONResponse({'ok':True})
    app=Starlette(routes=[Route('/fixture/allowlist',allowlist,methods=['POST']),Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),
      Route('/fixture/browser-return',browser_return,methods=['POST']),Route('/.well-known/oauth-protected-resource',resource_metadata),
      Route('/.well-known/oauth-protected-resource/mcp',resource_metadata),Route('/.well-known/oauth-authorization-server',metadata),
      Route('/register',register,methods=['POST']),Route('/authorize',authorize),Route('/token',exchange,methods=['POST']),
      Route('/revoke',revoke,methods=['POST']),Mount('/mcp',app=McpWire()),*collect_routes(data_dir=data)],lifespan=lifespan)
    app.state.drive_root=data;app.state.repo_dir=repo
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or not scope['path'].startswith('/api/'):return await app(scope,receive,send)
            raw=bytearray();messages=[];record={'method':scope['method'],'path':scope['path']}
            async def input():
                message=await receive();raw.extend(message.get('body',b''));return message
            async def output(message):messages.append(message)
            await app(scope,input,output)
            if raw:record['body']=json.loads(raw)
            if scope['path']=='/api/mcp/sign-in':
                record['origin']=dict(scope.get('headers',[])).get(b'origin',b'').decode()
                record['body']={key:value for key,value in record.get('body',{}).items() if key not in ('client_secret','returned_url')}
            record['status']=messages[0]['status']
            try:record['reply']=json.loads(b''.join(m.get('body',b'') for m in messages))
            except Exception:pass
            audit.append(record)
            if scope['path']=='/api/mcp/test':
                await probe_release.wait()
                if fault['probe_reply']:
                    import copy
                    body=copy.deepcopy(record['reply']);mode=fault['probe_reply']
                    assert body['ok'] is True, body
                    if mode=='ok':body['ok']='true'
                    elif mode=='count':body['tool_count']=-1
                    elif mode=='tool':body['tools'][-1]['name']=[]
                    elif mode=='metadata':body['tools'][-1]['metadata']=[]
                    elif mode=='warnings':body['configuration_warnings']='wrong'
                    elif mode=='instructions':body['instructions']=[]
                    return await JSONResponse(body)(scope,receive,send)
            if scope['path']=='/api/mcp/import/preview':
                record['no_store']=any(k.lower()==b'cache-control' and v==b'no-store' for k,v in messages[0].get('headers',[]))
                await import_release.wait()
                if fault['import_reply']:
                    import copy
                    body=copy.deepcopy(record['reply']);mode=fault['import_reply'];entry=body['entries'][0]
                    if mode=='ok':body['ok']='true'
                    elif mode=='tail':body['entries'][-1]['problems']=None
                    elif mode=='index':entry['index']=1
                    elif mode=='duplicate':body['entries'].append(copy.deepcopy(entry))
                    elif mode=='headers':entry['kept_header_names']={}
                    elif mode=='args':entry['arg_count']='0'
                    elif mode=='enabled':body['entries'][-1]['patch']['enabled']=True
                    elif mode=='patch':entry['patch']['MCP_ENABLED']=True
                    elif mode=='credential':entry['patch']['auth_token']='injected-value'
                    elif mode=='clear':
                        entry['patch']['headers']={};entry['header_changes']={'added':[],'replaced':[],'removed':[]};entry.pop('kept_header_names',None)
                    return await JSONResponse(body,headers={'Cache-Control':'no-store'})(scope,receive,send)
            if scope['path']=='/api/mcp/sign-in':
                await sign_in_release.wait()
                if fault['sign_in_fail']:
                    fault['sign_in_fail']=False
                    return await JSONResponse({'error':'fixture-owner-secret-937561','reason':'fixture-owner-secret-937561'},status_code=503)(scope,receive,send)
            if scope['path']=='/api/mcp/status' and fault['status_fail']:
                fault['status_fail']=False
                return await JSONResponse({'error':'fixture status unavailable'},status_code=503)(scope,receive,send)
            if scope['path']=='/api/mcp/status' and fault['malformed']:
                fault['malformed']=False
                return await JSONResponse({'enabled':True,'sdk_available':True,'servers':None})(scope,receive,send)
            for message in messages:await send(message)
    (run/'port').write_text(str(port));uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])

if __name__=='__main__':main()
