def main():
    """Real local managed-update status/check/preflight/manual; apply/restart boundary simulated."""
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

    import asyncio,copy,subprocess
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    from supervisor import git_ops,state as supervisor_state,update_merge
    from ouroboros.gateway import control as api
    from ouroboros.gateway.state import api_health
    from ouroboros import update_letter
    supervisor_state.init(data);supervisor_state.init_state()
    official=run/'official';official.mkdir()
    def git(folder,*args):return subprocess.run(['git',*args],cwd=folder,text=True,capture_output=True,check=True).stdout.strip()
    os.environ.update(GIT_AUTHOR_NAME='Fixture',GIT_AUTHOR_EMAIL='fixture@example.invalid',GIT_COMMITTER_NAME='Fixture',GIT_COMMITTER_EMAIL='fixture@example.invalid',OUROBOROS_UPDATE_CHANNEL='development')
    git(official,'init','-b','ouroboros');(official/'BIBLE.md').write_text('# Fixture constitution\n');(official/'VERSION').write_text('7.10.0\n');(official/'app.py').write_text('VERSION = 1\n');(official/'ouroboros').mkdir()
    from ouroboros.dialogue_store import THREAD_FORMAT
    (official/'ouroboros/dialogue_store.py').write_text(f'THREAD_FORMAT = {THREAD_FORMAT!r}\n');git(official,'add','.');git(official,'commit','-m','Fixture base')
    base=git(official,'rev-parse','HEAD');git(run,'clone','--origin','managed',str(official),str(repo))
    (repo/'.git'/git_ops.MANAGED_REPO_META_NAME).write_text(json.dumps({'managed_remote_name':'managed','managed_remote_branch':'ouroboros','managed_local_branch':'ouroboros','managed_remote_url':str(official)}))
    git_ops.init(repo,data,str(official),'ouroboros','ouroboros-stable')
    def release(version):
        (official/'VERSION').write_text(version+'\n');(official/'app.py').write_text('VERSION = '+repr(version)+'\n');git(official,'add','.');git(official,'commit','-m','Fixture official '+version);git(official,'tag','v'+version);return git(official,'rev-parse','HEAD')
    target=release('7.10.1');runtime={'running':base,'boot':'fixture-boot-1','progress':None,'after':None};fault={'status':'','preflight':'','apply':'','hold_post':False};audit=[];applies=[];commands=[];release_get=asyncio.Event();release_get.set();release_post=asyncio.Event();release_post.set()
    from ouroboros import server_process
    server_process.server_source_baseline=lambda:runtime['running']
    async def simulated_apply(request,*,expected_base_sha,expected_target_sha):
        plan=await asyncio.to_thread(update_merge.plan_managed_update_merge,fetch=True)
        if plan.get('base_sha')!=expected_base_sha or plan.get('target_sha')!=expected_target_sha:
            return JSONResponse({'error':'Fixture release moved','reason_code':'release_moved','outcome':'not_applied'},status_code=409)
        applies.append({'base':expected_base_sha,'target':expected_target_sha});git(repo,'merge','--ff-only',expected_target_sha)
        operation=f'fixture-update-{len(applies)}';runtime['progress']={'operation_id':operation,'active':False,'phase':'restarting','outcome':'applied','concluded_by':'apply','current_generation':True,'restart_required':True,'base_sha':expected_base_sha,'target_sha':expected_target_sha}
        runtime['after']={'operation_id':operation,'after':{'source_sha':expected_target_sha}}
        return JSONResponse({'status':'restart_required','error':'Fixture explicit restart needed','merge_plan':{**plan,'merge_commit':expected_target_sha}})
    api._apply_smart_update=simulated_apply
    async def command(request):
        body=await request.json();commands.append(body)
        if body.get('if_boot')!=runtime['boot']:return JSONResponse({'accepted':False,'reason_code':'boot_changed','error':'Fixture boot changed'},status_code=409)
        return JSONResponse({'status':'ok'})
    initial=config.SETTINGS_PATH.read_bytes()
    async def facts(request):return JSONResponse({'base':base,'target':target,'head':git(repo,'rev-parse','HEAD'),'remote_head':git(official,'rev-parse','HEAD'),'status':supervisor_state.load_state(),'runtime':runtime,'audit':audit,'applies':applies,'commands':commands,'settings_unchanged':config.SETTINGS_PATH.read_bytes()==initial})
    async def control(request):
        nonlocal target
        body=await request.json();action=body['action']
        if action=='fault':fault.update(body['values'])
        elif action=='hold':release_get.clear()
        elif action=='hold-post':fault['hold_post']=True;release_post.clear()
        elif action=='release-all':release_get.set();release_post.set();fault['hold_post']=False
        elif action=='release':target=release(body['version'])
        elif action=='finish-description':
            from ouroboros.task_results import write_task_result
            record=update_letter.read_record(data);requested=record['request'];task_id=requested['task_id']
            if 'text' in body:
                saved=update_letter.save_description(body['text'],requested['key']['base_sha'],requested['key']['target_sha'],expected_revision=record.get('revision',0),author={'task_id':task_id,'model':'fixture-writer'},drive_root=data)
                if saved['outcome']!='saved':return JSONResponse(saved,status_code=409)
            write_task_result(data,task_id,body.get('status','completed'))
            workers.PENDING[:]=[task for task in workers.PENDING if task.get('id')!=task_id]
        elif action=='boot':
            runtime['boot']=body.get('since','fixture-boot-'+str(len(applies)+1));runtime['running']=body.get('running',git(repo,'rev-parse','HEAD'))
            if runtime['progress']:runtime['progress'].update(concluded_by='boot',restart_required=False,**body.get('progress',{}))
        return JSONResponse({'ok':True})
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),Route('/api/update/status',api.api_update_status),Route('/api/update/check',api.api_update_check,methods=['POST']),Route('/api/update/preflight',api.api_update_preflight,methods=['POST']),Route('/api/update/apply',api.api_update_apply,methods=['POST']),Route('/api/update/description',api.api_update_description,methods=['POST']),Route('/api/health',api_health),Route('/api/git/log',api.api_git_log),Route('/api/command',command,methods=['POST'])]);app.state.drive_root=data;app.state.repo_dir=repo
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or not scope['path'].startswith('/api/'):return await app(scope,receive,send)
            raw=bytearray();messages=[];record={'method':scope['method'],'path':scope['path']};audit.append(record)
            async def input():message=await receive();raw.extend(message.get('body',b''));return message
            async def output(message):messages.append(message)
            await app(scope,input,output);record['status']=messages[0]['status']
            if raw:record['body']=json.loads(raw)
            body=json.loads(b''.join(m.get('body',b'') for m in messages));record['reply']=copy.deepcopy(body);path=scope['path']
            if path.endswith('/status') or path.endswith('/check'):
                if runtime['progress']:body['update_progress']=runtime['progress'];body['after_update']=runtime['after']
                mode=fault['status']
                if mode=='fail':return await JSONResponse({'error':'Fixture update status unavailable'},status_code=503)(scope,receive,send)
                if mode=='malformed':body['update_tx']=None
            if path.endswith('/preflight') and fault['preflight']=='malformed':body={'merge_plan':{'code_conflict_paths':'not-a-list'}}
            if path=='/api/health':body['boot']={**body.get('boot',{}),'since':runtime['boot'],'phase':'ready'}
            if path.endswith('/description') and fault.get('description')=='lost':
                fault['description']='';return await JSONResponse({'error':'Fixture lost description receipt'},status_code=503)(scope,receive,send)
            if scope['method']=='GET':await release_get.wait()
            if fault['hold_post'] and path.endswith('/apply'):await release_post.wait()
            if path.endswith('/apply') and fault['apply']=='lost' and record.get('body',{}).get('strategy')!='manual':
                fault['apply']='';return await JSONResponse({'error':'Fixture lost apply receipt'},status_code=503)(scope,receive,send)
            await JSONResponse(body,status_code=record['status'])(scope,receive,send)
    sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];(run/'port').write_text(str(port));uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])
if __name__=='__main__':main()
