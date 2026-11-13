def main():
    """Real routing decisions and supervisor admission with inert workers."""
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
    config.initialize_runtime_mode_baseline("cyber_pro")
    config.SETTINGS_PATH.write_text(json.dumps({"OUROBOROS_SUBAGENTS": '{"enabled":false,"items":[]}',
        "OUROBOROS_SUBAGENTS_MODE": "off", "TOTAL_BUDGET": 100}))
    store_import.ensure_current_store(data)
    from ouroboros.usage_store import migrate_from_journal
    migrate_from_journal(data)
    from supervisor import queue, workers
    queue.init(data)
    queue.init_queue_refs(workers.PENDING, workers.RUNNING, workers.QUEUE_SEQ_COUNTER_REF)
    workers.WORKERS = {0: SimpleNamespace(busy_task_id=None, reaping=False)}
    workers._WORKER_POOL_DISABLED_REASON = ""

    from supervisor import state
    state.init(data, total_budget_limit=100)
    queue.publish_queue_snapshot(reason='routing_picker_fixture')
    import asyncio
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route, WebSocketRoute
    from ouroboros.gateway.router import collect_routes
    from ouroboros.gateway.history import make_chat_history_endpoint
    from ouroboros import dialogue_store as ds
    from ouroboros.project_dialogue import latest_chat_annotations, append_chat_annotation
    from ouroboros.projects_registry import create_project
    from ouroboros.task_results import load_task_result, write_task_result
    from ouroboros.owner_mailbox import _mailbox_path
    from supervisor import message_bus, events
    from supervisor.events_project_routing import _emit_routing_receipt
    workspace=run/'workspace';workspace.mkdir()
    project=create_project(data,'picker-project',name='Picker project <&> Ω',working_dir=str(workspace))
    journal_mode='--journal' in sys.argv
    i18n_mode='--i18n' in sys.argv
    replay_mode='--replay' in sys.argv or journal_mode or i18n_mode
    protocol_mode='--protocol' in sys.argv
    frames=[];dispatches=[];notices=[];audit=[];delayed=[];fault={'loss':False,'defer_next':False,'history':'','receipt':'','history_hold':False,'history_held':False}
    history_release=asyncio.Event();history_release.set()
    fault['history_target']='translated' if i18n_mode else 'source'
    message_bus.DATA_DIR=data
    message_bus.publish_event=lambda *_a,**_k:None
    bridge=message_bus.LocalChatBridge({});bridge._broadcast_fn=frames.append
    ctx=SimpleNamespace(DRIVE_ROOT=data,WORKERS=workers.WORKERS,RUNNING=workers.RUNNING,PENDING=workers.PENDING,
        bridge=bridge,enqueue_task=queue.enqueue_task,persist_queue_snapshot=queue.persist_queue_snapshot,
        load_state=lambda:{'owner_chat_id':1},append_jsonl=lambda *_a,**_k:None)
    def handle(evt):
        if evt['type']=='steer_task':events._handle_steer_task(evt,ctx)
        else:events._handle_promote_chat_to_task(evt,ctx)
    def dispatch(evt):
        if evt['type']=='send_message':
            notices.append(dict(evt));return
        assert evt['type'] in ['promote_chat_to_task','steer_task'],evt
        dispatches.append(dict(evt))
        if fault['defer_next']:
            fault['defer_next']=False;delayed.append(dict(evt));return
        handle(evt)
    workers.get_event_q=lambda **_kwargs:SimpleNamespace(put_nowait=dispatch,put=dispatch)
    options=[{'action':'new_task_in_project','project_id':'picker-project','label':'New in Picker <&> Ω'}]
    live='live-native-root'
    if replay_mode:
        workers.PENDING.append({'id':live,'type':'task','chat_id':1,'root_task_id':live,'reasoning_effort':'low'})
        write_task_result(data,live,'scheduled',chat_id=1,reasoning_effort='low',root_task_id=live,title='Existing native work <&>')
        from ouroboros import routing_wait
        real_steer_wait=routing_wait.wait_for_routing_annotation
        real_promote_wait=routing_wait.wait_for_promotion_admission
        routing_wait.wait_for_routing_annotation=lambda *args,**kwargs:real_steer_wait(*args,**{**kwargs,'timeout_sec':.05})
        routing_wait.wait_for_promotion_admission=lambda *args,**kwargs:real_promote_wait(*args,**{**kwargs,'timeout_sec':.05})
    origins={}
    receipt_faults=['ok','state','index','fraction','dispatch','missing-dispatch','task','effort','cause','decision','legacy']
    names=['translated','private'] if i18n_mode else ['failure','steer-replay','promote-replay','superseded'] if journal_mode else ['source',*receipt_faults] if protocol_mode else ['steer','steer-replay','promote-replay'] if replay_mode else ['normal','lost','changed']
    for name in names:
        cmid='native-picker:'+name;token='token-'+name;text='  Original '+name+' words <&> Ω\nkeep trailing  \n'
        chat=project['chat_id'] if journal_mode and name=='promote-replay' else 1
        origins[name]={'id':cmid,'token':token,'text':text,'chat':chat}
        ds.append(data,'chat',{'direction':'in','client_message_id':cmid,'text':text,'chat_id':chat,'ts':f'2026-11-13T01:00:{len(origins):02d}+00:00'})
        choices=[{'action':'steer_task','task_id':live,'label':'Existing native work <&>'}] if name.startswith('steer') else options
        if i18n_mode:
            choices=[{'action':'new_task_in_project','project_id':'picker-project',**({'label':'private-option-label-793 <&> Ω'} if name=='private' else {})}]
        _emit_routing_receipt(ctx,{'type':'routing_manual_target','client_message_id':cmid,'routing_token':token,'chat_id':chat},
            action='route_decision',status='needs_manual_target',reason='target_unspecified',options=choices,reasoning_effort='high')
        if i18n_mode and name=='private':
            fields={'action':'route_decision','status':'needs_manual_target','routing_token':token,'options':choices,
                'cause':'private-host-cause-831 <&> Ω','attachment_manifest':[{'status':'rejected','ordinal':0,'label':'private-file-name-527.txt'}]}
            append_chat_annotation(data,cmid,**fields)
            bridge.send_routing_ack(chat,client_message_id=cmid,**fields)
    async def facts(request):
        mailbox=_mailbox_path(data,live)
        return JSONResponse({'origins':origins,'frames':frames,'dispatches':dispatches,'notices':notices,'audit':audit,'project':project,
            'delayed_count':len(delayed),'history_held':fault['history_held'],'mail':[json.loads(line) for line in mailbox.read_text().splitlines() if line] if mailbox.exists() else [],
            'annotations':latest_chat_annotations(data),'pending':list(workers.PENDING),
            'records':{item['id']:load_task_result(data,item['id']) for item in workers.PENDING}})
    def corrupt(annotation, mode):
        if mode=='status':annotation['status']=[]
        elif mode=='cause':annotation['cause']={'poison':'not text'}
        elif mode=='action':annotation['action']=[]
        elif mode=='targets':annotation['target_task_ids']={}
        elif mode=='titles':annotation['target_titles']=[{}]
        elif mode=='options':annotation['options']=[None]
        elif mode=='option-label':annotation['options']=[{'action':'new_task_in_project','project_id':'picker-project','label':{}}]
        elif mode=='manifest':annotation['attachment_manifest']=[None]
        elif mode=='ordinal':annotation['attachment_manifest']=[{'status':'rejected','ordinal':-1}]
        elif mode=='chat':annotation['project_chat_id']=2**53
        elif mode=='effort':annotation['reasoning_effort']=[]
        elif mode=='rooms':annotation['also_rooms']=[1,{}]
        elif mode=='future':annotation['future_host_fact']={'preserve':True}
        return annotation
    async def control(request):
        body=await request.json()
        if body.get('action')=='lose-next':fault['loss']=True
        if body.get('action')=='defer-next':fault['defer_next']=True
        if body.get('action')=='release-events':
            for evt in list(delayed):handle(evt)
            delayed.clear()
        if body.get('action')=='history-fault':
            fault['history']=body.get('mode','');fault['history_hold']=body.get('hold',False);fault['history_held']=False
            if fault['history_hold']:history_release.clear()
            else:history_release.set()
        if body.get('action')=='release-history':fault['history_hold']=False;history_release.set()
        if body.get('action')=='receipt-fault':fault['receipt']=body.get('mode','')
        if body.get('action')=='frame-fault':
            frame=next(item for item in frames if item.get('client_message_id')==origins['source']['id'])
            frames.append(corrupt(json.loads(json.dumps(frame)),body['mode']))
        if body.get('action')=='supersede':
            origin=origins[body.get('name','changed')];append_chat_annotation(data,origin['id'],action='route_decision',status='needs_manual_target',routing_token='new-token',options=options)
        return JSONResponse({'ok':True})
    async def ws(peer):
        await peer.accept();index=0;connection=None
        if i18n_mode:
            from ouroboros.gateway import ws as gateway_ws
            gateway_ws.set_event_loop(asyncio.get_running_loop());connection=gateway_ws._register(peer)
        async def publish():
            nonlocal index
            while True:
                while index<len(frames):
                    await peer.send_json(frames[index]);index+=1
                await asyncio.sleep(.02)
        sender=asyncio.create_task(publish())
        try:
            while True:await peer.receive_json()
        except Exception:pass
        finally:
            if connection is not None:gateway_ws._unregister(connection)
            sender.cancel()
            try:await sender
            except (asyncio.CancelledError,Exception):pass
    routes=[r for r in collect_routes(data_dir=data) if getattr(r,'path','') not in ['/ws','/api/chat/history']]
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),
        Route('/api/chat/history',make_chat_history_endpoint(data)),WebSocketRoute('/ws',ws),*routes])
    app.state.drive_root=data;app.state.repo_dir=repo
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or not scope['path'].startswith('/api/'):return await app(scope,receive,send)
            messages=[];raw=bytearray();record={'method':scope['method'],'path':scope['path']}
            async def input():
                message=await receive();raw.extend(message.get('body',b''));return message
            async def output(message):messages.append(message)
            await app(scope,input,output)
            if raw:record['body']=json.loads(raw)
            record['status']=messages[0]['status']
            try:record['reply']=json.loads(b''.join(m.get('body',b'') for m in messages))
            except Exception:pass
            audit.append(record)
            if scope['path']=='/api/chat/history' and fault['history']:
                body=json.loads(json.dumps(record['reply']))
                for row in body.get('messages',[]):
                    if row.get('client_message_id')==origins[fault['history_target']]['id']:corrupt(row['chat_annotation'],fault['history'])
                if fault['history_hold']:
                    fault['history_held']=True;await history_release.wait();fault['history_held']=False
                return await JSONResponse(body)(scope,receive,send)
            if scope['path']=='/api/decisions' and fault['receipt']:
                mode=fault['receipt'];fault['receipt']='';body=json.loads(json.dumps(record['reply']))
                assert record['status']==200,(mode,record)
                if mode=='ok':body['ok']='true'
                elif mode=='state':body['state']=[]
                elif mode=='index':body['answered_index']=1
                elif mode=='fraction':body['answered_index']=.5
                elif mode=='dispatch':body['dispatched']='delivered'
                elif mode=='missing-dispatch':body.pop('dispatched',None)
                elif mode=='task':body['task_id']='active'
                elif mode=='effort':body['reasoning_effort']='low'
                elif mode=='cause':body['cause']={}
                elif mode=='decision':body['decision_id']='routing:another:token'
                elif mode=='legacy':
                    for key in ['answered_index','task_id','reasoning_effort']:body.pop(key,None)
                    body['future_host_fact']={'preserve':True}
                return await JSONResponse(body)(scope,receive,send)
            if scope['path']=='/api/decisions' and fault['loss']:
                fault['loss']=False
                return await JSONResponse({'error':'Fixture lost decision reply'},status_code=503)(scope,receive,send)
            for message in messages:await send(message)
    sock=socket.socket();sock.bind(('127.0.0.1',0));(run/'port').write_text(str(sock.getsockname()[1]))
    uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])

if __name__=='__main__':main()
