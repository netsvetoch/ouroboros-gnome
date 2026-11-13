"""Real confined directory listing and project attach API, under an owned home-cache run."""
import asyncio
import json
import os
import pathlib
import socket
import sys
from urllib.parse import parse_qs

run = pathlib.Path(sys.argv[1])
root = run / 'data'
for directory in (root / 'logs', run / 'repo', run / 'folders/first/.git', run / 'folders/second', run / 'folders/empty', run / 'folders/.hidden', run / 'folders/many'):
    directory.mkdir(parents=True)
(root / 'logs/chat.jsonl').write_text('')
(root / 'logs/progress.jsonl').write_text('')
(run / 'folders/plain.txt').write_text('not a directory\n')
(run / 'folders/second/keep.txt').write_text('Attached owner folder <&> 🔧\n')
for index in range(502):
    (run / 'folders/many' / f'item-{index:03}').mkdir()
os.environ['OUROBOROS_DATA_DIR'] = str(root)
from ouroboros.gateway.router import collect_routes
from ouroboros import projects_registry
import uvicorn
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
state = {'hold': '', 'fault': ''}
audit = []
release = asyncio.Event()
release.set()

async def control(request):
    body = await request.json()
    if body.get('action') == 'release-all':
        state['hold'] = ''
        release.set()
    if 'hold' in body:
        state['hold'] = body['hold']
        release.clear()
    if 'fault' in body: state['fault'] = body['fault']
    return JSONResponse({'ok': True})

async def facts(request):
    return JSONResponse({'folders': str(run / 'folders'), 'home': str(pathlib.Path.home()), 'audit': audit,
                         'projects': projects_registry.list_projects(root),
                         'kept': (run / 'folders/second/keep.txt').read_text()})

wanted = {'/api/fs/dirs', '/api/projects'}
app = Starlette(routes=[Route('/fixture/control', control, methods=['POST']), Route('/fixture/facts', facts),
                        *[r for r in collect_routes(data_dir=root) if getattr(r, 'path', '') in wanted]])
app.state.drive_root = root
app.state.repo_dir = run / 'repo'

class Observe:
    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or scope['path'].startswith('/fixture/'):
            return await app(scope, receive, send)
        path = scope['path']
        selected = parse_qs(scope.get('query_string', b'').decode()).get('path', [''])[0]
        record = {'method': scope['method'], 'path': path, 'selected': selected}
        audit.append(record)
        held = state['hold'] == ('dirs' if path == '/api/fs/dirs' else 'create' if scope['method'] == 'POST' else '')
        fault = state['fault']
        if held: await release.wait()
        if fault == 'http' and path == '/api/fs/dirs':
            return await JSONResponse({'error': 'fixture listing unavailable'}, status_code=503)(scope, receive, send)
        captured = []
        requested = bytearray()
        async def input():
            message = await receive()
            requested.extend(message.get('body', b''))
            return message
        async def output(message):
            if path == '/api/fs/dirs' and fault:
                captured.append(message)
                return
            await send(message)
        await app(scope, input, output)
        if requested: record['body'] = json.loads(requested)
        if captured:
            if captured[0]['status'] == 200:
                body = json.loads(b''.join(m.get('body', b'') for m in captured))
                if fault == 'dirs': body['dirs'] = [None]
                elif fault == 'parent': body['parent'] = None
                elif fault == 'git': body['dirs'][0]['is_git'] = 'false'
                elif fault == 'truncated': body['truncated'] = 'false'
                return await JSONResponse(body)(scope, receive, send)
            for message in captured: await send(message)

sock = socket.socket()
sock.bind(('127.0.0.1', 0))
(run / 'port').write_text(str(sock.getsockname()[1]))
uvicorn.Server(uvicorn.Config(Observe(), log_level='warning')).run(sockets=[sock])
