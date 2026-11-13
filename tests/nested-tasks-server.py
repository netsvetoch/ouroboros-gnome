def main():
    """Real nested-task lineage and history/preferences; no worker execution."""
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

    queue.publish_queue_snapshot(reason='nested_fixture')
    from ouroboros import dialogue_store
    from ouroboros.task_results import write_task_result
    for task,parent in [('root',''),('child','root'),('grandchild','child')]:
        write_task_result(data,task,'running',chat_id=1,root_task_id='root',parent_task_id=parent)
    for index,(task,parent,text) in enumerate([('root','','Корневая работа'),('child','root','Ответ помощника один'),
        ('grandchild','child','Ответ вложенного помощника'),('child','root','Ответ помощника два')]):
        dialogue_store.append(data,'chat',dict(direction='out',chat_id=1,user_id=1,task_id=task,parent_task_id=parent,
            text=text,ts=f'2026-11-12T00:00:0{index}Z'),emit_live=False,feed=True)
    import uvicorn
    from starlette.applications import Starlette
    from starlette.routing import WebSocketRoute
    from ouroboros.gateway.router import collect_routes
    async def ws(peer):
        await peer.accept()
        try:
            while True:
                frame=await peer.receive_json()
                if frame.get('type')=='ping':await peer.send_json({'type':'pong'})
        except Exception:pass
    routes=[route for route in collect_routes(data_dir=data) if getattr(route,'path','')!='/ws']
    app=Starlette(routes=[WebSocketRoute('/ws',ws),*routes])
    app.state.drive_root=data
    app.state.repo_dir=repo
    sock=socket.socket();sock.bind(('127.0.0.1',0));(run/'port').write_text(str(sock.getsockname()[1]))
    uvicorn.Server(uvicorn.Config(app,log_level='warning')).run(sockets=[sock])

if __name__=='__main__':main()
