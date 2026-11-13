"""Real v2/legacy task event handlers over an isolated dialogue/result store."""
import json
import os
import pathlib
import socket
import sys

run = pathlib.Path(sys.argv[1])
for key in list(os.environ):
    if key.startswith('OUROBOROS_'):
        os.environ.pop(key)
data = run / 'data'
for directory in (data / 'logs', run / 'repo'):
    directory.mkdir(parents=True, exist_ok=True)
os.environ.update(OUROBOROS_APP_ROOT=str(run), OUROBOROS_DATA_DIR=str(data),
                  OUROBOROS_REPO_DIR=str(run / 'repo'), OUROBOROS_SETTINGS_PATH=str(data / 'settings.json'))
from ouroboros import config, dialogue_store as ds, store_import
from ouroboros.settings_setup_contract import SECRET_SETTING_KEYS
for key in SECRET_SETTING_KEYS:
    os.environ.pop(key, None)
config.initialize_runtime_mode_baseline('light')
store_import.ensure_current_store(data)
from ouroboros.task_results import write_task_result
from supervisor import queue
queue.init(data)
queue.init_queue_refs([], {}, [0])
queue.publish_queue_snapshot(reason='event_fixture')
write_task_result(data, 'event-root', 'running', ts='2026-01-01T00:00:00Z')
write_task_result(data, 'legacy-root', 'running', ts='2026-01-01T00:00:00Z')

def append(root, task, content, source='progress', **fields):
    value = dict(task_id=task, content=content, ts='2026-01-01T00:01:00Z', **fields)
    if source in ds.STREAMS:
        ds.append(root, source, value)
    else:
        with (root / 'logs' / (source + '.jsonl')).open('a') as handle:
            handle.write(json.dumps(value) + '\n')

append(data, 'event-root', 'Первый шаг <&>')
append(data, 'event-root', 'Ответ чата', source='chat')
append(data, 'event-root', 'Вызов инструмента', source='tools', type='tool_call')
append(data, 'unrelated', 'Чужая задача')
append(data, 'legacy-root', 'Старый протокол <&>')
audit = []
i18n_audit = []
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
from ouroboros.gateway.router import collect_routes

import queue as checkpoint_queue
from types import SimpleNamespace
checkpoint_live = checkpoint_queue.Queue()

def emit_checkpoint(task, fields):
    from ouroboros.loop_messages import _emit_checkpoint_event
    _emit_checkpoint_event(checkpoint_live,task,data / 'logs',fields)

async def checkpoint_control(request):
    body=await request.json();action=body['action']
    if action in ('entered','ended'):
        import time
        from ouroboros._usage_wait import _hold
        owner=SimpleNamespace(task_id='event-root',drive_root=data,event_queue=checkpoint_live,task={'chat_id':1})
        _hold(owner,action,time.monotonic()-.56,'usage-fixture')
    elif action=='seed':
        for fields in [
            dict(checkpoint_kind='control_store_wait',episode_id='control-one',phase='entered',elapsed_sec=0),
            dict(checkpoint_kind='control_store_wait',episode_id='control-one',phase='ended',elapsed_sec=119.6),
            dict(checkpoint_kind='context_view',status='applied',reclaimed_tokens=2048,detail='Private checkpoint <&> Ω'),
            dict(checkpoint_kind='cost_budget_wrapup',budget_axis='hard_tree_cap',milestone='80%',base_usd=2,
                 deciding_spend_usd=1.7,spend_basis='own_fallback_tree_unknown',wallet_remaining_known_usd=0),
            dict(checkpoint_kind='service_finalization_error',status='unconfirmed',detail='Cleanup was not confirmed <&>'),
            dict(checkpoint_kind='constructor',detail='Future checkpoint <&> Ω')]:
            emit_checkpoint('event-root',dict(system_type='task_checkpoint',role='system',**fields))
    elif action=='child':
        write_task_result(data,'checkpoint-child','running',parent_task_id='event-root',delegation_role='subagent')
        emit_checkpoint('checkpoint-child',dict(checkpoint_kind='usage_lock_wait',episode_id='usage-fixture',phase='ended',elapsed_sec=5,
            system_type='task_checkpoint',role='system'))
    elif action=='raw':emit_checkpoint(body.get('task','event-root'),body['fields'])
    return JSONResponse({'ok':True})

