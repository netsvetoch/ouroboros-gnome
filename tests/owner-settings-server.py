"""Real settings/owner routes in an isolated installation, without starting a supervisor."""
import json
import asyncio
import os
import pathlib
import socket
import sys

run = pathlib.Path(sys.argv[1])
for key in list(os.environ):
    if key.startswith("OUROBOROS_"):
        os.environ.pop(key)
os.environ.update({"OUROBOROS_APP_ROOT": str(run), "OUROBOROS_DATA_DIR": str(run / "data"),
                   "OUROBOROS_REPO_DIR": str(run / "repo"),
                   "OUROBOROS_SETTINGS_PATH": str(run / "data/settings.json"),
                   "OUROBOROS_RUNTIME_MODE": "light"})
(run / "data/logs").mkdir(parents=True)
(run / "repo").mkdir()

from ouroboros import config
from ouroboros.settings_setup_contract import SECRET_SETTING_KEYS
for key in SECRET_SETTING_KEYS:
    os.environ.pop(key, None)
assert config.SETTINGS_PATH == run / "data/settings.json"
config.initialize_runtime_mode_baseline("light")
seed = {
    "OUROBOROS_RUNTIME_MODE": "light", "OUROBOROS_CONTEXT_MODE": "max",
    "OUROBOROS_EFFORT_MIN": "low", "OUROBOROS_EFFORT_TASK": "medium", "OUROBOROS_EFFORT_MAX": "high",
    "OUROBOROS_SUBAGENTS_MODE": "auto", "OUROBOROS_AUTO_GRANT_REVIEWED_SKILLS": "false",
    "OUROBOROS_SAFETY_MODE": "full", "OUROBOROS_CONSCIOUSNESS_SAFETY_MODE": "full",
    "OUROBOROS_MODEL": "", "OUROBOROS_MODEL_LIGHT": "", "OUROBOROS_MODEL_HEAVY": "", "OUROBOROS_MODEL_SAFETY": "",
    "OUROBOROS_TASK_REVIEW_MODE": "off", "OUROBOROS_MAX_WORKERS": 3,
    "OUROBOROS_SUBAGENTS": json.dumps({"enabled": True, "items": [{"subagent_id": "fixture",
        "recommended_use": "fixture", "route": {"kind": "api_model", "target_id": "fixture/model"}}]}),
}
if '--model-role-options' in sys.argv[2:]:
    seed.update(OUROBOROS_MODEL_ACCOUNTS=json.dumps({'main':'before','fallback':['first','second']}),
        OUROBOROS_MODEL_CONTEXT_WINDOWS=json.dumps({'main':123,'light':0,'fallback':[10,20]}),
        OUROBOROS_MODEL_PROCESSING_PREFERENCES=json.dumps({'main':'standard','websearch':'economy','fallback':['fast','economy']}))
if '--subagent-pins' in sys.argv[2:]:
    seed['OUROBOROS_SUBAGENTS']=json.dumps({'enabled':False,'items':[
        {'subagent_id':'managed','recommended_use':'Managed <&> 🔧','route':{'kind':'api_model','target_id':'claudexor::fixture-source=shared','credential_profile_id':'profile <&> 🔧'},
         'effort':'medium','processing_preference':'fast','delivery':'packet','rechecks_flags':True,'review_eligible':True,'minted_from':'review_lane'},
        {'subagent_id':'session','recommended_use':'Session fixture','route':{'kind':'agent_session','target_id':'codex=gpt-5.6-sol','credential_profile_id':'session-profile'},
         'access':'readonly','review_eligible':True},
        {'subagent_id':'ordinary','recommended_use':'API fixture','route':{'kind':'api_model','target_id':'fixture/model'}}]})
config.SETTINGS_PATH.write_text(json.dumps(seed))

import uvicorn
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
from ouroboros.gateway.router import collect_routes
from ouroboros import projects_registry
from ouroboros.usage_store import migrate_from_journal

