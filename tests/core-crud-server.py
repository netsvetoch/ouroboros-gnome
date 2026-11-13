"""Run the actual upstream router against isolated storage; expose disk facts for assertions."""
import base64
import asyncio
import json
import os
import pathlib
import socket
import sys

import uvicorn
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route

from ouroboros.gateway.router import collect_routes
from ouroboros import projects_registry

run = pathlib.Path(sys.argv[1])
root = run / "data"
files = run / "files"
attached = run / "attached"
for path in (root / "logs", files, attached):
    path.mkdir(parents=True, exist_ok=True)
(root / "logs/chat.jsonl").write_text("")
(root / "logs/progress.jsonl").write_text("")
(files / "seed.txt").write_text("Seed\n")
(files / "replacement.txt").write_text("Intentional � character 🔧\n", encoding="utf-8")
(files / "damaged.txt").write_bytes(b"Invalid UTF-8: \xff\n")
(files / "unverified.txt").write_text("Unverified � text\n", encoding="utf-8")
(files / "racing.txt").write_text("Original � text\n", encoding="utf-8")
for name in ("loss-before.txt", "loss-after.txt", "copy-unknown.txt", "move-unknown.txt"):
    (files / name).write_text("Recovery source <&> 🔧\n", encoding="utf-8")
for name in ("copy-recovery", "move-recovery"):
    (files / name).mkdir()
(attached / "keep.txt").write_text("Owner folder remains\n")
os.environ["OUROBOROS_FILE_BROWSER_DEFAULT"] = str(files)
audit = []


async def facts(request):
    from supervisor.queue import load_schedule_store
    return JSONResponse({
        "attached": str(attached),
        "folder_kept": (attached / "keep.txt").read_text(),
        "files": {str(path.relative_to(files)): {"dir": path.is_dir(),
                    "bytes": base64.b64encode(path.read_bytes()).decode() if path.is_file() else None}
                  for path in files.rglob("*")},
        "projects": projects_registry.list_projects(root),
        "schedules": load_schedule_store(root), "audit": audit,
    })


from ouroboros.gateway.files import api_files_write, api_files_transfer
attempts = {}
async def change_with_loss(request):
    body = await request.json()
    route = request.url.path
    selected = body.get("path") if route.endswith("/write") else body.get("source_path")
    key = (route, selected)
    attempts[key] = attempts.get(key, 0) + 1
    if selected == "loss-before.txt" and attempts[key] == 1:
        return JSONResponse({"error": "fixture lost response before write"}, status_code=503)
    response = await (api_files_write(request) if route.endswith("/write") else api_files_transfer(request))
    if selected in {"loss-after.txt", "copy-unknown.txt", "move-unknown.txt"} and attempts[key] == 1 and response.status_code == 200:
        return JSONResponse({"error": "fixture lost response after committed change"}, status_code=503)
    return response
project_wire = {"mode": "", "hold": "", "read_fault": ""}
project_release = asyncio.Event(); project_release.set()
async def project_receipt_control(request):
    body = await request.json()
    if body.get("action") == "release": project_wire["hold"] = ""; project_release.set()
    if "hold" in body: project_wire["hold"] = body["hold"]; project_release.clear()
    for key in ("mode", "read_fault"):
        if key in body: project_wire[key] = body[key]
    return JSONResponse({"ok": True})
routes = [r for r in collect_routes(data_dir=root) if getattr(r, "path", "") not in {"/api/files/write", "/api/files/transfer"}]
app = Starlette(routes=[Route("/fixture/facts", facts), Route("/fixture/project-receipt", project_receipt_control, methods=["POST"]), Route("/api/files/write", change_with_loss, methods=["POST"]),
    Route("/api/files/transfer", change_with_loss, methods=["POST"]), *routes])
app.state.drive_root = root
app.state.repo_dir = run / "repo"
app.state.repo_dir.mkdir(exist_ok=True)


class Observe:
    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await app(scope, receive, send)
        record = {"method": scope["method"], "path": scope["path"],
                  "query": scope.get("query_string", b"").decode()}
        if scope["path"] != "/fixture/facts":
            audit.append(record)
        requested = bytearray()
        async def input():
            message = await receive()
            if scope["path"] in {"/api/files/write", "/api/files/transfer"}:
                requested.extend(message.get("body", b""))
            return message
        async def output(message):
            if message["type"] == "http.response.start":
                record["status"] = message["status"]
            elif message["type"] == "http.response.body" and record.get("status", 200) >= 400:
                record["error"] = message.get("body", b"")[:8192].decode(errors="replace")
            await send(message)
        from urllib.parse import parse_qs
        selected = parse_qs(scope.get("query_string", b"").decode()).get("path", [""])[0]
        if scope["path"] == "/api/files/content" and selected == "unverified.txt":
            return await JSONResponse({"error": "fixture byte read unavailable"}, status_code=503)(scope, receive, output)
        if scope["path"] == "/api/files/content" and selected == "racing.txt":
            (files / "racing.txt").write_text("Replaced � text\n", encoding="utf-8")
        if '--project-receipts' in sys.argv and (scope['path'].endswith('/update') and scope['path'].startswith('/api/projects/') or scope['path']=='/api/projects' and scope['method']=='GET'):
            write=scope['method']=='POST'
            mode=project_wire['mode'] if write else project_wire['read_fault']
            if write: project_wire['mode']=''
            captured=[]
            async def capture(message): captured.append(message)
            if write and mode in ('refuse','before'):
                return await JSONResponse({'error':'Controlled refusal before mutation'},status_code=400 if mode=='refuse' else 503)(scope,receive,output)
            await app(scope,input,capture)
            raw=b''.join(m.get('body',b'') for m in captured); body=json.loads(raw)
            if write:
                if mode=='after': captured=[]; body={'error':'Controlled lost update reply'}
                elif mode=='missing': body={}
                elif mode=='flat': body={'chat_id':body['project']['chat_id']}
                elif mode=='foreign': body={'project':projects_registry.get_project(root,'receipt-foreign')}
                elif mode=='binding': body['project']['chat_id']+=1
                elif mode=='name': body['project']['name']='Another saved name'
                elif mode=='pinned': body['project']['pinned']=not body['project']['pinned']
                elif mode=='closed': body['project']['closed']={}
                if mode=='after': captured=[{'status':503}]
            elif mode=='binding' and body.get('projects'): body['projects'][0]['chat_id']+=1
            if project_wire['hold']==('write' if write else 'read') and (write or b'id=' in scope.get('query_string',b'')):
                record['held']=True; await project_release.wait(); record['released']=True
            if write and mode=='json':
                from starlette.responses import Response
                return await Response('{broken',media_type='application/json')(scope,receive,output)
            return await JSONResponse(body,status_code=captured[0].get('status',200) if captured else 200)(scope,receive,output)
        await app(scope, input, output)
        if requested:
            record["body"] = json.loads(requested)


sock = socket.socket()
sock.bind(("127.0.0.1", 0))
(run / "port").write_text(str(sock.getsockname()[1]))
uvicorn.Server(uvicorn.Config(Observe(), log_level="warning")).run(sockets=[sock])
