def main():
    """Actual lifecycle lane and queue endpoint with inert gated runners; no skill/model execution."""
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

    import asyncio, contextlib, copy
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route, WebSocketRoute
    from ouroboros.gateway.router import collect_routes
    from ouroboros import skill_lifecycle_queue as lane
    from ouroboros.task_results import write_task_result
    for task in ('operation-task','root-task','origin-task','origin-root','presentation-task'):
        write_task_result(data,task,'completed',chat_id=1,result='Fixture job provenance task')
    if os.environ.get('NATIVE_SKILL_REFUSAL_FIXTURE'):
        os.environ['OUROBOROS_SKILLS_REPO_PATH']=str(run/'empty-skills')
        os.environ['OUROBOROS_AUTO_GRANT_REVIEWED_SKILLS']='false'
        from tests._extension_loader_shared import _write_ext_skill
        from ouroboros.skill_loader import load_skill,save_review_state,SkillReviewState,save_enabled
        payload=_write_ext_skill(data/'skills/external','response_fixture',permissions=['tool','inject_chat'],plugin_body='def register(api):\n    return None\n')
        loaded=load_skill(payload,data)
        save_review_state(data,'response_fixture',SkillReviewState(status='clean',content_hash=loaded.content_hash))
        save_enabled(data,'response_fixture',False,actor='owner_ui')
    import threading
    mutation_names=('toggle_fixture','delete_fixture','no_state_fixture')
    mutation_gate=threading.Event();mutation_gate.set();mutation_pause={'name':''};mutation_wire={'mode':'','reply':None};mutation_answer_wait=lane.JOB_ANSWER_WAIT_SEC
    def seed_mutation(name):
        from tests._skill_source_fixtures import write_skill
        from ouroboros.skill_loader import load_skill,save_review_state,SkillReviewState,save_enabled,skill_state_dir_path
        payload=write_skill(data/'skills/external',name,body='Native isolated instruction payload <&>')
        loaded=load_skill(payload,data)
        if name!='no_state_fixture':save_review_state(data,name,SkillReviewState(status='clean',content_hash=loaded.content_hash))
        if name!='no_state_fixture':save_enabled(data,name,False,actor='owner_ui')
        if name!='no_state_fixture':
            folder=skill_state_dir_path(data,name);folder.mkdir(parents=True,exist_ok=True);(folder/'sentinel.txt').write_text('Isolated saved skill state <&>')
    if os.environ.get('NATIVE_SKILL_MUTATION_FIXTURE'):
        os.environ['OUROBOROS_SKILLS_REPO_PATH']=str(run/'empty-skills')
        for name in mutation_names:seed_mutation(name)
        (data/'skills/external/neighbour.txt').write_text('Retain neighbouring material <&>')
        import ouroboros.skill_lifecycle_actions as mutation_actions
        original_toggle=mutation_actions._toggle
        def held_toggle(skill,*args,**kwargs):
            if mutation_pause['name']==skill.name:
                if not mutation_gate.wait(40):raise TimeoutError('Fixture mutation gate timed out')
            return original_toggle(skill,*args,**kwargs)
        mutation_actions._toggle=held_toggle
    from supervisor import message_bus, state
    state.init(data,total_budget_limit=0)
    from ouroboros.projects_registry import create_project
    project=create_project(data,'lifecycle-project',name='Lifecycle project <&>')
    message_bus.init(data,0,1000,message_bus.LocalChatBridge())
    frames=[];peers=set();broadcasts=[];duplicate_runners=[]
    async def publish(frame):
        for peer in list(peers):
            try:await peer.send_json(frame)
            except Exception:peers.discard(peer)
    def broadcast(frame):
        frames.append(copy.deepcopy(frame));broadcasts.append(asyncio.create_task(publish(copy.deepcopy(frame))))
    message_bus._BRIDGE._broadcast_fn=broadcast
    jobs={};gates={};tasks=[];audit=[];wire={'value':None,'fail':False};release=asyncio.Event();release.set()
    async def start(name, chat=0, fail=False, kind="fixture-inspect"):
        gates[name]=asyncio.Event()
        previous_ids={row['id'] for row in lane.queue_snapshot()['events']}
        async def runner():
            await gates[name].wait()
            if fail: raise RuntimeError('Private lifecycle failure <&> Ω')
            return {'ok':True}
        def started(job):
            jobs[name]=job
            if name=='alpha':job.started_at='2020-01-01T00:00:00+00:00'
        options=lane.LifecycleJobOptions(drive_root=data,on_started=started,
            presentation={'group_id':'private-group <&>','task_id':'operation-task','root_task_id':'root-task',
                'origin_task_id':'origin-task','origin_root_task_id':'origin-root','presentation_owner_task_id':'presentation-task'},
            result_message=lambda result:'Private lifecycle completed <&> Ω')
        task=asyncio.create_task(lane.run_lifecycle_job(kind=kind,target=name,runner=runner,
            source='private-source <&>',message='Private lifecycle message <&> Ω',dedupe_key='fixture-'+name,chat_id=chat,options=options))
        tasks.append(task)
        for _ in range(200):
            matches=[row for row in lane.queue_snapshot()['events'] if row['target']==name and row['id'] not in previous_ids]
            if matches:return matches[-1]
            await asyncio.sleep(.01)
        raise AssertionError('job did not register')
    async def control(request):
        body=await request.json();action=body['action']
        if action=='seed':
            await start('alpha',0);await start('beta',1,True)
        elif action=='progress-seed':
            await start('review-skill <&> Ω',1,kind='review')
        elif action=='duplicate':
            async def duplicate_runner():duplicate_runners.append(True)
            try:
                await lane.run_lifecycle_job(kind='review',target='review-skill <&> Ω',runner=duplicate_runner,
                    dedupe_key='fixture-review-skill <&> Ω',chat_id=body['chat_id'],options=lane.LifecycleJobOptions(drive_root=data))
            except lane.DuplicateLifecycleJobError:pass
        elif action=='mutation-fault':mutation_wire.update(mode=body.get('mode',''),reply=body.get('reply'))
        elif action=='mutation-queue-release':release.set()
        elif action=='mutation-job':await start('toggle_fixture',1,kind='fixture-noop')
        elif action=='mutation-edit':
            assert body['name'] in mutation_names
            with (data/'skills/external'/body['name']/'SKILL.md').open('a') as edited:edited.write('\nFixture edited revision\n')
        elif action=='mutation-seed':
            assert body['name'] in mutation_names
            seed_mutation(body['name'])
        elif action=='mutation-pending':
            lane.JOB_ANSWER_WAIT_SEC=.01
            mutation_pause['name']=body['name'];mutation_gate.clear()
        elif action=='mutation-release':mutation_pause['name']='';mutation_gate.set();lane.JOB_ANSWER_WAIT_SEC=mutation_answer_wait
        elif action=='grant-policy':
            import ouroboros.skill_lifecycle_actions as actions
            from ouroboros.skill_loader import requested_skill_permissions
            actions.requested_skill_permissions=requested_skill_permissions if body.get('restore') else lambda *args: ['tool']
        elif action=='dispatch':
            from ouroboros.settings_scales import choose_effort, effort_fact
            from ouroboros.subagents import SubagentDispatch, SubagentLaneResolution, CapabilityDelta
            from ouroboros.supervisor_route import validate_cognitive_route
            from ouroboros.subagent_messages import subagent_message_meta
            requested='ultra'; mode=body.get('mode','auto')
            level,source=choose_effort(requested,pin='low' if mode=='pin' else '',
                model_named='xhigh' if mode=='model_name' else '',binds=mode!='cyber',
                rng={'min':'low','max':'high','recommended':'medium'})
            dispatch=SubagentDispatch(SubagentLaneResolution('heavy','main','executor-model <&>'),level,
                'native','native-route <&>','read_only',CapabilityDelta(),effort_fact=effort_fact(requested,level,source))
            fields=dispatch.record_fields()
            cognitive=validate_cognitive_route({'schema':2,'model':'captured-parent-model <&>','effort':'medium',
                'source_role':'main','follows_role':'main','use_local_model':False,'credential_profile_id':'',
                'processing_preference':'standard','chosen_by':'inherited'})
            metadata={**fields,'delegation_role':'subagent','parent_task_id':'presentation-task','root_task_id':'presentation-task',
                'subagent_role':'helper','parent_cognitive_route':cognitive,'coordinator_route':'coordinator-model <&>',
                'coordinator_billing':'subscription' if mode=='pin' else 'measured','coordinator_provenance':'inherited',
                'use_local_model':mode=='pin'}
            write_task_result(data,'dispatch-child','completed',chat_id=1,result='Synthetic dispatch observation',metadata=metadata,
                **{key:metadata[key] for key in ('effort_level','effort_requested','effort_source','parent_cognitive_route')})
            progress=subagent_message_meta(metadata,task_id='dispatch-child',event='started')
            if mode=='capacity':
                from supervisor.events_subagent_admission import _subagent_scheduled_meta
                progress=_subagent_scheduled_meta(tid='dispatch-child',role='helper',task_constraint={},
                    task_group_id='fixture-capacity',requested_model_lane='heavy',active_subagent_count=3,max_active_subagents=2)
                # Prepared scheduler observations; no real worker pool is saturated here.
                progress.update(queued_behind_active_cap=True,worker_saturation_warning=True,
                    root_task_id='presentation-task',parent_task_id='presentation-task',delegation_role='subagent')
            if mode=='bare':
                ok,detail=message_bus._BRIDGE.send_message(1,'Dispatch facts bare',is_progress=True,
                    task_id='dispatch-child',role='assistant',progress_meta=progress)
                assert ok,detail
            else:
                receipt=message_bus.send_with_budget(1,'Dispatch facts '+mode,is_progress=True,task_id='dispatch-child',
                    role='system',system_type='subagent_dispatch',progress_meta=progress)
                assert receipt,receipt
        elif action=='release':gates[body['name']].set()
        elif action=='wire':wire.update(value=body.get('value'),fail=body.get('fail',False))
        elif action=='hold':release.clear()
        elif action=='release-all':
            mutation_gate.set();mutation_pause['name']='';lane.JOB_ANSWER_WAIT_SEC=mutation_answer_wait
            release.set()
            for gate in gates.values():gate.set()
        elif action=='rollover':
            for n in range(82):
                async def runner():return True
                await lane.run_lifecycle_job(kind='fixture-noop',target='retained-'+str(n),runner=runner,
                    options=lane.LifecycleJobOptions(drive_root=data))
        return JSONResponse({'ok':True,'queue':lane.queue_snapshot()})
    async def facts(request):return JSONResponse({'audit':audit,'queue':lane.queue_snapshot(),'frames':frames,
        'project':project,'peers':len(peers),'duplicate_runners':duplicate_runners,
        'mutation_files':{name:{'payload':(data/'skills/external'/name/'SKILL.md').exists(),'state':(data/'state/skills'/name).exists()} for name in mutation_names} if os.environ.get('NATIVE_SKILL_MUTATION_FIXTURE') else {},
        'neighbour':(data/'skills/external/neighbour.txt').read_text() if (data/'skills/external/neighbour.txt').exists() else None})
    async def ws(peer):
        await peer.accept();peers.add(peer)
        try:
            while True:
                frame=await peer.receive_json()
                if frame.get('type')=='ping':await peer.send_json({'type':'pong'})
        except Exception:pass
        finally:peers.discard(peer)
    @contextlib.asynccontextmanager
    async def lifespan(app):
        try:yield
        finally:
            release.set();mutation_gate.set()
            for gate in gates.values():gate.set()
            await asyncio.gather(*tasks,return_exceptions=True)
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),WebSocketRoute('/ws',ws),*collect_routes(data_dir=data)],lifespan=lifespan)
    app.state.drive_root=data;app.state.repo_dir=repo
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or not scope['path'].startswith('/api/'):return await app(scope,receive,send)
            record={'method':scope['method'],'path':scope['path']};audit.append(record);raw=bytearray()
            async def capture():
                message=await receive();raw.extend(message.get('body',b''))
                if not message.get('more_body') and raw:
                    try:record['body']=json.loads(raw)
                    except Exception:pass
                return message
            if scope['method']=='POST' and scope['path'].startswith('/api/skills/') and scope['path'].rsplit('/',1)[-1] in ('toggle','delete'):
                messages=[]
                async def mutation_output(message):messages.append(message)
                await app(scope,capture,mutation_output)
                reply=json.loads(b''.join(m.get('body',b'') for m in messages));record['actual']=copy.deepcopy(reply);record['status']=messages[0]['status']
                mode=mutation_wire['mode'];mutation_wire['mode']=''
                if record['status']<300:
                    if mode=='lost':return await JSONResponse({'error':'fixture reply lost after mutation'},status_code=503)(scope,receive,send)
                    if mode=='wire':return await JSONResponse(mutation_wire['reply'])(scope,receive,send)
                for message in messages:await send(message)
                return
            if scope['path']=='/api/skills/lifecycle-queue':
                messages=[]
                async def output(message):messages.append(message)
                await app(scope,capture,output);reply=json.loads(b''.join(m.get('body',b'') for m in messages))
                record['actual']=copy.deepcopy(reply);await release.wait()
                if wire['fail']:return await JSONResponse({'error':'Fixture lifecycle read failure'},status_code=503)(scope,receive,send)
                if wire['value'] is not None:reply=copy.deepcopy(wire['value'])
                return await JSONResponse(reply,status_code=messages[0]['status'])(scope,receive,send)
            await app(scope,capture,send)
    sock=socket.socket();sock.bind(('127.0.0.1',0));(run/'port').write_text(str(sock.getsockname()[1]));uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])
if __name__=='__main__':main()
