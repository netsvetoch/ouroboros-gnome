"""Exercise the pinned gateway's actual password gate over HTTP and WebSocket.

Only the configured password and remote client's address are fixture inputs;
login, cookie signing/validation, logout and the browser boundary are upstream.
"""
import asyncio
import json
import pathlib
import socket
import sys

import uvicorn
from starlette.applications import Starlette
from starlette.responses import JSONResponse, RedirectResponse
from starlette.routing import Route, WebSocketRoute

import ouroboros.server_auth as auth

run = pathlib.Path(sys.argv[1])
state = {"password": "fixture-secret", "audit": [], "health_mode": "", "state_mode": ""}
release = asyncio.Event()
release.set()
login_release = asyncio.Event()
login_release.set()
auth.get_configured_network_password = lambda: state["password"]


def credentials(headers):
    return {"bearer": bool(headers.get("authorization")),
            "cookie": "ouroboros_auth=" in headers.get("cookie", "")}


async def health(request):
    await release.wait()
    if state['health_mode']=='bad-boot':return JSONResponse({'status':'ok','boot':'wrong'})
    if state['health_mode']=='bad-version':return JSONResponse({'status':'ok','runtime_version':123})
    if state['health_mode']=='failed':return JSONResponse({'error':'Fixture health unavailable'},status_code=503)
    return JSONResponse({"status": "ok", "runtime_version": "7.10.0", **credentials(request.headers)})


async def protected(request):
    await release.wait()
    if state['state_mode']=='malformed':return JSONResponse({'supervisor_ready':'yes'})
    if state['state_mode']=='not-ready':return JSONResponse({'supervisor_ready':False})
    if state['state_mode']=='forbidden':return JSONResponse({'error':'Fixture access denied'},status_code=403)
    return JSONResponse({"supervisor_ready": True, **credentials(request.headers)})


async def control(request):
    body = await request.json()
    if body.get('action')=='hold':release.clear()
    if body.get('action')=='release-all':release.set();login_release.set()
    if body.get('action')=='hold-login':login_release.clear()
    for key in ['health_mode','state_mode']:
        if key in body:state[key]=body[key]
    if "password" in body:
        state["password"] = body["password"]
    return JSONResponse({"ok": True})


async def audit(request):
    return JSONResponse(state["audit"])


async def redirect(request):
    return RedirectResponse("/fixture/redirect-target", status_code=302)


async def ws(peer):
    await peer.accept()
    try:
        while True:
            data = await peer.receive_json()
            await peer.send_json({"type": "echo", "value": data, **credentials(peer.headers)})
    except Exception:
        pass


app = Starlette(routes=[
    Route("/api/health", health), Route("/api/state", protected),
    Route("/fixture/control", control, methods=["POST"]), Route("/fixture/audit", audit),
    Route("/fixture/redirect", redirect), Route("/fixture/redirect-target", protected),
    WebSocketRoute("/ws", ws),
])
gate = auth.NetworkAuthGate(app)


class Surface:
    def __init__(self, remote_port):
        self.remote_port = remote_port

    async def __call__(self, scope, receive, send):
        if scope["type"] in {"http", "websocket"}:
            remote = scope["server"][1] == self.remote_port
            state["audit"].append({"path": scope["path"], "remote": remote,
                                   "method": scope.get("method", "WS"),
                                   **credentials({key.decode("latin-1"): value.decode("latin-1")
                                                  for key, value in scope.get("headers", [])})})
            if scope['path']=='/auth/login':await login_release.wait()
            if remote:
                scope = {**scope, "client": ("198.51.100.10", 12345)}
        await gate(scope, receive, send)


async def main():
    sockets = [socket.socket(), socket.socket()]
    for sock in sockets:
        sock.bind(("127.0.0.1", 0))
    (run / "ports.json").write_text(json.dumps({"remote": sockets[0].getsockname()[1],
                                                "loopback": sockets[1].getsockname()[1]}))
    server = uvicorn.Server(uvicorn.Config(Surface(sockets[0].getsockname()[1]), log_level="warning"))
    await server.serve(sockets=sockets)


asyncio.run(main())
