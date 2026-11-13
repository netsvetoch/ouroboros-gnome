def main():
    """Real preferences/history with deterministic unavailable/partial/delayed reads; no model execution."""
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

    from supervisor import state
    state.init(data,total_budget_limit=0)
    queue.publish_queue_snapshot(reason='chat_room_fixture')
    import asyncio, copy
    from ouroboros import dialogue_store, projects_registry
    from supervisor import message_bus, state
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route, WebSocketRoute
    from ouroboros.gateway.router import collect_routes
    bridge=message_bus.LocalChatBridge()
    message_bus.init(data,0,1000,bridge)
    peers=set(); frames=[]; jobs=[]; audit=[]; wire={'legacy':False}
    async def send(frame):
        for peer in list(peers):
            try: await peer.send_json(frame)
            except Exception: peers.discard(peer)
    def broadcast(frame):
        payload=copy.deepcopy(frame)
        if wire['legacy']:payload.pop('project_thread',None)
        frames.append(payload);jobs.append(asyncio.create_task(send(payload)))
    bridge._broadcast_fn=broadcast
    async def emit(request):
        body=await request.json();kind=body.get('kind','message');chat=body.get('chat_id',1);reply={'ok':True}
        wire['legacy']=body.get('legacy',False)
        try:
            if kind=='typing':bridge.send_chat_action(chat,action=body.get('action','start'),activity_id=body.get('activity_id','fixture-activity'))
            elif kind=='incoming':
                from supervisor.message_ingress import accept_local_message, record_inbound_message
                text=body['text'];cid=body['client_message_id'];uid=body.get('user_id',77)
                if body.get('source') == 'web':
                    bridge.handle_web_message(text,chat_id=chat,client_message_id=cid,sender_session_id='fixture-other-window')
                    bridge._inbox.get_nowait()  # Inert consumer: no worker execution.
                else:
                    saved, _ = accept_local_message(bridge,data,text,chat_id=chat,user_id=uid,
                        source=body.get('source','telegram'),sender_label=body.get('sender_label',''),client_message_id=cid)
                    message=bridge._inbox.get_nowait()
                    record_inbound_message(bridge,message,chat_id=chat,user_id=uid,client_message_id=cid,text=text,ts=saved['ts'])
            elif kind=='file-source':
                dialogue_store.append(data,'chat',dict(direction='in',chat_id=1,user_id=1,source='web',
                    text='Host attachment placeholder',text_placeholder=True,ts='2026-11-13T06:00:00Z',
                    client_message_id=body['client_message_id'],attachments=[{'name':body['filename'],'available':False}]),emit_live=False,feed=True)
            elif kind=='reply':
                from ouroboros.chat_references import reference_from_row, resolve_reply, projection_fields
                from supervisor.message_bus import log_chat
                if body.get('seed_task'):
                    from ouroboros.task_results import write_task_result
                    write_task_result(data,body['seed_task'],'completed',chat_id=chat,title='Work source',result='Retained fixture result')
                    log_chat('out',chat,0,'Work history anchor',task_id=body['seed_task'],drive_root=data,require_write=True)
                if body.get('source_id'):
                    source=next(found.row for found in dialogue_store.rows_by_client_id(data,body['source_id']))
                    address=reference_from_row(source)['address']
                else:address=body['address']
                reference=resolve_reply(data,address)
                stored=log_chat('out',chat,0,body['text'],drive_root=data,require_write=True,message_meta={'reply_to':reference})
                bridge.send_message(chat,stored['text'],ts=stored['ts'],progress_meta=projection_fields(stored))
                reply['reference']=reference
            elif kind=='relay':
                from ouroboros.owner_relay import owner_quote, write_relay, publish_relay
                from ouroboros.task_results import write_task_result
                quotes=[]
                for cid in body['sources']:
                    row=next(found.row for found in dialogue_store.rows_by_client_id(data,cid))
                    quotes.append(owner_quote(data,row))
                target='relay-receiver'
                write_task_result(data,target,'completed',chat_id=chat,title='Receiver work',result='Fixture retained work')
                entry,_=write_relay(data,target,relay_id=body.get('relay_id','fixture-relay'),note=body.get('note','Forwarded note'),
                    quotes=quotes,chat_id=1,teller_task_id='',summary='Fixture forwarding summary')
                publish_relay(data,target,entry,bridge)
                reply['relay']=entry['relay']
            elif kind=='document':
                original=message_bus.utc_now_iso;message_bus.utc_now_iso=lambda:body.get('ts','2026-11-13T05:00:00Z')
                try:bridge.send_document(chat,body.get('text','media').encode(),filename='shared-name.txt',caption=body.get('text','media'))
                finally:message_bus.utc_now_iso=original
            elif kind=='log':bridge.push_log(body.get('data',{}))
            else:
                text=body.get('text','message');ts=body.get('ts','2026-11-13T04:00:00Z');meta={}
                for key in ('initiator',):
                    if key in body:meta[key]=body[key]
                if 'also_rooms' in body:meta['also_rooms']=body['also_rooms']
                if body.get('task_id'):meta['task_id']=body['task_id']
                if body.get('system_type'):meta['type']=body['system_type']
                dialogue_store.append(data,'chat',dict(direction='out',chat_id=chat,user_id=1,text=text,ts=ts,**meta),emit_live=False,feed=True)
                meta.pop('type',None)
                bridge.send_message(chat,text,ts=ts,task_id=body.get('task_id',''),system_type=body.get('system_type',''),progress_meta=meta)
            if jobs:await asyncio.gather(*jobs);jobs.clear()
        finally:wire['legacy']=False
        return JSONResponse(reply)
    async def project(request):
        body=await request.json();row=projects_registry.create_project(data,body.get('id','room-project'),name='Real project room',working_dir=str(repo))
        from ouroboros.task_results import write_task_result
        write_task_result(data,'room-bound',status='completed',description='Retained fixture work',chat_id=row['chat_id'])
        projects_registry.bind_task_to_project(data,'room-bound',row['id'],origin={'absent':'post_hoc_unresolved'})
        return JSONResponse(row)
    async def facts(request):
        stored=dialogue_store.whole_rows(data,dialogue_store.newest(data,'chat',limit=100))
        return JSONResponse({'frames':frames,'audit':audit,'pending':workers.PENDING,'peers':len(peers),
            'stored':[{'chat_id':row.row.get('chat_id'),'text':row.row.get('text')} for row in stored]})
    async def ws(peer):
        await peer.accept();peers.add(peer)
        try:
            while True:
                frame=await peer.receive_json()
                if frame.get('type')=='ping':await peer.send_json({'type':'pong'})
        except Exception:pass
        finally:peers.discard(peer)
    routes=[route for route in collect_routes(data_dir=data) if getattr(route,'path','')!='/ws']
    app=Starlette(routes=[WebSocketRoute('/ws',ws),Route('/fixture/emit',emit,methods=['POST']),Route('/fixture/project',project,methods=['POST']),Route('/fixture/facts',facts),*routes])
    app.state.drive_root=data;app.state.repo_dir=repo
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']=='http' and scope['path'].startswith('/api/'):
                audit.append({'method':scope['method'],'path':scope['path'],'query':scope['query_string'].decode()})
            await app(scope,receive,send)
    sock=socket.socket();sock.bind(('127.0.0.1',0));(run/'port').write_text(str(sock.getsockname()[1]))
    uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])

if __name__=='__main__':main()
