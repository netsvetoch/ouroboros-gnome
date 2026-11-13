def main():
    """Real dialogue revisions/preferences with one intentionally lost write response."""
    import json
    import os
    import pathlib
    import socket
    import sys

    run = pathlib.Path(sys.argv[1])
    for key in list(os.environ):
        if key.startswith("OUROBOROS_"):
            os.environ.pop(key)
    data, repo = run / "data", run / "repo"
    os.environ.update({"OUROBOROS_APP_ROOT": str(run), "OUROBOROS_DATA_DIR": str(data),
                       "OUROBOROS_REPO_DIR": str(repo), "OUROBOROS_SETTINGS_PATH": str(data / "settings.json")})
    for directory in (data / "logs", data / "memory", repo):
        directory.mkdir(parents=True, exist_ok=True)
    for name in ("chat", "progress"):
        (data / "logs" / (name + ".jsonl")).write_text("")
    from ouroboros import config, store_import, dialogue_store as ds
    from ouroboros.settings_setup_contract import SECRET_SETTING_KEYS
    for key in SECRET_SETTING_KEYS:
        os.environ.pop(key, None)
    config.initialize_runtime_mode_baseline("light")
    config.SETTINGS_PATH.write_text(json.dumps({"OUROBOROS_SUBAGENTS": '{"enabled":false,"items":[]}',
        "OUROBOROS_SUBAGENTS_MODE": "off", "TOTAL_BUDGET": 0}))
    store_import.ensure_current_store(data)
    from ouroboros.projects_registry import create_project
    from ouroboros.task_results import write_task_result
    from ouroboros.room_appearances import write_facts
    from ouroboros.chat_chain import row_address, format_address
    project = create_project(data, "read-fixture", name="Проект <&>")
    chat = int(project["chat_id"])
    write_task_result(data, "reader-task", "running", chat_id=chat, title="Инертная задача")
    for index in range(2):
        ds.append(data, "chat", dict(direction="out", chat_id=chat, task_id="reader-task",
            text=f"Непрочитанное сообщение {index}", ts=f"2026-11-12T00:00:0{index}Z"), feed=True, emit_live=False)
    rows = []
    for index in range(72):
        text = "\n".join(f"Строка {line} <&>" for line in range(24)) if index == 0 else f"Общее сообщение {index} <&>"
        row = dict(direction="out", type="main_notice", chat_id=1, task_id="reader-task", text=text,
                   ts=f"2026-11-12T00:{index // 60 + 1:02d}:{index % 60:02d}Z")
        keys, others = write_facts(data, row)
        assert others == [chat], (keys, others)
        saved = ds.append(data, "chat", row, feed=True, also_feed=others, appearances=keys,
                          room_revisions=True, emit_live=False).row
        rows.append({"address": format_address(row_address(saved)), "revisions": saved["room_revisions"], "text": text})
    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    from ouroboros.gateway.router import collect_routes
    audit = []
    mode = {"lose": False, "key": None, "delay_id": "", "delayed": 0}

    async def facts(request):
        return JSONResponse({"chat": chat, "project": project["id"], "rows": rows, "audit": audit, "delayed": mode["delayed"],
                             "revisions": {str(room["chat_id"]): room["revision"] for room in ds.rooms(data)}})

    async def lose(request):
        mode["lose"] = True
        mode["key"] = (await request.json()).get("key")
        return JSONResponse({"ok": True})

    async def append(request):
        body = await request.json()
        row = dict(direction="out", chat_id=int(body.get("chat_id", 1)), text=body["text"],
                   ts="2026-11-12T03:00:00Z")
        saved = ds.append(data, "chat", row, feed=True, emit_live=False).row
        return JSONResponse({"address": format_address(row_address(saved))})

    async def delay(request):
        mode["delay_id"] = (await request.json())["id"]
        return JSONResponse({"ok": True})

    app = Starlette(routes=[Route("/fixture/facts", facts), Route("/fixture/lose", lose, methods=["POST"]),
                            Route("/fixture/append", append, methods=["POST"]),
                            Route("/fixture/delay-project", delay, methods=["POST"]),
                            *collect_routes(data_dir=data)])
    app.state.drive_root, app.state.repo_dir = data, repo

    class Observe:
        async def __call__(self, scope, receive, send):
            if scope["type"] == "http" and scope["path"] == "/api/projects" and scope["method"] == "GET":
                from urllib.parse import parse_qs
                if mode["delay_id"] and parse_qs(scope.get("query_string", b"").decode()).get("id") == [mode["delay_id"]]:
                    import asyncio
                    mode["delayed"] += 1
                    await asyncio.sleep(0.6)
            if scope["type"] != "http" or scope["path"] != "/api/ui/preferences" or scope["method"] != "POST":
                return await app(scope, receive, send)
            body = bytearray()

            async def input():
                message = await receive()
                body.extend(message.get("body", b""))
                return message

            messages = []
            await app(scope, input, capture(messages))
            patch = json.loads(body)
            lost = mode["lose"] and (mode["key"] is None or mode["key"] in patch)
            record = {"body": patch, "status": messages[0]["status"], "lost": lost}
            audit.append(record)
            if lost:
                mode["lose"] = False
                return await JSONResponse({"error": "fixture lost response after durable write"}, status_code=503)(scope, receive, send)
            for message in messages:
                await send(message)

    def capture(messages):
        async def output(message):
            messages.append(message)
        return output

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    (run / "port").write_text(str(sock.getsockname()[1]))
    uvicorn.Server(uvicorn.Config(Observe(), log_level="warning")).run(sockets=[sock])


if __name__ == "__main__":
    main()
