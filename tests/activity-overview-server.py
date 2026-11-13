def main():
    """Real health/state publication/queue/consciousness APIs with controlled clock and wire faults."""
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

    import asyncio,copy,threading
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    from ouroboros.gateway.state import api_state,api_health,api_consciousness
    from ouroboros.gateway.tasks import api_tasks_list
    from ouroboros.gateway.control import api_command
    from ouroboros.gateway.ui_i18n import api_ui_i18n_get,api_ui_i18n_language_post,api_ui_i18n_import_post,api_ui_i18n_missing_post
    from ouroboros.gateway.settings import api_settings_get
    from ouroboros.server_liveness import BOOT
    from ouroboros.consciousness_view import describe_consciousness_state
    from supervisor import state as supervisor_state,message_bus
    supervisor_state.init(data);supervisor_state.init_state()
    workers.PENDING.append({'id':'overview-queued','type':'task','text':'Queued work <&>','chat_id':1})
    queue.publish_queue_snapshot(reason='overview_fixture')
    clock={'live_wake_task_id':'wake-main','spent_24h_usd':.25,'daily_usd':2,'spend_by_cause':[{'cause':'self','label':'Own wake <&>','usd':.25}], 'recent_wakes':[{'task_id':'wake-main','chat_id':1,'cause':'self','phase':'working','summary':'Wake summary <&>','live':True}],'recent_wakes_coverage':'fixture-clock'}
    roster={'enabled':True,'items':[
        {'subagent_id':'api','enabled':True,'route':{'kind':'api_model','target_id':'openai::fixture-review'},'effort':'high','delivery':'native','rechecks_flags':True},
        {'subagent_id':'session','enabled':True,'route':{'kind':'agent_session','target_id':'codex=fixture-model','credential_profile_id':'fixture-profile'},'access':'readonly','processing_preference':'adaptive'},
        {'subagent_id':'off','enabled':False,'route':{'kind':'api_model','target_id':'openai::disabled'}}]}
    seed=json.loads(config.SETTINGS_PATH.read_text());seed.update(OUROBOROS_SUBAGENTS=json.dumps(roster),OUROBOROS_PROCESSING_PREFERENCE='auto');config.SETTINGS_PATH.write_text(json.dumps(seed))
    audit=[];commands=[];fault={};inline_wire={};boot_wire={};inline_notices=[];release=asyncio.Event();release.set();settings_release=asyncio.Event();settings_release.set();initial=config.SETTINGS_PATH.read_bytes();inline_baseline=[initial]
    class Bridge:
        def ui_send(self,cmd,**kwargs):commands.append(cmd)
    message_bus.get_bridge=lambda:Bridge()
    async def facts(request):return JSONResponse({'audit':audit,'commands':commands,'settings_unchanged':config.SETTINGS_PATH.read_bytes()==initial,'non_language_settings_unchanged':{k:v for k,v in json.loads(config.SETTINGS_PATH.read_text()).items() if k!='OUROBOROS_UI_LANGUAGE'}=={k:v for k,v in json.loads(inline_baseline[0]).items() if k!='OUROBOROS_UI_LANGUAGE'},'roster':roster,'boot':BOOT.snapshot(jobs=False)['since']})
    async def control(request):
        body=await request.json()
        if body['action']=='boot-wire':boot_wire.clear();boot_wire.update(body.get('wire',{}))
        if body['action']=='boot':
            from ouroboros import maintenance_jobs
            from ouroboros.utils import utc_now_iso
            mode=body['mode']
            if mode in ('start','reset'):
                BOOT.reset();request.app.state.supervisor_ready_event.clear();request.app.state.supervisor_init_done_event.clear()
            if mode=='start':
                BOOT.serving();BOOT.dialogue_ready();BOOT.step_started('prepare-store')
                maintenance_jobs.record(data,'fixture_job',state='running',done=3,total=10)
            elif mode=='step-failed':
                BOOT.step_ended('prepare-store',error=body.get('error','Optional step failed'));BOOT.step_started('load-extensions')
            elif mode=='finish':
                BOOT.step_ended('load-extensions');BOOT.steps_done();request.app.state.supervisor_ready_event.set();request.app.state.supervisor_init_done_event.set()
                BOOT.note_supervisor_load({'ts':utc_now_iso(),'max_event_lag_sec':0.25})
                maintenance_jobs.record(data,'fixture_job',state='done',done=10,total=10)
            elif mode=='fatal':BOOT.fail(body.get('error','Fatal fixture startup error'))
            request.app.state.state_publication=None
            await api_state(request)
        if body['action']=='inline-baseline':inline_baseline[0]=config.SETTINGS_PATH.read_bytes()
        if body['action']=='inline-wire':inline_wire.clear();inline_wire.update(body.get('wire',{}))
        if body['action']=='inline':
            from supervisor import inline_carrier
            workers.DRIVE_ROOT=data
            if body.get('mode') in ('seed','clear'):
                with inline_carrier._INLINE_LOCK:
                    inline_carrier._INLINE.clear();inline_carrier._DEGRADED_TOTAL[0]=0
            for wid in (-100,-101):workers.WORKERS.pop(wid,None)
            if body.get('mode')=='seed':
                original=workers.send_with_budget
                workers.send_with_budget=lambda *args,**kw:inline_notices.append(args)
                try:
                    inline_carrier._disclose({'id':'inline-call','chat_id':1},'inline_call','process-local call port')
                    inline_carrier._disclose({'id':'inline-fallback','chat_id':1},'inline_degraded',body.get('reason','carrier_spawn_refused:OSError'))
                finally:workers.send_with_budget=original
                for wid,task_id,executor in [(-100,'inline-call','inline_call'),(-101,'inline-fallback','inline_degraded')]:
                    workers.WORKERS[wid]=SimpleNamespace(wid=wid,busy_task_id=task_id,executor=executor,reaping=False,lane='conversation')
        if body['action']=='hold':release.clear()
        elif body['action']=='release-all':release.set();settings_release.set()
        elif body['action']=='hold-settings':settings_release.clear()
        elif body['action']=='settings-patch':config.SETTINGS_PATH.write_text(json.dumps({**seed,**body['values']}))
        elif body['action']=='reset-settings':config.SETTINGS_PATH.write_bytes(initial)
        elif body['action']=='fault':fault.clear();fault.update(body.get('values',{}))
        return JSONResponse({'ok':True})
    app=Starlette(routes=[Route('/api/ui/i18n',api_ui_i18n_get),Route('/api/ui/i18n/language',api_ui_i18n_language_post,methods=['POST']),Route('/api/ui/i18n/import',api_ui_i18n_import_post,methods=['POST']),Route('/api/ui/i18n/missing',api_ui_i18n_missing_post,methods=['POST']),Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),Route('/api/state',api_state),Route('/api/health',api_health),Route('/api/tasks',api_tasks_list),Route('/api/consciousness',api_consciousness),Route('/api/command',api_command,methods=['POST']),Route('/api/settings',api_settings_get)]);app.state.drive_root=data;app.state.repo_dir=repo;app.state.supervisor_ready_event=threading.Event();app.state.supervisor_ready_event.set();app.state.supervisor_init_done_event=threading.Event();app.state.describe_consciousness=lambda:describe_consciousness_state(clock,True)
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or not scope['path'].startswith('/api/'):return await app(scope,receive,send)
            record={'method':scope['method'],'path':scope['path'],'query':scope.get('query_string',b'').decode(),'authenticated':any(k==b'authorization' for k,v in scope.get('headers',[]))};audit.append(record);messages=[]
            async def output(message):messages.append(message)
            await app(scope,receive,output);body=json.loads(b''.join(m.get('body',b'') for m in messages));record['reply']=copy.deepcopy(body);record['status']=messages[0]['status']
            await release.wait()
            if scope['path']=='/api/settings':await settings_release.wait()
            mode=fault.get(scope['path'],'')
            if mode=='fail':return await JSONResponse({'error':'Fixture section unavailable'},status_code=503)(scope,receive,send)
            if mode=='malformed':
                if scope['path']=='/api/state':body['state_quality']={'unconfirmed':'not-an-array'}
                elif scope['path']=='/api/tasks':body['queue']['pending']=[None]
                elif scope['path']=='/api/consciousness':body['spend_by_cause']=[None]
                elif scope['path']=='/api/health':body['boot']='invalid'
            if scope['path']=='/api/health' and inline_wire:
                if inline_wire.get('omit'):body.pop('inline_executors',None)
                elif 'value' in inline_wire:body['inline_executors']=inline_wire['value']
            if scope['path']=='/api/health' and boot_wire:
                if boot_wire.get('omit'):body.pop('boot',None)
                elif 'value' in boot_wire:body['boot']=boot_wire['value']
            await JSONResponse(body,status_code=record['status'])(scope,receive,send)
    sock=socket.socket();sock.bind(('127.0.0.1',0));(run/'port').write_text(str(sock.getsockname()[1]));uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])

if __name__=='__main__':main()
