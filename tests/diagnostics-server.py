"""Real log/store/ledger/Git/evolution endpoints in a disposable installation.
Only HTTP failures and a barrier around actual background measurement are injected."""
def main():
    import asyncio,json,os,pathlib,socket,subprocess,sys,threading
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    run=pathlib.Path(sys.argv[1]);data=run/'data';repo=run/'repo'
    for path in (data/'logs',data/'memory',data/'state',repo/'prompts'):path.mkdir(parents=True)
    for key in list(os.environ):
        if key.startswith('OUROBOROS_'):os.environ.pop(key)
    os.environ.update(OUROBOROS_APP_ROOT=str(run),OUROBOROS_DATA_DIR=str(data),OUROBOROS_REPO_DIR=str(repo),OUROBOROS_SETTINGS_PATH=str(data/'settings.json'))
    from ouroboros import config,store_import
    from ouroboros.settings_setup_contract import SECRET_SETTING_KEYS
    for key in SECRET_SETTING_KEYS:os.environ.pop(key,None)
    config.initialize_runtime_mode_baseline('light');config.SETTINGS_PATH.write_text('{}');initial=config.SETTINGS_PATH.read_bytes()
    rows=[]
    for n,cost in enumerate((.31,None)):
        base={'attempt_id':f'fixture-attempt-{n}','kind':'attempt','root_task_id':f'fixture-task-{n}','task_id':f'fixture-task-{n}','provider':'fixture-provider','model':'fixture-model','category':'task','reservation_upper_bound_usd':.5,'pricing_known':True,'ts':'2026-11-01T00:00:00Z'}
        for state in ('reserved','dispatched',*(('settled',) if cost is not None else ())):rows.append({**base,'state':state,**({'cost_usd':cost,'cost_final':True,'prompt_tokens':100,'completion_tokens':20} if state=='settled' else {})})
    (data/'state/usage_attempts.jsonl').write_text(''.join(json.dumps({'seq':i+1,**row})+'\n' for i,row in enumerate(rows)))
    (data/'logs/chat.jsonl').write_text('');(data/'logs/progress.jsonl').write_text('')
    store_import.ensure_current_store(data,with_children=False)
    from ouroboros.usage_store import migrate_from_journal
    migrate_from_journal(data)
    from ouroboros import dialogue_store as ds
    for stream in ('chat','progress'):
        for i in range(4):ds.append(data,stream,{'type':'human_message' if stream=='chat' else 'task_progress','role':'human','chat_id':1,'task_id':f'fixture-task-{i%2}','text':f'{stream} store row {i} <&> 🔧','ts':'2026-11-01T00:00:00Z'},emit_live=False)
    for name in ('events','tools','supervisor'):
        (data/f'logs/{name}.jsonl').write_text(''.join(json.dumps({'type':'fixture_log','task_id':f'fixture-task-{i%2}','message':f'{name} file row {i} <&> 🔧'})+'\n' for i in range(8)))
    def git(*args,day=1):
        env={**os.environ,'GIT_AUTHOR_DATE':f'2026-11-{day:02}T00:00:00Z','GIT_COMMITTER_DATE':f'2026-11-{day:02}T00:00:00Z'}
        return subprocess.run(['git',*args],cwd=repo,env=env,text=True,capture_output=True,check=True).stdout.strip()
    git('init','-b','fixture-branch');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid')
    def release(version,count,day):
        (repo/'sample.py').write_text(''.join(f'line_{i} = {i}\n' for i in range(count)))
        (repo/'BIBLE.md').write_text('Fixture bible <&> 🔧\n');(repo/'prompts/SYSTEM.md').write_text('Fixture system\n')
        (repo/'README.md').write_text(f'# Fixture\n\n## Version History\n\n- **{version}** — Release fixture {version} <&> 🔧\n')
        git('add','.');git('commit','-m',f'Fixture release {version}',day=day);git('tag','-a','v'+version,'-m',f'Fixture annotation {version} <&> 🔧',day=day)
    release('1.0.0',3,1);release('1.1.0',5,2)
    from ouroboros.evolution_checkpoints import CHECKPOINTS_REL
    (data/CHECKPOINTS_REL).write_text(json.dumps({'kind':'absorb','task_id':'fixture-task-0','campaign_id':'fixture-campaign','campaign_objective':'Fixture objective <&> 🔧','ts':'2026-11-02T00:00:00Z','outcome_axes':{'execution':{'status':'completed'}},'transaction':{'cycle_outcome':'fixture-outcome','commit_sha':git('rev-parse','HEAD')},'cost_usd':None,'cost_accounting_status':'unavailable','rounds':2})+'\n')
    for name,field in (('identity','new_len'),('scratchpad','content_len')):(data/f'memory/{name}_journal.jsonl').write_text(json.dumps({'ts':'2026-11-01T00:00:00Z',field:42})+'\n')
    from ouroboros import evolution_history
    evolution_history.history.projection(str(repo),str(data));evolution_history.history.join(10)
    real_refresh=evolution_history.refresh;measure=threading.Event();measure.set();fault={'logs':'','cost':'','history':'','git':'','measure_fail':False};audit=[];wire_release=asyncio.Event();wire_release.set()
    def refresh(*args,**kwargs):
        measure.wait()
        if fault['measure_fail']:raise RuntimeError('Fixture measurement refused')
        return real_refresh(*args,**kwargs)
    evolution_history.refresh=refresh
    from ouroboros.gateway.logs import api_logs_tail
    from ouroboros.gateway.control import api_git_log,api_evolution_data
    from ouroboros.gateway.cost_breakdown import make_cost_breakdown_endpoint
    async def facts(request):return JSONResponse({'audit':audit,'saved':evolution_history.read_snapshot(str(data)),'settings_unchanged':config.SETTINGS_PATH.read_bytes()==initial})
    async def control(request):
        body=await request.json();action=body['action']
        if action=='fault':fault.update(body['values'])
        elif action=='hold':wire_release.clear()
        elif action=='release-all':wire_release.set();measure.set()
        elif action=='hold-measure':measure.clear()
        elif action=='release-measure':measure.set();await asyncio.to_thread(evolution_history.history.join,10)
        elif action=='new-release':release('1.2.0',8,3)
        elif action=='empty-logs':(data/'logs/events.jsonl').write_text('')
        return JSONResponse({'ok':True})
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),Route('/api/logs/{name}',api_logs_tail),Route('/api/cost-breakdown',make_cost_breakdown_endpoint(data)),Route('/api/git/log',api_git_log),Route('/api/evolution-data',api_evolution_data)]);app.state.drive_root=data;app.state.repo_dir=repo
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or not scope['path'].startswith('/api/'):return await app(scope,receive,send)
            path=scope['path'];record={'path':path,'query':scope['query_string'].decode()};audit.append(record);messages=[]
            async def output(message):messages.append(message)
            await app(scope,receive,output);record['status']=messages[0]['status']
            try:record['reply']=json.loads(b''.join(m.get('body',b'') for m in messages))
            except Exception:pass
            await wire_release.wait()
            mode=fault['logs' if path.startswith('/api/logs/') else 'cost' if path.endswith('/cost-breakdown') else 'git' if path.endswith('/git/log') else 'history']
            if mode=='fail':return await JSONResponse({'error':'Fixture read failed'},status_code=503)(scope,receive,send)
            if mode=='malformed':return await JSONResponse({'entries':None} if path.startswith('/api/logs/') else {'accounting':None} if path.endswith('/cost-breakdown') else {'commits':[None],'tags':[]} if path.endswith('/git/log') else {'versions':[None]})(scope,receive,send)
            for message in messages:await send(message)
    sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];(run/'port').write_text(str(port));uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])
if __name__=='__main__':main()
