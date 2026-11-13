def main():
    """Real publication preflight and task admission; scanner/provider execution substituted."""
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
    import copy
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    from ouroboros.gateway.router import collect_routes
    from ouroboros import skill_source_catalog
    skill_source_catalog.refresh_in_background=lambda *args,**kwargs:None
    from ouroboros.gateway import skill_publish as publication
    from ouroboros.skill_publish_scanner import SecretScanResult,SecretFinding,ScannerContractResult
    from ouroboros.skill_loader import load_skill,save_review_state,SkillReviewState
    skill_dir=data/'skills/external/fixture_publish';skill_dir.mkdir(parents=True)
    skill_dir.joinpath('SKILL.md').write_text('---\nname: fixture_publish\ndescription: Publication fixture\nversion: 1.0.0\n---\n# Publication fixture <&> 🔧\nOnly fixture instructions.\n')
    (repo/'skills').mkdir();(repo/'skills/builtin.json').write_text('{"schema_version":1,"skills":[]}')
    sources=[{'id':'fixture-hub','kind':'hub','name':'Fixture Hub','part':'official','url':'https://github.com/fixture/hub'},
      {'id':'fixture-entry','kind':'git','name':'Fixture Entry','url':'https://github.com/fixture/entry'},
      {'id':'fixture-tag','kind':'git','name':'Fixture Tag','url':'https://github.com/fixture/tag','ref':'refs/tags/v1'}]
    for source in sources:source['trust']='review'
    seed=json.loads(config.SETTINGS_PATH.read_text());seed['OUROBOROS_SKILL_SOURCES']=json.dumps(sources);config.SETTINGS_PATH.write_text(json.dumps(seed));initial=config.SETTINGS_PATH.read_bytes()
    fault={'scan':'clean','token':True,'create':'','task_get':'','preflight':'','sources':''};scans=[];audit=[];release=asyncio.Event();release.set()
    def review(status='clean'):
        loaded=load_skill(skill_dir,data);assert loaded
        save_review_state(data,'fixture_publish',SkillReviewState(status=status,content_hash=loaded.content_hash,reviewed_content_hash=loaded.content_hash,review_profile='full'))
    review()
    publication.github_token_from_env_or_settings=lambda:'fixture-not-a-real-token' if fault['token'] else ''
    publication.resolve_betterleaks=lambda **kwargs:SimpleNamespace(status='ready',binary_path='/fixture/no-binary',binary_sha256=fault['scan'])
    def contract(**kwargs):return ScannerContractResult(status='ready',engine='betterleaks',version='fixture-1',ruleset_sha256='a'*64,scan_contract_sha256=fault['scan'])
    publication.probe_scanner_contract=contract
    def scan(files,**kwargs):
        scans.append({'paths':list(files),'sizes':{p:len(v) for p,v in files.items()}});mode=fault['scan']
        finding=SecretFinding(path='SKILL.md',line=7,detector='fixture-detector',confidence='high' if mode=='blocker' else 'low',reason='Redacted fixture location <&> 🔧',verification='not_attempted',disposition='blocker' if mode=='blocker' else 'warning')
        return SecretScanResult(status='scanner_error' if mode=='repair' else 'findings' if mode in ('warning','blocker') else 'clean',engine='betterleaks',version='fixture-1',ruleset_sha256='a'*64,scan_contract_sha256=mode,
          findings=(finding,) if mode in ('warning','blocker') else (),blocker_count=int(mode=='blocker'),warning_count=int(mode=='warning'),audited_false_positive_count=0,
          reason_code='fixture_scanner_repair' if mode=='repair' else '',repair_hint='Repair the fixture scanner' if mode=='repair' else '')
    publication.scan_named_bytes=scan
    async def facts(request):
        from ouroboros.task_results import load_task_result
        loaded=load_skill(skill_dir,data)
        return JSONResponse({'skill':{'name':loaded.name,'content_hash':loaded.content_hash},'audit':audit,'scans':scans,'pending':[{'task_id':item.get('task_id'),'type':item.get('type')} for item in workers.PENDING],'records':{r['body']['task_id']:load_task_result(data,r['body']['task_id'],strict=True) for r in audit if r.get('path')=='/api/tasks' and r.get('body',{}).get('task_id')},'settings_unchanged':config.SETTINGS_PATH.read_bytes()==initial})
    async def control(request):
        body=await request.json();action=body['action']
        if action=='fault':fault.update(body['values'])
        elif action=='review':review(body['status'])
        elif action=='change':
            with skill_dir.joinpath('SKILL.md').open('a') as f:f.write('\nChanged fixture payload\n')
            review()
        elif action=='hold':release.clear()
        elif action=='release-all':release.set()
        return JSONResponse({'ok':True})
    routes=collect_routes(data_dir=data)
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),*routes]);app.state.drive_root=data;app.state.repo_dir=repo
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or not scope['path'].startswith('/api/'):return await app(scope,receive,send)
            raw=bytearray();messages=[];record={'method':scope['method'],'path':scope['path']};audit.append(record)
            async def input():message=await receive();raw.extend(message.get('body',b''));return message
            async def output(message):messages.append(message)
            is_create=scope['path']=='/api/tasks' and scope['method']=='POST'
            mode=fault['create'] if is_create else ''
            if is_create:fault['create']=''
            if mode=='lost-before':
                record['status']=503;return await JSONResponse({'error':'Fixture lost before create'},status_code=503)(scope,receive,send)
            await app(scope,input,output);record['status']=messages[0]['status']
            if raw:record['body']=json.loads(raw)
            try:record['reply']=json.loads(b''.join(m.get('body',b'') for m in messages))
            except Exception:pass
            await release.wait()
            if is_create and mode=='lost-after':return await JSONResponse({'error':'Fixture lost after create'},status_code=503)(scope,receive,send)
            if is_create and mode=='malformed':return await JSONResponse({'ok':True,'status':'scheduled','task_id':'foreign-task'})(scope,receive,send)
            if scope['method']=='GET' and scope['path'].startswith('/api/tasks/') and fault['task_get']=='foreign':
                value=copy.deepcopy(record['reply']);value['metadata']={**value.get('metadata',{}),'skill_publish_target':{'skill':'fixture_publish','repository':'fixture/foreign'}}
                return await JSONResponse(value)(scope,receive,send)
            if scope['path'].endswith('/publish-preflight') and fault['preflight']=='malformed':return await JSONResponse({'ok':True,'skill':'fixture_publish','repository':'fixture/hub','state':'ready','task_start_allowed':True,'findings':None})(scope,receive,send)
            if scope['path']=='/api/skill-sources' and fault['sources']=='malformed':return await JSONResponse({'sources':[None]})(scope,receive,send)
            for message in messages:await send(message)
    sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];(run/'port').write_text(str(port));uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])
if __name__=='__main__':main()
