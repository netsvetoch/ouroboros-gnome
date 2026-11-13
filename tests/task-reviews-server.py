def main():
    """Real review ledger/history/source handlers with isolated storage."""
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
    os.environ.update({"OUROBOROS_APP_ROOT": str(run), "OUROBOROS_DATA_DIR": str(run / "data"),
                       "OUROBOROS_REPO_DIR": str(run / "repo"), "OUROBOROS_SETTINGS_PATH": str(run / "data/settings.json")})
    data, repo = run / "data", run / "repo"
    for directory in (data / "logs", data / "memory", repo):
        directory.mkdir(parents=True, exist_ok=True)
    (data / "logs/chat.jsonl").write_text("")
    (data / "logs/progress.jsonl").write_text("")

    from ouroboros import config, store_import
    from ouroboros.settings_setup_contract import SECRET_SETTING_KEYS
    for key in SECRET_SETTING_KEYS:
        os.environ.pop(key, None)
    config.initialize_runtime_mode_baseline("light")
    config.SETTINGS_PATH.write_text(json.dumps({"OUROBOROS_SUBAGENTS": '{"enabled":false,"items":[]}',
        "OUROBOROS_SUBAGENTS_MODE": "off", "TOTAL_BUDGET": 0}))
    store_import.ensure_current_store(data)
    from ouroboros.usage_store import migrate_from_journal
    migrate_from_journal(data)
    from supervisor import queue, workers
    queue.init(data)
    queue.init_queue_refs(workers.PENDING, workers.RUNNING, workers.QUEUE_SEQ_COUNTER_REF)
    workers.WORKERS = {0: SimpleNamespace(busy_task_id=None, reaping=False)}
    workers._WORKER_POOL_DISABLED_REASON = ""

    queue.publish_queue_snapshot(reason='review_fixture')
    from ouroboros import review_ledger as ledger
    from ouroboros.task_results import write_task_result
    from ouroboros.artifacts import task_artifact_dir_path
    from ouroboros.observability import redact_projection
    records = []
    normal = 'Полное заключение <&>\n' + 'Длинная строка ревью.\n' * 1200 + 'TAIL-GNOME-REVIEW'
    secret = 'sk-ant-api03-' + 'A1b2C3d4E5f6G7h8' * 4
    for index in range(22):
        findings = [dict(item='Неограниченный повтор <&>', verdict='FAIL', severity='critical', reason='Повторяется бесконечно',
                         evidence='Наблюдение GNOME', recommendation='Ограничить число повторов')]
        findings += [dict(item='Дополнительное замечание '+str(n), verdict='FAIL', severity='advisory') for n in range(11)]
        answer = dict(status='responded', verdict='FAIL', findings=findings, critical=1, coverage='full')
        raw = dict(slot_id='sol', model_id='fixture/reviewer', status='responded', parts=['change'], answers={'change': answer})
        record = ledger.build_commit_gate_record(dict(task_id='review-root', root_task_id='review-root',
            enforcement='blocking', enforcement_blocks=True, composition='composed', chosen_by='author',
            composition_reason='Проверка состава <&>', triad_raw=[raw, dict(slot_id='critic', status='error', parts=['change'],
                operation_state='provider_refused',failure_code='fixture_capacity',http_status=429,reset_at='2026-11-13T08:00:00Z',
                reported_cause='Capacity <&> exhausted',failure_details={'retry_after_seconds':120,'provider_message':'Capacity '+secret})],
            slot_executions={'sol':{'ts':'2026-01-01T00:00:01Z','effective':{'route':'api_chat','model':'fixture/reviewer'}}},
            structured={'rows':[dict(slot_id='sol', model='fixture/reviewer', route='api_chat', parts=['change']),
                                dict(slot_id='critic', model='fixture/requested', route='api_chat', parts=['change'], additional=True)], 'started_ts':'2026-01-01T00:00:00Z'},
            binding={'tree_sha':'a'*40, 'parents':['b'*40], 'diff_sha256':'c'*64}))
        body = normal if index != 21 else 'Отказ провайдера '+secret+' REDACTED-TAIL'
        source = ledger.retain_text_source(data, 'review-root', record_id=record.record_id, seat_id='sol', role='response', part='change', text=body)
        record.rows[0]['source_refs'].append(source)
        saved = ledger.write_record(data, record)
        records.append(dict(id=saved['record_id'], source=source, body=body, public=str(redact_projection(body).value)))
    # The real history projection must disclose a broken neighbor, without hiding healthy records.
    ledger.record_path(data, records[1]['id']).unlink()
    write_task_result(data, 'review-root', 'completed', result='Готово')

    from ouroboros import plan_record as plan
    write_task_result(data, 'plan-root', 'running')
    plan.append_revision(data, 'plan-root', plan.compose_revision(None, goal='Цель GNOME <&>', plan='План действий',
        done_when=[dict(id='done', claim='Получить результат', support='Проверка API')], affected_paths=['example.txt']), body=False)
    plan_text = 'Полный ответ участника плана <&>\n' + 'Подробности плана\n' * 500 + 'PLAN-TAIL'
    plan_source = ledger.retain_text_source(data, 'plan-root', record_id='plan-ask', seat_id='participant', role='response', part='intention', text=plan_text)
    plan.append_ask(data, 'plan-root', dict(ask_id='plan-ask', revision=1, ts='2026-01-01T00:00:00Z',
        message='Проверить план', participants=[dict(seat_id='participant', model='fixture/plan', status='answered',
            owner_marked=True, dispatched=True, reply=dict(prose='Краткий ответ', objections=[], withdrawn=[]), reply_ref=plan_source,
            executions=[{'kind':'api','model':'fixture/api-observed'}],execution={'kind':'harness','harness_id':'fixture-cli','model':'fixture/plan-observed'}),
            dict(seat_id='plan-failed',model='fixture/plan-requested',status='failed',failure_code='fixture_plan_capacity',http_status=503,
                reported_cause='Plan provider unavailable <&>',failure_details={'phase':'plan <&>','provider_message':secret})]))
    write_task_result(data, 'plan-root', 'completed', result='План сохранён')
    write_task_result(data, 'plan-objection-root', 'running')
    plan.append_revision(data, 'plan-objection-root', plan.compose_revision(None, goal='Objection fixture', plan='Read objections',
        done_when=[dict(id='proof',claim='Inspect native facts',support='Fixture API')],affected_paths=[]),body=False)
    plan.append_ask(data, 'plan-objection-root',dict(ask_id='raise',revision=1,ts='2026-01-01T00:00:00Z',message='Inspect',participants=[
        dict(seat_id='owner-seat',model='fixture/owner',status='answered',owner_marked=True,reply=dict(prose='Owner seat',objections=[{'id':'risk','text':'Owner-marked risk <&>'}],withdrawn=[])),
        dict(seat_id='advisor-seat',model='fixture/advisor',status='answered',owner_marked=False,reply=dict(prose='Advisor',objections=[{'id':'advice','text':'Advisory concern <&>'}],withdrawn=[]))]))
    write_task_result(data, 'plan-objection-root', 'completed',result='Completed with disclosed observations')

    from ouroboros.skill_review_history import review_history_path, review_history_detail
    skill = 'weather'
    legacy_path = review_history_path(data, skill)
    legacy_path.parent.mkdir(parents=True, exist_ok=True)
    legacy_path.write_text(json.dumps(dict(job_id='legacy-job', task_id='skill-owner', status='clean', job_status='completed',
        content_hash='a'*64, raw_actor_records=[dict(slot_id='legacy-seat', model_id='fixture/legacy', status='responded',
        parsed_items=[dict(item='Сохранённое замечание <&>', verdict='PASS')])]))+'\n')
    skill_record = ledger.build_wave_record(dict(task_id='skill-physical', root_task_id='skill-physical',
        enforcement='blocking', enforcement_blocks=False,
        triad_raw=[dict(slot_id='skill-seat', model_id='fixture/skill', status='responded', parts=['skill'],
            answers={'skill': dict(status='responded', verdict='PASS', findings=[], critical=0, coverage='complete')})],
        structured={'rows':[dict(slot_id='skill-seat', model='fixture/skill', route='api_chat', parts=['skill'])], 'started_ts':'2026-01-01T00:00:00Z'},
        binding={'tree_sha':'d'*40, 'parents':[], 'diff_sha256':'e'*64}), surface='skill', drive_root=data)
    skill_record.subject.update(kind='skill', skill=skill)
    skill_record.brief['skill'] = dict(job_id='ledger-job', origin_task_id='skill-owner', status='clean', job_status='completed', content_hash='d'*64)
    saved_skill = ledger.write_record(data, skill_record)
    skill_exports = [dict(id=job, text=review_history_detail(data, skill, job, task_id='skill-owner')['markdown'])
                     for job in ['legacy-job', saved_skill['record_id']]]

    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    from ouroboros.gateway.router import collect_routes
    async def facts(request):
        return JSONResponse(dict(records=records, normal=normal, secret=secret, plan_text=plan_text, plan_source=plan_source, skill_exports=skill_exports))
    async def mutate(request):
        selected = records[0]
        path = task_artifact_dir_path(data, 'review-root', create=False) / selected['source']['ref']['path']
        path.write_text('Изменённый исходник')
        return JSONResponse({'ok': True})
    async def change_plan(request):
        replacement = ledger.retain_text_source(data, 'plan-root', record_id='plan-ask', seat_id='participant', role='response', text='Новый ответ')
        plan.update_participant(data, 'plan-root', ask_id='plan-ask', seat_id='participant', facts=dict(reply_ref=replacement))
        return JSONResponse({'ok': True})
    async def objection(request):
        action=(await request.json())['action']
        seat='advisor-seat' if action=='withdraw-advisor' else 'owner-seat'
        withdrawn=[] if action=='silence' else [{'id':'advice' if seat=='advisor-seat' else 'risk','why':'Resolved <&>'}]
        plan.append_ask(data,'plan-objection-root',dict(ask_id=action,revision=1,ts='2026-01-02T00:00:00Z',message=action,
            participants=[dict(seat_id=seat,model='fixture/model',status='answered',owner_marked=seat=='owner-seat',
                reply=dict(prose='Next observation',objections=[],withdrawn=withdrawn))]))
        return JSONResponse({'ok':True})
    app = Starlette(routes=[Route('/fixture/facts', facts), Route('/fixture/tamper', mutate, methods=['POST']),
        Route('/fixture/change-plan', change_plan, methods=['POST']), Route('/fixture/objection',objection,methods=['POST']), *collect_routes(data_dir=data)])
    app.state.drive_root = data
    app.state.repo_dir = repo
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    (run / 'port').write_text(str(sock.getsockname()[1]))
    uvicorn.Server(uvicorn.Config(app, log_level='warning')).run(sockets=[sock])


if __name__ == '__main__':
    main()
