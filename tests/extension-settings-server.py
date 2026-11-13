"""Real PluginAPI settings validation/registry/dispatch; runtime liveness supplied
by fixture. Synthetic plugin state is isolated; no core Settings writes."""
def main():
    import asyncio,hashlib,json,os,pathlib,socket,sys
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse,Response
    from starlette.routing import Route
    run=pathlib.Path(sys.argv[1]);data=run/'data';repo=run/'repo';data.mkdir();repo.mkdir()
    for key in list(os.environ):
        if key.startswith('OUROBOROS_'):os.environ.pop(key)
    os.environ.update(OUROBOROS_APP_ROOT=str(run),OUROBOROS_DATA_DIR=str(data),OUROBOROS_REPO_DIR=str(repo),OUROBOROS_SETTINGS_PATH=str(data/'settings.json'))
    from ouroboros import config,extension_loader
    from ouroboros.settings_setup_contract import SECRET_SETTING_KEYS
    for key in SECRET_SETTING_KEYS:os.environ.pop(key,None)
    config.initialize_runtime_mode_baseline('light');config.SETTINGS_PATH.write_text('{}');initial=config.SETTINGS_PATH.read_bytes()
    from ouroboros.extension_plugin_api import PluginAPIImpl
    from ouroboros.extension_registry_state import _PluginAPIConfig
    from ouroboros.gateway.extensions import api_extension_settings_section,api_extension_dispatch
    named={'ok':False,'error':'Saved field called error'}
    skill='fixture_settings';state={'name':'Saved <&> 🔧','notes':'Line one\nLine two','count':4,'enabled':True,'mode':'legacy-mode','secret':'synthetic-stored-secret','locked':'read-only'};wire=[];audit=[];fault={'read':'','write':'','sections':''};release=asyncio.Event();release.set()
    def safe(body):return {k:hashlib.sha256(v.encode()).hexdigest() if k=='secret' and isinstance(v,str) else v for k,v in body.items()}
    async def handler(request):
        endpoint=request.url.path.rsplit('/',1)[-1];body=await request.json() if request.method in ('POST','PUT','PATCH','DELETE') else {}
        wire.append({'path':endpoint,'method':request.method,'query':dict(request.query_params),'body':safe(body)})
        if request.method=='GET':
            if endpoint=='offline':return JSONResponse({'error':'Fixture store offline'},status_code=503)
            if endpoint=='refused':return {'ok':False,'message':'Fixture values refused'}
            if endpoint=='empty':return {}
            if endpoint=='named':return named
            if endpoint=='search':return {'message':'Search accepted '+request.query_params['term']} if 'term' in request.query_params else {'term':'initial'}
            if fault['read']=='fail':return JSONResponse({'error':'Fixture read failed'},status_code=503)
            if fault['read']=='malformed':return []
            return state
        if endpoint=='named':
            named.update(body)
            return named
        if endpoint=='config':
            mode=fault['write'];fault['write']=''
            if mode=='refuse':return JSONResponse({'error':'Fixture write refused'},status_code=400)
            if mode=='cutrefuse':return Response('{',status_code=400,headers={'X-Fixture-Cut':'1'})
            if mode=='jsontextrefuse':return Response(json.dumps({'error':'Fixture JSON refusal'}),media_type='text/plain')
            state.update(body);(data/'plugin-state.json').write_text(json.dumps(state))
            if mode=='timeout':return JSONResponse({'error':'Fixture accepted but timeout'},status_code=408)
            if mode=='lost':return JSONResponse({'error':'Fixture accepted but reply lost'},status_code=503)
            if mode=='read-fails':fault['read']='fail'
            if mode=='empty':return Response(status_code=204)
            if mode=='text':return Response('Accepted text',media_type='text/plain')
            if mode=='badjson':return Response('{',media_type='application/json')
            if mode=='cut':return Response('{',media_type='application/json',headers={'X-Fixture-Cut':'1'})
            if mode=='jsontext':return Response(json.dumps({'message':'MIME-independent receipt'}),media_type='text/plain')
        if endpoint=='run':
            mode=fault.pop('action_reply','')
            if mode=='empty':return Response(status_code=204)
            if mode=='text':return Response('Accepted text',media_type='text/plain')
            if mode=='badjson':return Response('{',media_type='application/json')
            if mode=='cut':return Response('{',media_type='application/json',headers={'X-Fixture-Cut':'1'})
            if mode=='jsontext':return Response(json.dumps({'message':'MIME-independent action receipt'}),media_type='text/plain')
        return {'message':'Fixture action confirmed <&> 🔧' if endpoint!='config' else 'Fixture configuration saved'}
    api=PluginAPIImpl(_PluginAPIConfig(skill_name=skill,permissions=['widget','route'],env_allowlist=[],state_dir=data/'plugin',settings_reader=lambda:{},drive_root=data))
    for endpoint in ('config','offline','refused','empty','search','run','put','patch','delete','head','named'):
        api.register_route(endpoint,handler,methods=['GET','POST','PUT','PATCH','DELETE','HEAD'])
    api.register_route('legacy',handler,methods=['POST'])
    fields=[{'name':'name','label':'Name','type':'text','required':True}, {'name':'notes','label':'Notes','type':'textarea'},
      {'name':'count','label':'Count','type':'number','min':0,'max':10},{'name':'enabled','label':'Enabled','type':'checkbox'},
      {'name':'mode','label':'Mode','type':'select','options':['known-mode']},{'name':'secret','label':'Secret','type':'password'},
      {'name':'locked','label':'Locked','type':'text','disabled':True}]
    forms=[{'type':'form','route':'config','method':'POST','submit_label':'Save main','fields':fields},
      {'type':'form','route':'config','submit_label':'Save twin','fields':[{'name':'name','label':'Twin name','type':'text'}]},
      *({'type':'form','route':name,'submit_label':'Save '+name,'fields':[{'name':'name','label':name+' value','type':'text','default':'Default '+name}]} for name in ('legacy','offline','refused','empty')),
      {'type':'action','route':'search','method':'GET','submit_label':'Search','fields':[{'name':'term','label':'Search term','type':'text'}]},
      *({'type':'action','route':name,'method':method,'label':'Run '+name} for name,method in [('run','POST'),('put','PUT'),('patch','PATCH'),('delete','DELETE'),('head','HEAD')]),
      {'type':'form','route':'named','submit_label':'Save named','fields':[{'name':'ok','label':'Ordinary ok','type':'checkbox'},{'name':'error','label':'Ordinary error','type':'text'}]},
      {'type':'markdown','text':'# Fixture description <&> 🔧'}, {'type':'json','value':{'fixture':'Readonly <&> 🔧'}}]
    api.register_settings_section('config','Fixture native settings',schema={'components':forms})
    api._publish_registrations(content_hash='fixture-reviewed-hash')
    extension_loader.runtime_state_for_skill_name=lambda *args,**kwargs:{'desired_live':True,'live_loaded':True}
    async def facts(request):return JSONResponse({'wire':wire,'audit':audit,'state':safe(state),'settings_unchanged':config.SETTINGS_PATH.read_bytes()==initial})
    async def control(request):
        body=await request.json();action=body['action']
        if action=='fault':fault.update(body['values'])
        elif action=='hold':release.clear()
        elif action=='release-all':release.set()
        return JSONResponse({'ok':True})
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),Route('/api/extensions/{skill}/settings_section',api_extension_settings_section),Route('/api/extensions/{skill}/{rest:path}',api_extension_dispatch,methods=['GET','POST','PUT','PATCH','DELETE','HEAD'])]);app.state.drive_root=data;app.state.repo_dir=repo
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or not scope['path'].startswith('/api/'):return await app(scope,receive,send)
            raw=bytearray();messages=[];record={'method':scope['method'],'path':scope['path']};audit.append(record)
            async def input():message=await receive();raw.extend(message.get('body',b''));return message
            async def output(message):messages.append(message)
            await app(scope,input,output);record['status']=messages[0]['status']
            if raw:record['body']=safe(json.loads(raw))
            if scope['method']=='GET':await release.wait()
            if scope['path'].endswith('/settings_section') and fault['sections']=='malformed':return await JSONResponse({'skill':skill,'sections':[None]})(scope,receive,send)
            if any(key.lower()==b'x-fixture-cut' for key,value in messages[0].get('headers',[])):
                headers=[(key,value) for key,value in messages[0]['headers'] if key.lower() not in (b'content-length',b'x-fixture-cut')]
                await send({**messages[0],'headers':headers+[(b'content-length',b'4096')]})
                await send({'type':'http.response.body','body':b'{','more_body':True})
                await asyncio.sleep(.15)
                raise RuntimeError('Fixture intentionally interrupted optional response body')
            for message in messages:await send(message)
    sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];(run/'port').write_text(str(port));uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])
if __name__=='__main__':main()
