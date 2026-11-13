def main():
    """Real interface-language/memory API with no generator or model execution."""
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
        "OUROBOROS_SUBAGENTS_MODE": "off", "TOTAL_BUDGET": 0, "OUROBOROS_RUNTIME_MODE":"light", "OUROBOROS_SAFETY_MODE":"full", "OUROBOROS_CONSCIOUSNESS_SAFETY_MODE":"full", "OUROBOROS_MODEL_SAFETY":"fixture/private-model", "OUROBOROS_SAFETY_OWNER_RULES":"Initial private rules e79", "OUROBOROS_CONTEXT_MODE":"max", "OUROBOROS_EFFORT_MIN":"low", "OUROBOROS_EFFORT_TASK":"medium", "OUROBOROS_EFFORT_MAX":"high"}))
    store_import.ensure_current_store(data)
    from ouroboros.usage_store import migrate_from_journal
    migrate_from_journal(data)
    from supervisor import queue, workers
    queue.init(data)
    queue.init_queue_refs(workers.PENDING, workers.RUNNING, workers.QUEUE_SEQ_COUNTER_REF)
    workers.WORKERS = {0: SimpleNamespace(busy_task_id=None, reaping=False)}
    workers._WORKER_POOL_DISABLED_REASON = ""

    from ouroboros import projects_registry
    projects_registry.create_project(data,"locale-project",name="Private project label k49")
    from ouroboros import i18n_memory as memory
    from supervisor import message_bus
    bridge=message_bus.LocalChatBridge();frames=[]
    bridge._broadcast_fn=frames.append
    message_bus.DATA_DIR,message_bus._BRIDGE=data,bridge
    def seed(doc):
        for key,text in {'Chat':'QAA Chat','Tasks':'QAA Tasks','Files':'QAA Files','Schedules':'QAA Schedules',
            'Activity':'QAA Activity','Widgets':'QAA Widgets','Send':'QAA Send','Save':'QAA Save',
            'Panel width':'QAA Width','Message…':'QAA Message…','Project panel width':'QAA Project width'}.items():
            memory.set_owner_entry(doc,key,{'text':text})
            if key in ('Chat','Send'):doc['entries'][key]['provenance']='imported'
        memory.set_owner_entry(doc,'{n} items',{'forms':{'one':'{n} single','few':'{n} several','other':'{n} others'}})
        return doc
    memory.update_memory(data,'qaa',seed,create=True)
    import asyncio
    import json
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route,WebSocketRoute
    from ouroboros.gateway.router import collect_routes
    (run/"chat-attachment.txt").write_text("Native chat attachment Ω\n<&>\n")
    (run/"empty-note.txt").write_bytes(b"")
    chat_hold={"value":None}
    from ouroboros.server_liveness import BOOT
    if '--command-receipts' in sys.argv:
        BOOT.serving();BOOT.steps_done();BOOT.dialogue_ready()
        skill=data/'skills/external/command-receipt-fixture'
        (skill/'scripts').mkdir(parents=True)
        (skill/'SKILL.md').write_text('---\nname: command-receipt-fixture\ndescription: Inert command receipt fixture.\nversion: 0.1.0\ntype: script\nruntime: python3\nscripts:\n  - name: run.py\n---\n# Inert fixture\n')
        (skill/'scripts/run.py').write_text("raise RuntimeError('fixture must never execute')\n")
    command_reply={'value':None}
    chat_frames=[]
    audit=[];hold={'value':None};extra={'value':None};fault={'value':''}
    async def facts(request):
        pending=memory.read_json_dict(memory.pending_path(data,'qaa')) or {}
        return JSONResponse({'audit':audit,'boot':BOOT.snapshot(jobs=False)['since'],'chat_frames':chat_frames,'chat_held':bool(chat_hold['value'] and chat_hold['value']['ready']),'chat_finished':bool(chat_hold['value'] and chat_hold['value']['finished']),'inbox':list(bridge._inbox.queue),'accepted':{frame['client_message_id']:message_bus.accepted_chat_message(data,frame.get('chat_id',1),frame['client_message_id']) for frame in chat_frames if frame.get('client_message_id')},'pending':pending,'held':bool(hold['value'] and hold['value']['ready']),'extra_held':bool(extra['value'] and extra['value']['ready'])})
    async def control(request):
        body=await request.json()
        if body['action']=='hold':hold['value']={'ready':False,'event':asyncio.Event(),'fail':body.get('fail',False),'path':body.get('path','/api/ui/i18n'),'method':body.get('method','GET')}
        elif body['action']=='hold-extra':extra['value']={'ready':False,'event':asyncio.Event(),'fail':body.get('fail',False),'path':body.get('path','/api/state'),'method':body.get('method','GET')}
        elif body['action']=='release-extra':
            if extra['value']:extra['value']['event'].set()
        elif body['action']=='hold-chat':chat_hold['value']={'ready':False,'finished':False,'event':asyncio.Event()}
        elif body['action']=='release-chat':
            if chat_hold['value']:chat_hold['value']['event'].set()
        elif body['action']=='repeat-chat-receipt':
            receipt=next(frame for frame in reversed(frames) if frame.get('type')=='chat' and frame.get('role')=='user' and frame.get('client_message_id')==body['client_message_id'] and frame.get('ingress_accepted'))
            frames.append(dict(receipt))  # replay the actual producer's receipt over the existing real socket
        elif body['action']=='close-chat':
            from ouroboros.gateway import ws as gateway_ws
            await gateway_ws.close_all_ws(code=1012,reason='fixture reconnect')
        elif body['action']=='fault':fault['value']=body.get('mode','')
        elif body['action']=='command-reply':command_reply['value']=body.get('reply')
        elif body['action']=='release':
            if hold['value']:hold['value']['event'].set()
        return JSONResponse({'ok':True})
    async def ws(peer):
        await peer.accept()
        from ouroboros.gateway import ws as gateway_ws
        gateway_ws.set_event_loop(asyncio.get_running_loop())
        connection=gateway_ws._register(peer)
        async def publish():
            index=0
            try:
                while True:
                    while index<len(frames):
                        await peer.send_json(frames[index]);index+=1
                    await asyncio.sleep(.025)
            except Exception:pass
        sender=asyncio.create_task(publish())
        try:
            while True:
                frame=await peer.receive_json()
                if frame.get('type')=='ping':await peer.send_json({'type':'pong'})
        except Exception:pass
        finally:
            gateway_ws._unregister(connection)
            sender.cancel()
            try:await sender
            except asyncio.CancelledError:pass
    async def real_chat(peer):
        held_connection=None
        from ouroboros.gateway import ws as gateway_ws
        gateway_ws.set_event_loop(asyncio.get_running_loop())
        class ObservedPeer:
            def __getattr__(self,key):return getattr(peer,key)
            async def receive_text(self):
                nonlocal held_connection
                raw=await peer.receive_text()
                frame=json.loads(raw)
                if frame.get('type')=='chat':
                    from ouroboros.composer_cognition import main_cognition
                    chat_frames.append(frame)
                    audit.append({'method':'WS','path':'/ws','body':frame,'context_mode':main_cognition().get('context_mode')})
                    gate=chat_hold['value']
                    if gate and not gate['ready']:
                        gate['ready']=True;held_connection=gate;await gate['event'].wait()
                return raw
        async def publish():
            index=0
            try:
                while True:
                    while index<len(frames):
                        await peer.send_json(frames[index]);index+=1
                    await asyncio.sleep(.025)
            except Exception:pass
        sender=asyncio.create_task(publish())
        try:await gateway_ws.ws_endpoint(ObservedPeer())
        finally:
            if held_connection:held_connection["finished"]=True
            sender.cancel()
            try:await sender
            except asyncio.CancelledError:pass

    routes=[route for route in collect_routes(data_dir=data) if getattr(route,'path','')!='/ws']
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),WebSocketRoute('/ws',real_chat if '--real-chat' in sys.argv else ws),*routes])
    app.state.drive_root=data;app.state.repo_dir=repo
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or not scope['path'].startswith('/api/'):
                return await app(scope,receive,send)
            parts=bytearray();record={'method':scope['method'],'path':scope['path']};audit.append(record)
            async def input():
                message=await receive();parts.extend(message.get('body',b''));return message
            messages=[]
            async def output(message):messages.append(message)
            await app(scope,input,output)
            if parts:
                try:record['body']=json.loads(parts)
                except (ValueError,UnicodeDecodeError):record['body_bytes']=len(parts)
            record['status']=messages[0]['status']
            if scope['path']=='/api/command' and scope['method']=='POST':
                record['reply']=json.loads(b''.join(m.get('body',b'') for m in messages))
                change=command_reply['value']
                if change and change.get('replay'):
                    messages.clear()
                    async def replay_input():return {'type':'http.request','body':bytes(parts),'more_body':False}
                    await app(scope,replay_input,output)
                    record['replayed_reply']=json.loads(b''.join(m.get('body',b'') for m in messages))
                elif change:
                    body=change.get('body')
                    if isinstance(body,dict) and body.get('task_id')=='$request':body={**body,'task_id':record['body'].get('visible_task_id')}
                    return await JSONResponse(body,status_code=change.get('status',200))(scope,receive,send)
            pending=next((item for item in (hold['value'],extra['value']) if item and not item['ready'] and scope['method']==item['method'] and scope['path']==item['path']),None)
            if pending and not pending['ready'] and scope['method']==pending['method'] and scope['path']==pending['path']:
                pending['ready']=True;await pending['event'].wait()
                if pending['fail']:
                    return await JSONResponse({'error':'fixture failed memory read'},status_code=503)(scope,receive,send)
            if scope['method']=='GET' and fault['value'].startswith('owner-'):
                mode=fault['value'];path=scope['path']
                body=json.loads(b''.join(m.get('body',b'') for m in messages))
                changed=False
                if path=='/api/projects' and mode=='owner-projects-http':
                    return await JSONResponse({'error':'synthetic project read failed'},status_code=503)(scope,receive,send)
                if path=='/api/settings' and mode.startswith('owner-settings-'):
                    changed=True
                    if mode.endswith('root'):body=[]
                    elif mode.endswith('missing'):body.pop('OUROBOROS_CONTEXT_MODE',None)
                    elif mode.endswith('text'):body['OUROBOROS_SAFETY_OWNER_RULES']=['bad']
                    elif mode.endswith('policy'):body['_meta']['policy_state']['access']['effective']={}
                elif path=='/api/projects' and mode.startswith('owner-projects-'):
                    changed=True
                    if mode.endswith('root'):body={'projects':{}}
                    elif mode.endswith('missing'):body={}
                    elif mode.endswith('id'):body['projects'][0]['id']=None
                    elif mode.endswith('duplicate'):body['projects'].append(dict(body['projects'][0]))
                    elif mode.endswith('cognition'):body['projects'][0]['cognition']={'context_mode':[]}
                    elif mode.endswith('effort'):body['projects'][0]['cognition']['effort_range']={'min':'low'}
                elif path=='/api/desktop/background' and mode=='owner-desktop':
                    changed=True;body={'state':['on']}
                if changed:return await JSONResponse(body)(scope,receive,send)
            if scope['method']=='GET' and scope['path']=='/api/ui/i18n' and fault['value']:
                mode=fault['value'];body=json.loads(b''.join(m.get('body',b'') for m in messages))
                body['revision']+=500
                body['entries']['Chat']={'text':'POISONED SNAPSHOT'}
                if mode=='entry':body['entries']['Send']={'text':[]}
                elif mode=='forms':body['entries']['{n} items']={'forms':{'other':5}}
                elif mode=='profile':body['profile']={'direction':[]}
                elif mode=='plural':body['plural_select']={'period':0,'map':{'1':'one'}}
                elif mode=='stats':body['stats']['pending']='bad'
                elif mode=='languages':body['languages']=[{'language':'qaa','label':[]}]
                elif mode=='generator':body['generator']['applied']=-1
                elif mode=='error':body['memory_error']='Synthetic memory not readable'
                return await JSONResponse(body)(scope,receive,send)
            for message in messages:await send(message)
    sock=socket.socket();sock.bind(('127.0.0.1',0));(run/'port').write_text(str(sock.getsockname()[1]))
    uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])

if __name__=='__main__':main()