async def mutate(request):
    action = (await request.json())['action']
    if action == 'backdated':
        ds.append(data, 'progress', dict(task_id='event-root', content='Поздняя запись с ранней датой', ts='2025-01-01T00:00:00Z'))
    elif action == 'child':
        child = run / 'child'
        (child / 'logs').mkdir(parents=True)
        store_import.ensure_current_store(child)
        append(child, 'event-child', 'Дочерняя задача')
        write_task_result(data, 'event-child', 'running', parent_task_id='event-root', delegation_role='subagent', child_drive_root=str(child))
    elif action == 'rotate':
        (data / 'archive').mkdir(exist_ok=True)
        append(data, 'event-root', 'Перед ротацией', source='tools', type='tool_call')
        (data / 'logs/tools.jsonl').rename(data / 'archive/tools_20260101T000001.jsonl')
        append(data, 'event-root', 'После ротации', source='tools', type='tool_call')
    elif action == 'complete':
        write_task_result(data, 'event-root', 'completed', result='Готово <&>', ts='2026-01-01T01:00:00Z')
    elif action == 'legacy-tail':
        ds.append(data, 'progress', dict(task_id='legacy-root', content='Продолжение GET', ts='2026-01-01T00:02:00Z'))
    elif action == 'legacy-backdated':
        ds.append(data, 'progress', dict(task_id='legacy-root', content='Ранняя дата GET', ts='2025-01-01T00:00:00Z'))
    elif action == 'legacy-complete':
        write_task_result(data, 'legacy-root', 'completed', result='Итог GET <&>', ts='2026-01-01T01:00:00Z')
    else:
        return JSONResponse({'error': 'unknown action'}, status_code=400)
    return JSONResponse({'ok': True})

async def facts(request):
    import ouroboros
    parity=json.loads((pathlib.Path(ouroboros.__file__).parent.parent / 'web/tests/fixtures/wait_fold_parity.json').read_text())
    return JSONResponse({'audit':audit,'i18n_audit':i18n_audit,'checkpoint_live':list(checkpoint_live.queue),'wait_parity':parity})

app = Starlette(routes=[Route('/fixture/checkpoint',checkpoint_control,methods=['POST']),Route('/fixture/mutate', mutate, methods=['POST']), Route('/fixture/facts', facts), *collect_routes(data_dir=data)])
app.state.drive_root = data
app.state.repo_dir = run / 'repo'
class Observe:
    async def __call__(self, scope, receive, send):
        if scope['type']=='http' and scope['path']=='/api/ui/i18n/missing':
            raw=bytearray()
            async def capture():
                message=await receive();raw.extend(message.get('body',b''))
                if not message.get('more_body') and raw:
                    i18n_audit.append(json.loads(raw))
                return message
            return await app(scope,capture,send)
        if scope['type'] == 'http' and '/events' in scope['path']:
            audit.append({'method': scope['method'], 'path': scope['path'], 'query': scope.get('query_string',b'').decode()})
            if scope['method']=='POST' and scope['path']=='/api/tasks/legacy-root/events':
                return await JSONResponse({'error':'legacy fixture has no POST transport'},status_code=405)(scope,receive,send)
            if scope['path']=='/api/tasks/denied-root/events':
                return await JSONResponse({'error':'owner gate refused'},status_code=403)(scope,receive,send)
        await app(scope, receive, send)

import uvicorn
sock = socket.socket()
sock.bind(('127.0.0.1', 0))
(run / 'port').write_text(str(sock.getsockname()[1]))
uvicorn.Server(uvicorn.Config(Observe(), log_level='warning')).run(sockets=[sock])
