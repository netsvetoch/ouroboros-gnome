def main():
    """Real ClawHub routes, lifecycle, archive adapter and landing with synthetic registry/review."""
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

    import asyncio, copy, hashlib, io, zipfile
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    from ouroboros.gateway import marketplace as api
    from ouroboros.marketplace import install as pipeline
    from ouroboros.marketplace.clawhub import ClawHubSkillSummary,ClawHubArchive,ClawHubNotFoundError
    from ouroboros.skill_loader import load_skill,save_review_state,SkillReviewState
    slug='owner/native-fixture';name='owner__native-fixture';audit=[];downloads=[];reviews=[];latest='1.0.0'
    def info(key):
        if key not in (slug,'plugin-fixture','second-fixture'):raise ClawHubNotFoundError('Fixture missing package')
        return ClawHubSkillSummary(slug=key,display_name='Native fixture' if key==slug else key,latest_version=latest,versions=['1.0.0','2.0.0'],summary='Registry summary <&> 🔧',description='Inert local fixture',os_list=['linux'],requires_env=['FIXTURE_TOKEN'],requires_bins=['python3'],primary_env='FIXTURE_TOKEN',license='MIT',is_plugin=key=='plugin-fixture',badges={'official':key==slug})
    def search(query,**options):
        page=[info(slug),info('plugin-fixture')] if not options.get('cursor') else [info(slug),info('second-fixture')]
        if query:page=[info(slug),info('plugin-fixture')]
        return {'results':page,'next_cursor':'page-two','warnings':['Fixture registry metadata'],'path':'fixture-packages'}
    def download(key,version=None):
        downloads.append({'slug':key,'version':version});buf=io.BytesIO()
        with zipfile.ZipFile(buf,'w') as archive:
            archive.writestr('SKILL.md',f'---\nname: native-fixture\ndescription: Inert fixture\n---\n# Native fixture {version}\nNo commands are executed.\n')
        content=buf.getvalue();return ClawHubArchive(key,version,content,hashlib.sha256(content).hexdigest())
    def review(root,source,skill_name):
        reviews.append(skill_name);loaded=load_skill(data/'skills/clawhub'/skill_name,data)
        save_review_state(data,skill_name,SkillReviewState(status='clean',content_hash=loaded.content_hash,reviewed_content_hash=loaded.content_hash,review_profile='full'))
        return 'clean',[],''
    api._registry_info=info;api._registry_search=search;pipeline._registry_info=info;pipeline._registry_download=download;pipeline._run_skill_review=review
    release=asyncio.Event();release.set();fault={'search':'','preview':'','write':''};initial=config.SETTINGS_PATH.read_bytes()
    async def facts(request):
        root=data/'skills/clawhub'/name
        return JSONResponse({'audit':audit,'downloads':downloads,'reviews':reviews,'installed':root.is_dir(),'content':(root/'SKILL.md').read_text() if (root/'SKILL.md').is_file() else '', 'settings_unchanged':config.SETTINGS_PATH.read_bytes()==initial})
    async def control(request):
        nonlocal latest
        body=await request.json()
        if body['action']=='hold':release.clear()
        elif body['action']=='release-all':release.set()
        elif body['action']=='fault':fault.update(body['values'])
        elif body['action']=='latest':latest=body['version']
        return JSONResponse({'ok':True})
    base='/api/marketplace/clawhub'
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),Route(base+'/search',api.api_marketplace_search),Route(base+'/info/{slug:path}',api.api_marketplace_info),Route(base+'/preview/{slug:path}',api.api_marketplace_preview),Route(base+'/installed',api.api_marketplace_installed),Route('/api/marketplace/ouroboroshub/installed',api.api_hub_installed),Route(base+'/install',api.api_marketplace_install,methods=['POST']),Route(base+'/update/{name}',api.api_marketplace_update,methods=['POST']),Route(base+'/uninstall/{name}',api.api_marketplace_uninstall,methods=['POST'])]);app.state.drive_root=data;app.state.repo_dir=repo
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or not scope['path'].startswith('/api/'):return await app(scope,receive,send)
            record={'method':scope['method'],'path':scope['path'],'query':scope.get('query_string',b'').decode()};audit.append(record);raw=bytearray();messages=[]
            async def input():message=await receive();raw.extend(message.get('body',b''));return message
            async def output(message):messages.append(message)
            await app(scope,input,output)
            if raw:record['body']=json.loads(raw)
            record['status']=messages[0]['status'];body=json.loads(b''.join(m.get('body',b'') for m in messages));record['reply']=copy.deepcopy(body)
            if scope['method']=='GET':await release.wait()
            mode=fault['search'] if scope['path'].endswith('/search') else fault['preview'] if '/preview/' in scope['path'] else ''
            if mode=='malformed':
                if 'results' in body:body['results'].append(None)
                else:body['summary']=None
            if mode=='fail':return await JSONResponse({'error':'Fixture registry unavailable'},status_code=503)(scope,receive,send)
            if scope['method']=='POST' and fault['write']=='lost':
                fault['write']='';return await JSONResponse({'error':'Fixture lost operation receipt'},status_code=503)(scope,receive,send)
            await JSONResponse(body,status_code=record['status'])(scope,receive,send)
    sock=socket.socket();sock.bind(('127.0.0.1',0));(run/'port').write_text(str(sock.getsockname()[1]));uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])

if __name__=='__main__':main()
