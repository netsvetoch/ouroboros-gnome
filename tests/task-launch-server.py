"""Actual task admission/staging/queue persistence; an inert worker slot never executes work."""
import asyncio
import base64
import copy
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
data, repo, workspace = run / "data", run / "repo", run / "workspace"
for directory in (data / "logs", data / "memory", repo, workspace):
    directory.mkdir(parents=True, exist_ok=True)
(data / "logs/chat.jsonl").write_text("")
(data / "logs/progress.jsonl").write_text("")
(workspace / "keep.txt").write_text("External workspace\n")
(run / "attachment.txt").write_text("Вложение GNOME 🔧\n<&>\n")

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

import uvicorn
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route, WebSocketRoute
from ouroboros.gateway.router import collect_routes
from ouroboros.gateway.tasks import api_tasks_create
from ouroboros.task_results import load_task_result
audit = []
i18n_audit = []
requests = []


async def create(request):
    body = await request.json()
    requests.append(copy.deepcopy(body))
    task_id = body.get("task_id")
    attempt = sum(row.get("task_id") == task_id for row in requests)
    if task_id in {"gtk-before", "gtk-abandon"} and attempt == 1:
        return JSONResponse({"error": "fixture response unavailable before admission"}, status_code=503)
    response = await api_tasks_create(request)
    if task_id == "gtk-after" and attempt == 1 and response.status_code == 200:
        return JSONResponse({"error": "fixture response unavailable after admission"}, status_code=503)
    return response


async def facts(request):
    ids = {row.get("task_id") for row in requests if row.get("task_id")}
    records = {key: load_task_result(data, key, strict=True) for key in ids}
    staged = {key: [base64.b64encode(pathlib.Path(row["abs_path"]).read_bytes()).decode()
                   for row in (record or {}).get("attachment_manifest", []) if row.get("status") == "staged"]
              for key, record in records.items()}
    return JSONResponse(json.loads(json.dumps({"workspace": str(workspace), "source": str(run / "attachment.txt"),
        "source_bytes": base64.b64encode((run / "attachment.txt").read_bytes()).decode(), "staged_bytes": staged,
        "missing": str(run / "missing.txt"), "requests": requests, "records": records,
        "pending": workers.PENDING, "snapshot": json.loads(queue.QUEUE_SNAPSHOT_PATH.read_text()) if queue.QUEUE_SNAPSHOT_PATH.exists() else None,
        "audit": audit, "i18n_audit": i18n_audit}, default=str)))


async def ws(peer):
    await peer.accept()
    from ouroboros.gateway import ws as gateway_ws
    gateway_ws.set_event_loop(asyncio.get_running_loop())
    connection=gateway_ws._register(peer)
    try:
        while True:
            frame=await peer.receive_json()
            if frame.get('type')=='ping':await peer.send_json({'type':'pong'})
    except Exception:pass
    finally:gateway_ws._unregister(connection)


routes = [route for route in collect_routes(data_dir=data) if getattr(route,"path","")!="/ws" and not (getattr(route, "path", "") == "/api/tasks" and "POST" in getattr(route, "methods", set()))]
app = Starlette(routes=[Route("/fixture/facts", facts), Route("/api/tasks", create, methods=["POST"]), WebSocketRoute("/ws",ws), *routes])
app.state.drive_root = data
app.state.repo_dir = repo


class Observe:
    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await app(scope, receive, send)
        if scope['path']=='/api/ui/i18n/missing':
            parts=bytearray()
            async def capture():
                message=await receive();parts.extend(message.get('body',b''));return message
            await app(scope,capture,send)
            i18n_audit.append(json.loads(parts));return
        record = {"method": scope["method"], "path": scope["path"]}
        if scope["path"] != "/fixture/facts":
            audit.append(record)
        async def output(message):
            if message["type"] == "http.response.start":
                record["status"] = message["status"]
            elif message["type"] == "http.response.body" and record.get("status", 200) >= 400:
                record["error"] = message.get("body", b"")[:4096].decode(errors="replace")
            await send(message)
        await app(scope, receive, output)


sock = socket.socket()
sock.bind(("127.0.0.1", 0))
(run / "port").write_text(str(sock.getsockname()[1]))
uvicorn.Server(uvicorn.Config(Observe(), log_level="warning")).run(sockets=[sock])
