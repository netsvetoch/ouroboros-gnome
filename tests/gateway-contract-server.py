"""Actual contract_document/api_contract/api_health in an isolated installation.
Only response defects, additive fields and a response barrier are injected."""
def main():
    import asyncio,copy,json,os,pathlib,socket,sys
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    run=pathlib.Path(sys.argv[1]);data=run/'data';repo=run/'repo';data.mkdir();repo.mkdir()
    for key in list(os.environ):
        if key.startswith('OUROBOROS_'):os.environ.pop(key)
    os.environ.update(OUROBOROS_APP_ROOT=str(run),OUROBOROS_DATA_DIR=str(data),OUROBOROS_REPO_DIR=str(repo),OUROBOROS_SETTINGS_PATH=str(data/'settings.json'))
    from ouroboros import config
    from ouroboros.settings_setup_contract import SECRET_SETTING_KEYS
    for key in SECRET_SETTING_KEYS:os.environ.pop(key,None)
    config.initialize_runtime_mode_baseline('light');config.SETTINGS_PATH.write_text('{}');initial=config.SETTINGS_PATH.read_bytes()
    from ouroboros.gateway.schema import contract_document
    from ouroboros.gateway.state import api_contract,api_health
    document=contract_document();task=next(row for row in document['http'] if row['method']=='POST' and row['path']=='/api/tasks');missing=task['request']['schemas'][0]
    audit=[];fault={'contract':'','health':'','marker':''};release=asyncio.Event();release.set()
    async def facts(request):return JSONResponse({'http_count':len(document['http']),'ws_count':1+len(document['ws']['messages']),'call_count':1+len(document['call_socket']['peer_messages'])+len(document['call_socket']['server_messages']),'schema_count':len(document['schemas']),'task':task,'missing':missing,'audit':audit,'settings_unchanged':config.SETTINGS_PATH.read_bytes()==initial})
    async def control(request):
        body=await request.json();action=body['action']
        if action=='fault':fault.update(body['values'])
        elif action=='hold':release.clear()
        elif action=='release-all':release.set()
        return JSONResponse({'ok':True})
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),Route('/api/contract',api_contract),Route('/api/health',api_health)]);app.state.drive_root=data;app.state.repo_dir=repo
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or not scope['path'].startswith('/api/'):return await app(scope,receive,send)
            record={'path':scope['path'],'authorization':dict(scope['headers']).get(b'authorization',b'').decode()};audit.append(record);messages=[]
            async def output(message):messages.append(message)
            await app(scope,receive,output);record['status']=messages[0]['status'];body=json.loads(b''.join(m.get('body',b'') for m in messages));mode=fault['health' if scope['path'].endswith('/health') else 'contract']
            if mode=='fail':result=JSONResponse({'error':'Fixture contract/health unavailable'},status_code=503)
            else:
                body=copy.deepcopy(body)
                if scope['path'].endswith('/health'):
                    if mode=='mismatch':body['abi_version']='fixture-other-abi'
                    if mode=='malformed':body['status']='not-confirmed'
                else:
                    if fault['marker']:body['fixture_additive']={'marker':fault['marker'],'literal':'<&> 🔧'}
                    if mode=='schemas':body['schemas']=None
                    if mode=='http':body['http'][0]=None
                    if mode=='ws':body['ws']['messages']=None
                    if mode=='call':body['call_socket']['peer_messages']=None
                    if mode=='missing':body['schemas'].pop(missing)
                    if mode=='empty':body.update(http=[],schemas={},ws={**body['ws'],'messages':[]},call_socket={**body['call_socket'],'peer_messages':{},'server_messages':{}})
                result=JSONResponse(body)
            await release.wait();await result(scope,receive,send)
    sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];(run/'port').write_text(str(port));uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])
if __name__=='__main__':main()