migrate_from_journal(run / "data")
projects_registry.create_project(run / "data", "fixture-project", name="Проект параметров")
audit = []
write_fault = {"mode": "", "read": "", "read_after": ""}
write_release = asyncio.Event(); write_release.set()

async def write_control(request):
    body = await request.json()
    write_fault.update({key: body[key] for key in write_fault if key in body})
    if write_fault["read"] == "hold": write_release.clear()
    else: write_release.set()
    return JSONResponse({"ok": True})


async def facts(request):
    from ouroboros.model_slots import model_role_option, MODEL_ACCOUNTS_KEY, MODEL_CONTEXT_WINDOWS_KEY, MODEL_PROCESSING_PREFERENCES_KEY
    settings=json.loads(config.SETTINGS_PATH.read_text())
    resolved={key:{role:model_role_option(key,role,settings=settings) for role in ('main','light','safety','vision','consciousness','deep_review','websearch','fallback:0','fallback:1','fallback:2')}
        for key in (MODEL_ACCOUNTS_KEY,MODEL_CONTEXT_WINDOWS_KEY,MODEL_PROCESSING_PREFERENCES_KEY)}
    from ouroboros.configured_subagents import parse_configured_subagents, configured_subagents_dict
    catalog=configured_subagents_dict(parse_configured_subagents(settings.get('OUROBOROS_SUBAGENTS','')))
    return JSONResponse({'subagent_catalog':catalog,'resolved':resolved,"settings": json.loads(config.SETTINGS_PATH.read_text()),
                         "projects": projects_registry.list_projects(run / "data"), "audit": audit})


app = Starlette(routes=[Route("/fixture/facts", facts), Route("/fixture/settings-write", write_control, methods=["POST"]), *collect_routes(data_dir=run / "data")])
app.state.drive_root = run / "data"
app.state.repo_dir = run / "repo"


class Observe:
    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await app(scope, receive, send)
        headers = dict(scope.get("headers", []))
        record = {"method": scope["method"], "path": scope["path"],
                  "surface": headers.get(b"x-ouroboros-surface", b"").decode(),
                  "actor": headers.get(b"x-ouroboros-actor", b"").decode()}
        if scope["path"] != "/fixture/facts":
            audit.append(record)
        async def output(message):
            if message["type"] == "http.response.start":
                record["status"] = message["status"]
            elif message["type"] == "http.response.body" and record.get("status", 200) >= 400:
                record["error"] = message.get("body", b"")[:4096].decode(errors="replace")
            await send(message)
        target = '--write-receipts' in sys.argv and scope['path'] == '/api/settings'
        if target and scope['method'] == 'GET':
            if write_fault['read'] == 'hold': await write_release.wait()
            if write_fault['read'] == 'fail':
                return await JSONResponse({'error': 'fixture read unavailable'}, status_code=503)(scope, receive, output)
        mode = write_fault['mode'] if target and scope['method'] == 'POST' else ''
        if mode:
            write_fault['mode'] = ''
            write_fault['read'] = write_fault['read_after']; write_fault['read_after'] = ''
            if mode == 'before':
                return await JSONResponse({'error': 'fixture uncertain before write'}, status_code=503)(scope, receive, output)
            messages = []
            async def collect(message): messages.append(message)
            await app(scope, receive, collect)
            if messages[0]['status'] < 400:
                if mode == 'after':
                    return await JSONResponse({'error': 'fixture uncertain after write'}, status_code=503)(scope, receive, output)
                if mode == 'postcommit':
                    from ouroboros.gateway.owner_settings import CommitBoundary, post_commit_failure_response
                    boundary = CommitBoundary(); boundary.commit(); boundary.at('fixture-post-save')
                    return await post_commit_failure_response(RuntimeError('fixture later step'), boundary)(scope, receive, output)
            for message in messages: await output(message)
            return
        await app(scope, receive, output)


sock = socket.socket()
sock.bind(("127.0.0.1", 0))
(run / "port").write_text(str(sock.getsockname()[1]))
uvicorn.Server(uvicorn.Config(Observe(), log_level="warning")).run(sockets=[sock])
