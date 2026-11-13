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
        "OUROBOROS_SUBAGENTS_MODE": "off", "TOTAL_BUDGET": 0}))
    store_import.ensure_current_store(data)
    from ouroboros.usage_store import migrate_from_journal
    migrate_from_journal(data)
    from supervisor import queue, workers
    queue.init(data)
    queue.init_queue_refs(workers.PENDING, workers.RUNNING, workers.QUEUE_SEQ_COUNTER_REF)
    workers.WORKERS = {0: SimpleNamespace(busy_task_id=None, reaping=False)}
    workers._WORKER_POOL_DISABLED_REASON = ""

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
    audit=[];hold={'value':None};fault={'value':''}
    async def facts(request):
        pending=memory.read_json_dict(memory.pending_path(data,'qaa')) or {}
        return JSONResponse({'audit':audit,'pending':pending,'held':bool(hold['value'] and hold['value']['ready'])})
    async def control(request):
        body=await request.json()
        if body['action']=='hold':hold['value']={'ready':False,'event':asyncio.Event(),'fail':body.get('fail',False)}
        elif body['action']=='fault':fault['value']=body.get('mode','')
        elif body['action']=='release':hold['value']['event'].set()
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
    routes=[route for route in collect_routes(data_dir=data) if getattr(route,'path','')!='/ws']
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),WebSocketRoute('/ws',ws),*routes])
    app.state.drive_root=data;app.state.repo_dir=repo
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']!='http' or not scope['path'].startswith('/api/ui/i18n'):
                return await app(scope,receive,send)
            parts=bytearray();record={'method':scope['method'],'path':scope['path']};audit.append(record)
            async def input():
                message=await receive();parts.extend(message.get('body',b''));return message
            messages=[]
            async def output(message):messages.append(message)
            await app(scope,input,output)
            if parts:record['body']=json.loads(parts)
            record['status']=messages[0]['status']
            pending=hold['value']
            if scope['method']=='GET' and scope['path']=='/api/ui/i18n' and pending and not pending['ready']:
                pending['ready']=True;await pending['event'].wait()
                if pending['fail']:
                    return await JSONResponse({'error':'fixture failed memory read'},status_code=503)(scope,receive,send)
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
