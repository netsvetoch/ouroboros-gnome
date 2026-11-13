"""Real skill review lifecycle/continuation; physical session engine is scripted."""
def main():
    import json, os, pathlib, socket, sys, threading
    from types import SimpleNamespace
    run = pathlib.Path(sys.argv[1])
    for key in list(os.environ):
        if key.startswith('OUROBOROS_'):
            os.environ.pop(key)
    os.environ.update(OUROBOROS_APP_ROOT=str(run), OUROBOROS_DATA_DIR=str(run/'data'), OUROBOROS_REPO_DIR=str(run/'repo'), OUROBOROS_SETTINGS_PATH=str(run/'settings.json'))
    import pytest
    from tests.test_skill_review_usage_events import skill_door, server_bus
    from tests.review_pool_rosters import pool_seat
    from tests._review_session_route_shared import FakeGateway, _terminal_detail
    from ouroboros import delegate_custody, review_ledger
    patch = pytest.MonkeyPatch()
    bus = server_bus.__wrapped__(patch)
    fixture = skill_door.__wrapped__(run, patch, bus)
    door = next(fixture)
    door.pool(pool_seat('review-a', 'fake-review=fake-small', kind='agent_session', access='readonly'),
              pool_seat('review-b', 'fake-review=fake-small', kind='agent_session', access='readonly'), api=False)
    FakeGateway.reset()
    FakeGateway.run_dir = run/'review-run'
    posts, runs = [], {}
    lock = threading.Lock()
    class Engine(FakeGateway):
        def start_run(self, request, *, idempotency_key=''):
            super().start_run(request, idempotency_key=idempotency_key)
            with lock:
                run_id = runs.setdefault(str(idempotency_key), f'run-{len(runs)+1}')
                posts.append(dict(request=dict(request), key=str(idempotency_key), run_id=run_id))
            return {'runId': run_id, 'runDir': str(FakeGateway.run_dir)}
        def get_run(self, run_id, **_kw):
            original = next(row for row in posts if row['run_id'] == run_id)
            if original['request'].get('continueFrom'):
                return _terminal_detail('{"findings": []}', conformance='passed')
            stopped = _terminal_detail('PARTIAL: retained original review work', state='failed')
            stopped['summary'].update(failure={'code':'credential_pool_exhausted','safeMessage':'Account limit reached'},
                                      resumable={'cause':'pool_exhausted','carriers':['native']})
            return stopped
    patch.setattr('ouroboros.gateways.claudexor.ClaudexorGateway', Engine)
    patch.setattr('ouroboros.claudexor_daemon.ensure_owned_gateway', lambda: Engine())
    patch.setattr('ouroboros.claudexor_daemon.read_owned_gateway', lambda: Engine())
    delegate_custody._CUSTODY.clear()
    first = door.client.post('/api/skills/weather/review', json={}).json()
    assert len(posts) == 2, first
    record_id = first['record_id']
    assert len(next(item for item in door.client.get('/api/extensions').json()['skills'] if item['name']=='weather')['skill_review']['history'][0]['continuable_seats']) == 2
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    from ouroboros.gateway.router import collect_routes
    import server as srv
    audit=[]
    async def facts(request):
        state={'first':first,'posts':posts,'audit':audit,'record':review_ledger.load_record(door.drive,record_id)}
        (run/'facts.json').write_text(json.dumps(state,indent=2))
        return JSONResponse(state)
    async def control(request):
        body=await request.json()
        if body.get('action')=='change-payload':
            path=door.drive/'skills/external/weather/SKILL.md'
            path.write_text(path.read_text()+'\nChanged owner payload.\n')
        return JSONResponse({'ok':True})
    app=Starlette(routes=[Route('/fixture/facts',facts),Route('/fixture/control',control,methods=['POST']),*collect_routes(data_dir=door.drive)])
    app.state.drive_root=door.drive;app.state.repo_dir=srv.app.app.state.repo_dir
    app.state.supervisor_ready_event=threading.Event();app.state.supervisor_ready_event.set()
    class Observe:
        async def __call__(self,scope,receive,send):
            if scope['type']=='http' and scope['path'].startswith('/api/'):
                event={'method':scope['method'],'path':scope['path']};audit.append(event);original=receive;chunks=[]
                async def receive():
                    message=await original()
                    if message['type']=='http.request':
                        chunks.append(message.get('body',b''))
                        if not message.get('more_body'):
                            try:event['body']=json.loads(b''.join(chunks))
                            except ValueError:pass
                    return message
            await app(scope,receive,send)
    sock=socket.socket();sock.bind(('127.0.0.1',0));(run/'port').write_text(str(sock.getsockname()[1]))
    try:uvicorn.Server(uvicorn.Config(Observe(),log_level='warning')).run(sockets=[sock])
    finally:
        (run/'facts.json').write_text(json.dumps({'posts':posts,'audit':audit,'record':review_ledger.load_record(door.drive,record_id)},indent=2))
        fixture.close();patch.undo()
if __name__=='__main__':main()
