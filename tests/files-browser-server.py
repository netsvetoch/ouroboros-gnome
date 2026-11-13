"""Real Files endpoints over isolated disk; response faults and timing are controlled."""
import asyncio
import base64
import json
import os
import pathlib
import socket
import sys
from urllib.parse import parse_qs

import uvicorn
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route

run = pathlib.Path(sys.argv[1])
root = run / 'data'
root.mkdir()
files = run / 'files'
files.mkdir()
for name in ('first', 'second'):
    (files / name).mkdir()
    (files / name / 'note.txt').write_text(name + ' <&> 🔧\n', encoding='utf-8')
(files / 'note.txt').write_text('Original � <&> 🔧\n', encoding='utf-8')
(files / 'large.bin').write_bytes(bytes(range(256)) * 5000)
alternate = run / 'alternate-files'
alternate.mkdir()
(alternate / 'note.txt').write_bytes((files / 'note.txt').read_bytes())
os.environ['OUROBOROS_FILE_BROWSER_DEFAULT'] = str(files)
os.environ['OUROBOROS_DATA_DIR'] = str(root)
from ouroboros.gateway.files import file_browser_routes as file_routes
state = {'hold': '', 'fault': ''}
audit = []
release = asyncio.Event()
release.set()

async def control(request):
    body = await request.json()
    if body.get('action') == 'release-all':
        state['hold'] = ''
        release.set()
    if body.get('action') == 'setup-actions':
        for base in (files, alternate):
            (base / 'destination').mkdir(exist_ok=True)
            (base / 'source-move.txt').write_text('Move original <&> Ω\n')
            (base / 'unknown.txt').write_text('Unknown transfer <&> Ω\n')
    if body.get('action') == 'retarget-alias':
        (files / 'alias.txt').unlink()
        (files / 'alias.txt').symlink_to('new.txt')
    if body.get('action') == 'symlink':
        (files / 'alias.txt').symlink_to('note.txt')
    if body.get('action') == 'root':
        os.environ['OUROBOROS_FILE_BROWSER_DEFAULT'] = str(alternate if body.get('alternate') else files)
    if 'hold' in body:
        state['hold'] = body['hold']
        release.clear()
    if 'fault' in body:
        state['fault'] = body['fault']
    return JSONResponse({'ok': True})

async def facts(request):
    return JSONResponse({'audit': audit, 'content': (files / 'note.txt').read_text() if (files / 'note.txt').exists() else None,
                         'files': {str(p.relative_to(files)): base64.b64encode(p.read_bytes()).decode() for p in files.rglob('*') if p.is_file()},
                         'alternate_files': {str(p.relative_to(alternate)): base64.b64encode(p.read_bytes()).decode() for p in alternate.rglob('*') if p.is_file()},
                         'large_size': (files / 'large.bin').stat().st_size})

# Only actual Files routes are exposed; no command/supervisor/provider is started.
app = Starlette(routes=[Route('/fixture/control', control, methods=['POST']),
                        Route('/fixture/facts', facts), *file_routes()])
app.state.drive_root = root

class Observe:
    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or not scope['path'].startswith('/api/files/'):
            return await app(scope, receive, send)
        path = scope['path']
        selected = parse_qs(scope.get('query_string', b'').decode()).get('path', [''])[0]
        record = {'method': scope['method'], 'path': path, 'selected': selected}
        audit.append(record)
        held = state['hold'] == path.rsplit('/', 1)[-1]
        fault = state['fault']
        if held and not path.endswith('/download'):
            await release.wait()
        if fault == 'list-404' and path.endswith('/list'):
            return await JSONResponse({'error': 'fixture parent missing'}, status_code=404)(scope, receive, send)
        if fault == 'http' and path.endswith('/list'):
            return await JSONResponse({'error': 'fixture listing unavailable'}, status_code=503)(scope, receive, send)
        captured = []
        async def output(message):
            if fault and path.endswith(('/list', '/read', '/write', '/transfer')) or path.endswith('/upload'):
                captured.append(message)
                return
            await send(message)
            if held and path.endswith('/download') and message['type'] == 'http.response.body' and message.get('more_body'):
                record['stream_started'] = True
                await release.wait()
        await app(scope, receive, output)
        if captured:
            status = captured[0]['status']
            record['status'] = status
            if state['hold']=='upload-receipt' and path.endswith('/upload'):
                record['handler_done'] = True
                await release.wait()
            if status == 200:
                body = json.loads(b''.join(m.get('body', b'') for m in captured))
                if path.endswith('/list'):
                    if fault == 'list-root': body['root_path'] = []
                    elif fault == 'legacy-root': body.pop('root_path', None)
                    elif fault == 'entries': body['entries'] = [None]
                    elif fault == 'breadcrumb': body['breadcrumb'] = [None]
                    elif fault == 'size': body['entries'][0]['size'] = -1
                    elif fault == 'truncated': body['truncated'] = 'false'
                elif path.endswith('/read'):
                    if fault == 'legacy-root': body.pop('root_path', None)
                    elif fault == 'read': body['is_text'] = 'yes'
                    elif fault == 'read-path': body['path'] = 'second/note.txt'
                    elif fault == 'read-root': body['root_path'] = []
                    elif fault == 'read-root-missing': body.pop('root_path', None)
                elif path.endswith('/write'):
                    if fault == 'write-missing': body.pop('size', None)
                    elif fault == 'write-negative': body['size'] = -1
                    elif fault == 'write-string': body['size'] = str(body['size'])
                    elif fault == 'write-boolean': body['size'] = True
                    elif fault == 'write-fraction': body['size'] = 1.5
                    elif fault == 'write-short': body['size'] -= 1
                    elif fault == 'write-long': body['size'] += 1
                    elif fault == 'write-path': body['path'] = 'second/note.txt'
                    elif fault == 'write-ok': body['ok'] = 'true'
                    elif fault == 'write-loss': return await JSONResponse({'error':'fixture lost acknowledgement'},status_code=503)(scope,receive,send)
                elif path.endswith('/transfer') and fault == 'transfer-loss':
                    return await JSONResponse({'error':'fixture lost transfer acknowledgement'}, status_code=503)(scope,receive,send)
                elif path.endswith('/upload'):
                    if fault == 'upload-size-missing': body.pop('size', None)
                    elif fault == 'upload-size-short': body['size'] -= 1
                    elif fault == 'upload-size-string': body['size'] = str(body['size'])
                    elif fault == 'upload-name': body['name'] = 'another-file.bin'
                    elif fault == 'upload-path': body['path'] = 'second/' + body['name']
                    elif fault == 'upload-ok': body['ok'] = 'true'
                    elif fault == 'upload-loss': return await JSONResponse({'error':'fixture lost upload acknowledgement'},status_code=503)(scope,receive,send)
                return await JSONResponse(body)(scope, receive, send)
            for message in captured: await send(message)

sock = socket.socket()
sock.bind(('127.0.0.1', 0))
(run / 'port').write_text(str(sock.getsockname()[1]))
uvicorn.Server(uvicorn.Config(Observe(), log_level='warning')).run(sockets=[sock])
