def main():
    """Real quiz publication, census, decisions and mail; queued authors never execute."""
    import asyncio
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
    from ouroboros import config, store_import, owner_quiz
    from ouroboros.settings_setup_contract import SECRET_SETTING_KEYS
    for key in SECRET_SETTING_KEYS:
        os.environ.pop(key, None)
    config.initialize_runtime_mode_baseline("light")
    config.SETTINGS_PATH.write_text(json.dumps({"OUROBOROS_SUBAGENTS": '{"enabled":false,"items":[]}',
        "OUROBOROS_SUBAGENTS_MODE": "off", "TOTAL_BUDGET": 0}))
    store_import.ensure_current_store(data)
    from ouroboros.usage_store import migrate_from_journal
    migrate_from_journal(data)
    from supervisor import queue, workers, state, message_bus, queue_schedules
    state.init(data)
    queue.init(data)
    queue.init_queue_refs(workers.PENDING, workers.RUNNING, workers.QUEUE_SEQ_COUNTER_REF)
    workers.WORKERS = {0: SimpleNamespace(busy_task_id=None, reaping=False)}
    workers._WORKER_POOL_DISABLED_REASON = ""
    from ouroboros.task_results import write_task_result
    from ouroboros.projects_registry import create_project
    from ouroboros.owner_mailbox import drain_owner_entries, acknowledge_transcript_entry
    project = create_project(data, "question-project", name="Проект вопросов <&>")
    bridge = message_bus.LocalChatBridge()
    frames = []
    bridge._broadcast_fn = frames.append
    message_bus.DATA_DIR, message_bus._BRIDGE = data, bridge
    tasks = {"main-asker": 1, "project-asker": project["chat_id"], "late-asker": 1}
    for task, chat in tasks.items():
        write_task_result(data, task, "completed" if task == "late-asker" else "scheduled", chat_id=chat)
        if task != "late-asker":
            workers.PENDING.append(dict(id=task, type="task", chat_id=chat, root_task_id=task,
                _attempt=1, drive_root=str(data)))
    queue.publish_queue_snapshot(reason="questions_fixture")
    quizzes = {"main-asker": ["verbatim", "retry", "close", "scope", "limits", "race", "settle-race"],
               "project-asker": ["project"], "late-asker": ["late", "unknown"]}
    for task, ids in quizzes.items():
        for qid in ids:
            block = owner_quiz.record_asked(data, task, quiz_id=qid, chat_id=tasks[task],
                question=f"Вопрос {qid} <&>?", options=["Первый <&>", "Второй"],
                option_details=["Цена и польза первого", "Цена и польза второго"], recommended_index=1,
                stake="Последствия выбора <&>", assumption="До ответа продолжаю исследование",
                host_facts="Факты шлюза <&>")
            ok, detail = bridge.send_quiz(tasks[task], qid, block["question"], [
                {"label": "Первый <&>", "detail": block["option_details"][0]},
                {"label": "Второй", "detail": block["option_details"][1], "recommended": True}],
                stake=block["stake"], assumption=block["assumption"], task_id=task,
                host_facts=block["host_facts"])
            assert ok, detail
    owner_quiz.reconcile_terminal(data, "late-asker")
    owner_quiz.record_answered(data, "late-asker", quiz_id="unknown", option_index=0,
        request_id="fixture-unknown", comment="Сохранённый ответ", allow_expired=True)
    owner_quiz.record_quiz_delivery_failure(data, "late-asker", "unknown", "late_answer_delivery_unknown")

    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route, WebSocketRoute
    from ouroboros.gateway.router import collect_routes
    audit = []
    i18n_audit = []
    loss = {"id": "", "before": False}

    async def facts(request):
        accepted = message_bus.accepted_chat_message(data, 1, "quiz_late_answer:late-asker:late")
        return JSONResponse(dict(notice_connections=notice_connections, notice_peers=len(notice_peers), material_reads=material_reads, material_refs=material_refs, project=project, audit=audit, i18n_audit=i18n_audit, frames=frames,
            quizzes={task: owner_quiz.quiz_states(data, task) for task in tasks},
            mail={task: drain_owner_entries(data, task, set()) for task in tasks},
            inbox=list(bridge._inbox.queue), reminders=queue_schedules.load_schedule_store(data), accepted_late={key: accepted.get(key) for key in
                ("text", "client_message_id", "ingress_accepted")} if accepted else None))

    async def wait_control(request):
        body=await request.json()
        from ouroboros.owner_wait import set_owner_wait, announce_wait_ended
        from ouroboros.project_dialogue import owner_wait_projection, question_status
        task='wait-asker';qid='required';chat=project['chat_id']
        if body['action']=='seed':
            tasks[task]=chat
            write_task_result(data,task,'scheduled',chat_id=chat,project_id=project['id'],root_task_id=task)
            workers.PENDING.append(dict(id=task,type='task',chat_id=chat,project_id=project['id'],root_task_id=task,_attempt=1,drive_root=str(data)))
            block=owner_quiz.record_asked(data,task,quiz_id=qid,chat_id=chat,question='Required wait <&>',options=['First','Second'],wait_for_answer=True)
            set_owner_wait(data,task,{'wait_id':'fixture-wait','quiz_id':qid,'state':'waiting'})
            ok,detail=bridge.send_quiz(chat,qid,block['question'],block['options'],task_id=task,wait_for_answer=True)
            assert ok,detail
        elif body['action'] in ('resume','resume-record'):
            set_owner_wait(data,task,lambda old:{**old,'state':'resumed','resume_reason':body.get('reason','timeout')})
            if body['action']=='resume':announce_wait_ended(data,task,qid,chat)
        elif body['action']=='move':
            set_owner_wait(data,task,{'wait_id':'another-wait','quiz_id':'another','state':'waiting'})
        elif body['action']=='terminal':
            write_task_result(data,task,'completed',chat_id=chat,project_id=project['id'],result='Prepared terminal wait owner')
            owner_quiz.reconcile_terminal(data,task)
        request.app.state.state_publication=None
        queue.publish_queue_snapshot(reason='fixture_question_wait')
        from ouroboros.task_results import load_task_result
        doc=load_task_result(data,task);block=owner_quiz.quiz_states(data,task)[qid]
        cases=json.loads((pathlib.Path(__import__('ouroboros').__file__).parent.parent/'web/tests/fixtures/question_presentation_parity.json').read_text())
        from ouroboros.project_dialogue import project_question_pointer
        for case in cases:
            parity_block={'quiz_id':'q',**case['block']} if case['block'] is not None else None
            wait={'quiz_id':'q',**case['owner_wait']} if case['owner_wait'] is not None else None
            pointer=project_question_pointer({'task_id':'task','text':'Which?','quiz':{'quiz_id':'q','wait_for_answer':True,'options':['a','b']}},
                parity_block,{'id':'p','chat_id':12,'name':'Project'},wait)
            case['actual_row']=pointer
            case['actual_status']=pointer['text'].removesuffix(' in Project')
        return JSONResponse({'ok':True,'task_id':task,'quiz_id':qid,'chat_id':chat,'block':block,'owner_wait':doc.get('owner_wait'),'parity':cases})

    material_reads = []
    material_fault = {"mode": ""}
    material_release = asyncio.Event()
    material_refs = []

    async def materials_setup(request):
        import base64
        import io
        import wave
        from ouroboros.artifacts import store_task_artifact_bytes
        from ouroboros.tools.core_artifacts import _question_materials
        wav = io.BytesIO()
        with wave.open(wav, "wb") as sound:
            sound.setnchannels(1); sound.setsampwidth(2); sound.setframerate(8000)
            sound.writeframes(b"\x00\x00" * 800)
        payloads = {"brief <&> Ω.txt": "Private question material <&> Ω\nRetained evidence, not an answer".encode(),
            "photo.png": base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"),
            "document.pdf": (pathlib.Path(__file__).parent / "fixtures/native-preview.pdf").read_bytes(),
            "voice.wav": wav.getvalue(), "large.bin": bytes(range(256)) * 5000,
            "clip.webm": (pathlib.Path(__file__).parent / "fixtures/question-material.webm").read_bytes()}
        for name, payload in payloads.items():
            store_task_artifact_bytes(data, "main-asker", name=name, data=payload)
        material_refs[:] = _question_materials(SimpleNamespace(drive_root=data, task_id="main-asker"), data,
            "main-asker", [{"name": name} for name in payloads])
        block = owner_quiz.record_asked(data, "main-asker", quiz_id="materials", chat_id=1,
            question="Inspect the retained evidence before choosing", options=["Accept", "Decline"],
            materials=material_refs, wait_for_answer=True)
        ok, detail = bridge.send_quiz(1, "materials", block["question"], [{"label":"Accept"}, {"label":"Decline"}],
            task_id="main-asker")
        assert ok, detail
        return JSONResponse({"ok": True, "materials": material_refs})

    async def materials_control(request):
        body = await request.json()
        material_fault["mode"] = body.get("mode", "")
        if body.get("release"): material_release.set()
        else: material_release.clear()
        return JSONResponse({"ok":True, "reads":material_reads})

    async def model_close(request):
        body = await request.json()
        outcome = owner_quiz.record_closed(data, 'main-asker', quiz_id='scope', reason=body['reason'],
            actor_task_id='main-asker', actor='model', request_id='fixture-model-closure')
        return JSONResponse(outcome)

    notice_peers = set()
    notice_connections = {'count':0}
    notice_frames = []
    spoken_hosts = {}
    async def spoken_control(request):
        from ouroboros.live_conversation import ConversationHost
        body=await request.json();chat=project['chat_id'] if body.get('project') else 1
        host=spoken_hosts.get(chat)
        if host is None:
            host=SimpleNamespace(_rows_lock=asyncio.Lock(),_tools_lock=asyncio.Lock(),captioned={},messages=[],
                ctx=SimpleNamespace(drive_root=data,task_id='project-asker' if body.get('project') else 'main-asker'),
                turn=SimpleNamespace(spec=SimpleNamespace(call_id='fixture-call-'+str(chat),chat_id=chat,presence_binding_id='')),
                _context_changed=lambda:None)
            spoken_hosts[chat]=host
        state=body.get('state','generated')
        await ConversationHost.caption(host,'ouroboros',body.get('text','Synthetic call speech <&> Ω'),body['item'],
            played_ms=body.get('played_ms',0),interrupted=state=='interrupted',completed=state=='played',replace=body.get('replace',False))
        return JSONResponse({'ok':True,'stored_items':list(host.captioned.keys())})

    async def reminder_control(request):
        import datetime
        body=await request.json()
        if body.get('action')=='seed':
            now=datetime.datetime.now(datetime.timezone.utc)
            record={'id':'fixture-notify','kind':'notify','name':'Native reminder <&>','source':'fixture-reminder',
                'enabled':True,'timezone':'UTC','trigger':{'type':'once','run_at':(now-datetime.timedelta(minutes=2)).isoformat()},
                'notification':{'text':body.get('text','Private scheduled reminder <&> Ω'),'set_at':(now-datetime.timedelta(hours=1)).isoformat()}}
            with queue_schedules.schedule_transaction(data):
                store=queue_schedules.load_schedule_store(data)
                store['tasks']=[row for row in store['tasks'] if row.get('id')!=record['id']]+[record]
                queue_schedules._write_scheduled_tasks(store,data)
        await asyncio.to_thread(queue.check_scheduled_tasks)
        return JSONResponse({'ok':True,'store':queue_schedules.load_schedule_store(data)})

    async def notice_control(request):
        body = await request.json()
        if body.get('action') == 'disconnect':
            for peer in list(notice_peers): await peer.close(code=1012)
            return JSONResponse({'ok':True})
        if body.get('action') == 'clear':
            ids = {id(frame) for frame in notice_frames}
            frames[:] = [frame for frame in frames if id(frame) not in ids]
            notice_frames.clear()
            return JSONResponse({'ok':True})
        if 'raw' in body:
            frame = body['raw'];frames.append(frame)
        else:
            meta = {key:body[value] for key,value in [('task_incident','incident'),('toast_once','once'),('toast_tone','tone')] if value in body}
            ok, detail = bridge.send_message(body.get('chat_id',1), body.get('text','Gateway fixture incident'),
                is_progress=True,task_id=body.get('task_id','main-asker'),role='system',progress_meta=meta)
            assert ok,detail
            frame = frames[-1]
        notice_frames.append(frame)
        return JSONResponse({'ok':True,'frame':frame})

    async def contact(request):
        # Deterministic host-held source metadata; connector admission is outside this UI fixture.
        body = await request.json()
        origin = dict(task_id='main-asker', binding_id='fixture-binding', source_event_id='fixture-source',
                      conversation_key='fixture-conversation', label=body['label'], url=body['url'])
        block = owner_quiz.record_asked(data, 'main-asker', quiz_id='contact', chat_id=1,
            question='Private source question <&>?', options=['Yes', 'No'], presence_contact=origin,
            assumption='Continue fixture inspection until the owner answers')
        ok, detail = bridge.send_quiz(1, 'contact', block['question'], [{'label':'Yes'}, {'label':'No'}], task_id='main-asker', assumption=block['assumption'])
        assert ok, detail
        ok, detail = bridge.send_message(1, 'Private source message <&>', task_id='main-asker', progress_meta={'presence_contact':origin})
        assert ok, detail
        # Text bridge delivery is transient; the supervisor's durable dialogue append is separate.
        from ouroboros import dialogue_store
        dialogue_store.append(data, 'chat', dict(direction='out', chat_id=1, user_id=1,
            text='Private source message <&>', ts=frames[-1]['ts'], task_id='main-asker', presence_contact=origin),
            emit_live=False, feed=True)
        return JSONResponse({'ok':True, 'origin':origin})

    async def lose(request):
        body = await request.json()
        loss.update(id=body["id"], before=body.get("before", False))
        return JSONResponse({"ok": True})

    def settle_mail(task, qid):
        entries = [entry for entry in drain_owner_entries(data, task, set())
                   if entry.get("msg_id") == f"quiz_answer:{task}:{qid}"]
        assert len(entries) == 1, entries
        assert acknowledge_transcript_entry(data, task, entries[0])
        block = owner_quiz.quiz_states(data, task).get(qid, {})
        bridge.send_quiz_state(qid, task, "answered", chat_id=tasks[task],
            question_delivery={"kind": "answer", "state": "delivered"})
        return block

    async def read(request):
        body = await request.json()
        block = settle_mail(body["task"], body["quiz"])
        return JSONResponse({"ok": True, "block": block})

    async def ws(peer):
        await peer.accept()
        notice_peers.add(peer);notice_connections['count'] += 1
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
            notice_peers.discard(peer)
            sender.cancel()
            try:
                await sender
            except asyncio.CancelledError:
                pass

    routes = [route for route in collect_routes(data_dir=data) if getattr(route, "path", "") != "/ws"]
    app = Starlette(routes=[Route("/fixture/facts", facts), Route("/fixture/question-wait", wait_control, methods=["POST"]), Route("/fixture/spoken", spoken_control, methods=["POST"]), Route("/fixture/reminder", reminder_control, methods=["POST"]), Route("/fixture/notice", notice_control, methods=["POST"]), Route("/fixture/materials", materials_setup, methods=["POST"]), Route("/fixture/materials-control", materials_control, methods=["POST"]), Route("/fixture/model-close", model_close, methods=["POST"]), Route("/fixture/lose", lose, methods=["POST"]), Route('/fixture/contact', contact, methods=['POST']),
        Route("/fixture/read", read, methods=["POST"]), WebSocketRoute("/ws", ws), *routes])
    app.state.drive_root, app.state.repo_dir = data, repo

    class Observe:
        async def __call__(self, scope, receive, send):
            if scope['type'] == 'http' and '/artifacts/' in scope['path']:
                messages = []
                async def capture_material(message): messages.append(message)
                await app(scope, receive, capture_material)
                record = {"path": scope['path'], "query": scope.get('query_string', b'').decode(), "status": messages[0]['status'], "mode": material_fault["mode"]}
                material_reads.append(record)
                if record['mode'] == 'hold': await material_release.wait()
                body = b''.join(message.get('body', b'') for message in messages)
                if record['mode'] == 'tamper' and messages[0]['status'] == 200:
                    body = bytes([body[0] ^ 1]) + body[1:]
                await send(messages[0])
                await send({'type':'http.response.body', 'body':body})
                return
            if scope['type']=='http' and scope['path']=='/api/ui/i18n/missing':
                parts=bytearray()
                async def capture():
                    message=await receive();parts.extend(message.get('body',b''));return message
                await app(scope,capture,send)
                i18n_audit.append(json.loads(parts))
                return
            if scope["type"] != "http" or scope["path"] != "/api/decisions":
                return await app(scope, receive, send)
            parts = bytearray()

            async def input():
                message = await receive()
                parts.extend(message.get("body", b""))
                return message

            # Buffer the request so a refused-before-admission response runs no writer.
            more = True
            while more:
                message = await input()
                more = message.get("more_body", False)
            body = json.loads(parts)
            lost = loss["id"] == body.get("decision_id")
            record = {"body": body, "lost": lost, "before": lost and loss["before"]}
            audit.append(record)
            if record["before"]:
                loss["id"] = ""
                return await JSONResponse({"error": "fixture unavailable before writer"}, status_code=503)(scope, receive, send)

            async def replay():
                return {"type": "http.request", "body": bytes(parts), "more_body": False}

            messages = []

            async def output(message):
                messages.append(message)

            await app(scope, replay, output)
            record["status"] = messages[0]["status"]
            response = b"".join(message.get("body", b"") for message in messages)
            record["reply"] = json.loads(response)
            if body.get("decision_id") == "quiz:main-asker:settle-race" and record["status"] == 200:
                # The HTTP receipt was built before a real recipient read. Let the
                # newer bridge frame reach the UI before releasing that older receipt.
                settle_mail("main-asker", "settle-race")
                await asyncio.sleep(0.2)
            if lost:
                loss["id"] = ""
                return await JSONResponse({"error": "fixture unavailable after writer"}, status_code=503)(scope, receive, send)
            for message in messages:
                await send(message)

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    (run / "port").write_text(str(sock.getsockname()[1]))
    uvicorn.Server(uvicorn.Config(Observe(), log_level="warning")).run(sockets=[sock])


if __name__ == "__main__":
    main()
