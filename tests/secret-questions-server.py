def main():
    """Real protected secret decisions; only synthetic values in isolated Settings."""
    import asyncio
    import hashlib
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
    data, repo = run / "data", run / "repo"
    os.environ.update({"OUROBOROS_APP_ROOT": str(run), "OUROBOROS_DATA_DIR": str(data),
        "OUROBOROS_REPO_DIR": str(repo), "OUROBOROS_SETTINGS_PATH": str(data / "settings.json")})
    for directory in (data / "logs", data / "memory", repo):
        directory.mkdir(parents=True, exist_ok=True)
    for name in ("chat", "progress"):
        (data / "logs" / (name + ".jsonl")).write_text("")
    from ouroboros import config, store_import, owner_quiz, secret_requests as sr
    from ouroboros.settings_setup_contract import SECRET_SETTING_KEYS
    for key in SECRET_SETTING_KEYS:
        os.environ.pop(key, None)
    config.initialize_runtime_mode_baseline("light")
    config.get_skills_repo_path = lambda: ""  # never inspect the user's installed skills
    config.SETTINGS_PATH.write_text(json.dumps({"OUROBOROS_SUBAGENTS": '{"enabled":false,"items":[]}',
        "OUROBOROS_SUBAGENTS_MODE": "off", "TOTAL_BUDGET": 0, "UNRELATED_SETTING": "keep"}))
    store_import.ensure_current_store(data)
    from ouroboros.usage_store import migrate_from_journal
    migrate_from_journal(data)
    from supervisor import queue, workers, state, message_bus
    state.init(data)
    queue.init(data)
    queue.init_queue_refs(workers.PENDING, workers.RUNNING, workers.QUEUE_SEQ_COUNTER_REF)
    workers.WORKERS = {0: SimpleNamespace(busy_task_id=None, reaping=False)}
    workers._WORKER_POOL_DISABLED_REASON = ""
    fields = {name: "NATIVE_SECRET_" + name.upper() for name in
              ("fillToken", "fillRegion", "conflictToken", "lostToken", "beforeToken", "cancelToken", "lateToken", "terminalToken", "damagedToken", "unknownToken")}
    plugins = {}
    for offset in range(0, len(fields), 8):
        name = "native-secret-fixture" + ("-aux" if offset else "")
        declared = dict(list(fields.items())[offset:offset + 8])
        plugins.update({field: name for field in declared})
        skill = data / "skills/external" / name
        (skill / "scripts").mkdir(parents=True)
        (skill / "SKILL.md").write_text(f"---\nname: {name}\ndescription: Inert fixture.\nversion: 0.1.0\n"
            "type: script\nruntime: python3\ntimeout_sec: 30\nenv_from_settings: [" + ", ".join(declared.values()) + "]\n"
            "secret_fields:\n" + "".join(f"  {field}: {key}\n" for field, key in declared.items()) +
            "scripts:\n  - name: run.py\n---\n# Inert fixture\n")
        (skill / "scripts/run.py").write_text("raise RuntimeError('fixture must never execute')\n")
    from ouroboros.task_results import write_task_result
    write_task_result(data, "secret-asker", "scheduled", chat_id=1)
    workers.PENDING.append(dict(id="secret-asker", type="task", chat_id=1, root_task_id="secret-asker", _attempt=1,
                                drive_root=str(data)))
    write_task_result(data, "secret-late", "completed", chat_id=1)
    queue.publish_queue_snapshot(reason="secret_questions_fixture")
    bridge = message_bus.LocalChatBridge()
    frames = []
    bridge._broadcast_fn = frames.append
    message_bus.DATA_DIR, message_bus._BRIDGE = data, bridge
    cases = {"fill": ["fillToken", "fillRegion"], "conflict": ["conflictToken"], "lost": ["lostToken"],
             "before": ["beforeToken"], "cancel": ["cancelToken"], "late": ["lateToken"],
             "terminal": ["terminalToken"], "damaged": ["damagedToken"], "unknown": ["unknownToken"]}
    for qid, names in cases.items():
        task = "secret-late" if qid == "late" else "secret-asker"
        request = sr.resolve_secret_request(data, plugins[names[0]], names)
        owner_quiz.record_asked(data, task, quiz_id=qid, question=sr.question_text(request), options=[],
            wait_for_answer=True, chat_id=1, secret_request=request)
        owner_quiz.record_publication(data, task, qid, 1)
    owner_quiz.reconcile_terminal(data, "secret-late")
    from ouroboros.owner_mailbox import drain_owner_entries
    from ouroboros.gateway.owner_settings import _owner_update_settings
    audit, canaries = [], set()
    i18n_audit = []
    mode = {"loss": None, "hold": None, "backup": None}

    def digest(value):
        return hashlib.sha256(value.encode()).hexdigest()

    def leaks():
        needles = {needle for value in canaries for needle in (value.encode(),
            json.dumps(value)[1:-1].encode(), json.dumps(value, ensure_ascii=False)[1:-1].encode())}
        return [str(path.relative_to(data)) for path in data.rglob("*") if path.is_file()
            and not path.name.startswith("settings.json") and any(needle in path.read_bytes() for needle in needles)]

    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route, WebSocketRoute
    from ouroboros.gateway.router import collect_routes

    async def facts(request):
        try:
            document = json.loads(config.SETTINGS_PATH.read_text())
            settings = {key: digest(document[key]) for key in fields.values() if isinstance(document.get(key), str)}
            unrelated = document.get("UNRELATED_SETTING")
        except Exception:
            settings, unrelated = None, None
        return JSONResponse(dict(audit=audit, i18n_audit=i18n_audit, fields=fields, digests=settings, unrelated=unrelated,
            quizzes={task: owner_quiz.quiz_states(data, task) for task in ("secret-asker", "secret-late")},
            mail={task: drain_owner_entries(data, task, set()) for task in ("secret-asker", "secret-late")},
            frames=frames, inbox_size=bridge._inbox.qsize(), pending=[task["id"] for task in workers.PENDING],
            leaks=leaks(), held=bool(mode["hold"] and mode["hold"]["ready"])))

    async def control(request):
        body = await request.json()
        action = body["action"]
        if action == "set":
            value = body["value"]
            canaries.add(value)
            key = fields[body["field"]]
            _owner_update_settings(lambda document: {**document, key: value})
        elif action == "loss":
            mode["loss"] = body
        elif action == "claim":
            assert sr.claim_save(data, "secret-asker", "unknown", "interrupted-fixture").get("ok")
            value = body["value"]
            canaries.add(value)
            key = fields["unknownToken"]
            _owner_update_settings(lambda document: {**document, key: value})
        elif action == "hold":
            mode["hold"] = {"id": body["id"], "ready": False, "event": asyncio.Event(), "operation": body.get("operation", "status"), "fail": body.get("fail", True)}
        elif action == "release":
            if mode["hold"]:mode["hold"]["event"].set()
        elif action == "damage":
            mode["backup"] = config.SETTINGS_PATH.read_bytes()
            config.SETTINGS_PATH.write_bytes(mode["backup"] + b"{torn")
        elif action == "repair":
            config.SETTINGS_PATH.write_bytes(mode["backup"])
        else:
            raise ValueError("unknown fixture control")
        return JSONResponse({"ok": True})

    async def ws(peer):
        await peer.accept()
        from ouroboros.gateway import ws as gateway_ws
        gateway_ws.set_event_loop(asyncio.get_running_loop())
        connection = gateway_ws._register(peer)

        async def publish():
            index = 0
            try:
                while True:
                    while index < len(frames):
                        await peer.send_json(frames[index])
                        index += 1
                    await asyncio.sleep(0.025)
            except Exception:
                pass

        sender = asyncio.create_task(publish())
        try:
            while True:
                frame = await peer.receive_json()
                if frame.get("type") == "ping":
                    await peer.send_json({"type": "pong"})
        except Exception:
            pass
        finally:
            gateway_ws._unregister(connection)
            sender.cancel()
            try:
                await sender
            except asyncio.CancelledError:
                pass

    routes = [route for route in collect_routes(data_dir=data) if getattr(route, "path", "") != "/ws"]
    app = Starlette(routes=[Route("/fixture/facts", facts), Route("/fixture/control", control, methods=["POST"]),
                            WebSocketRoute("/ws", ws), *routes])
    app.state.drive_root, app.state.repo_dir = data, repo

    class Observe:
        async def __call__(self, scope, receive, send):
            if scope['type']=='http' and scope['path']=='/api/ui/i18n/missing':
                parts=bytearray()
                async def capture():
                    message=await receive();parts.extend(message.get('body',b''));return message
                await app(scope,capture,send)
                i18n_audit.append(json.loads(parts))
                return
            if scope["type"] != "http" or scope["path"] != "/api/decisions/secret":
                return await app(scope, receive, send)
            parts = bytearray()
            more = True
            while more:
                message = await receive()
                parts.extend(message.get("body", b""))
                more = message.get("more_body", False)
            body = json.loads(parts)
            values = body.pop("values", None)
            if isinstance(values, dict):
                canaries.update(value for value in values.values() if isinstance(value, str))
            record = {**body, "value_digests": {key: digest(value) for key, value in (values or {}).items()}}
            audit.append(record)
            loss = mode["loss"] if mode["loss"] and mode["loss"]["id"] == body.get("decision_id") and body.get("action") != "status" else None
            if loss and loss.get("before"):
                mode["loss"] = None
                record["before"] = True
                return await JSONResponse({"error": "fixture response unavailable", "saved": None}, status_code=503)(scope, receive, send)

            async def replay():
                return {"type": "http.request", "body": bytes(parts), "more_body": False}

            messages = []

            async def output(message):
                messages.append(message)

            await app(scope, replay, output)
            record["status"] = messages[0]["status"]
            record["reply"] = json.loads(b"".join(message.get("body", b"") for message in messages))
            values = None
            hold = mode["hold"]
            if hold and body.get("action") == hold["operation"] and not hold["ready"] and hold["id"] == body.get("decision_id"):
                hold["ready"] = True
                await hold["event"].wait()
                if hold["fail"]:return await JSONResponse({"error": "fixture failed old status"}, status_code=503)(scope, receive, send)
            if loss:
                mode["loss"] = None
                return await JSONResponse({"error": "fixture response unavailable", "saved": None}, status_code=503)(scope, receive, send)
            for message in messages:
                await send(message)

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    (run / "port").write_text(str(sock.getsockname()[1]))
    uvicorn.Server(uvicorn.Config(Observe(), log_level="warning")).run(sockets=[sock])


if __name__ == "__main__":
    main()
