def main():
    """Real place room index/history with retained arrivals; no connector/model runs."""
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

    import asyncio, copy
    from dataclasses import replace
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    from ouroboros import places
    from ouroboros.gateway import places_api
    from ouroboros.gateway.history import make_chat_history_endpoint
    from ouroboros.presence_admission import admit_presence_turn
    from ouroboros.presence_runner import PresenceTurnEvent,capture_presence_event
    from ouroboros.place_intake import settle_heard
    from ouroboros.presence_delivery import PresenceDeliveryRecorder
    from ouroboros.presence_bindings import conversation_key
    import ouroboros.place_projection as projection
    projection.place_declarations=lambda root:[]
    place=places.connect_place(data,connector='fixture-bridge',provider='chat',account_id='qa',label='Fixture account')
    admission=admit_presence_turn(drive_root=data,authenticated_transport_skill='fixture-bridge',provider='chat',account_id='qa',conversation_id='design')
    event=PresenceTurnEvent('history-0','chat','qa','design','',conversation_key('chat','qa','design',''),{'platform_actor_id':'maya','display_name':'Maya <&>'},{'title':'Design <&>'},{},'Arrival 000',facts=('mention',))
    for i in range(315):
        incoming=replace(event,source_event_id=f'history-{i}',text=f'Arrival {i:03d}' if i<314 else 'Arrival 314 · **plain input**')
        task=capture_presence_event(admission,incoming,drive_root=data);settle_heard(data,task,incoming,'paused' if i==314 else 'no_wake_match')
    recorder=PresenceDeliveryRecorder(data)
    for status in ('accepted','delivered','failed','uncertain'):
        recorder.record('fixture-bridge',{'schema_version':1,'delivery_id':'history-'+status,'part_id':'0','state':status,'provider':'chat','account_id':'qa','conversation_id':'design','thread_id':'','text':'# Room headline\n\n**Reply delivered** & retained text' if status=='delivered' else 'Reply '+status,'format':'markdown','message':{},'origin':{'kind':'tool'}})
    audit=[];release=asyncio.Event();release.set();fault={'history':'','rooms':''};initial=config.SETTINGS_PATH.read_bytes()
    async def facts(request):return JSONResponse({'place':place.place_id,'chat':task['chat_id'],'audit':audit,'settings_unchanged':config.SETTINGS_PATH.read_bytes()==initial})
    async def control(request):
        body=await request.json()
        if body['action']=='hold':release.clear()
        elif body['action']=='release-all':release.set()
        elif body['action']=='fault':fault.update(body['values'])
        return JSONResponse({'ok':True})
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),*places_api.places_routes(),Route('/api/chat/history',make_chat_history_endpoint(data))]);app.state.drive_root=data;app.state.repo_dir=repo
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or not scope['path'].startswith('/api/'):return await app(scope,receive,send)
            record={'method':scope['method'],'path':scope['path'],'query':scope.get('query_string',b'').decode()};audit.append(record);messages=[]
            async def output(message):messages.append(message)
            mode=fault['history'] if scope['path'].endswith('/history') else fault['rooms']
            if mode=='moved' and b'cursor=' in scope.get('query_string',b''):
                fault['history']='';record['status']=409
                return await JSONResponse({'error':'Fixture view changed','reason_code':'history_view_changed'},status_code=409)(scope,receive,send)
            await app(scope,receive,output);body=json.loads(b''.join(m.get('body',b'') for m in messages));record['reply']=copy.deepcopy(body);record['status']=messages[0]['status']
            await release.wait()
            if mode=='fail':return await JSONResponse({'error':'Fixture read unavailable'},status_code=503)(scope,receive,send)
            if mode=='malformed':
                if 'messages' in body:body['coverage']={'spans':{'chat':None}}
                else:body['rooms'].append(None)
            if mode in ('row-field','page-field'):
                target=body['messages'][0] if mode=='row-field' else body
                path=fault['field']
                for part in path[:-1]:
                    if not isinstance(target.get(part),dict):target[part]={}
                    target=target[part]
                target[path[-1]]=fault['value']
            if mode=='cycle':body.update(has_more=True,next_cursor=next(r['reply']['page_cursor'] for r in audit if r['path'].endswith('/history') and r.get('reply',{}).get('page_cursor')))
            if mode=='gap':body['window']={'complete':False,'truncated_by':['chat_importing']}
            await JSONResponse(body,status_code=record['status'])(scope,receive,send)
    sock=socket.socket();sock.bind(('127.0.0.1',0));(run/'port').write_text(str(sock.getsockname()[1]));uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])

if __name__=='__main__':main()
