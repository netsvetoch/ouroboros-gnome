#!/bin/sh
set -eu
task_artifacts_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
task_artifacts_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$task_artifacts_reference/VERSION")" = '7.10.0'
task_artifacts_run=$(mktemp -d /tmp/ouroboros-task-artifact-detail.XXXXXX)
echo "Logs at $task_artifacts_run"
task_artifacts_display=$((1000 + $$ % 20000))
PYTHONPATH="$task_artifacts_reference${PYTHONPATH:+:$PYTHONPATH}" "$task_artifacts_python" tests/task-artifacts-server.py "$task_artifacts_run" >"$task_artifacts_run/server.log" 2>&1 &
task_artifacts_pid=$!
cleanup_task_artifacts() {
 if test -s "$task_artifacts_run/port"; then
  "$task_artifacts_python" - "$task_artifacts_run/port" <<'PY'
import pathlib, sys, urllib.request
try:
    port=pathlib.Path(sys.argv[1]).read_text().strip()
    request=urllib.request.Request('http://127.0.0.1:'+port+'/fixture/control', data=b'{"action":"release-all"}', headers={'Content-Type':'application/json'})
    urllib.request.urlopen(request, timeout=2).close()
except Exception:
    pass
PY
 fi
 kill "$task_artifacts_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$task_artifacts_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$task_artifacts_pid" 2>/dev/null; then kill -KILL "$task_artifacts_pid" 2>/dev/null || true; fi
 wait "$task_artifacts_pid" 2>/dev/null || true
}
trap cleanup_task_artifacts EXIT
for i in $(seq 1 100); do test -s "$task_artifacts_run/port" && break; sleep .1; done
test -s "$task_artifacts_run/port" || { cat "$task_artifacts_run/server.log"; exit 1; }
task_artifacts_url="http://127.0.0.1:$(cat "$task_artifacts_run/port")"
run_task_artifacts_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/task-artifact-detail-gjs.js "$task_artifacts_run/client.js"
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$task_artifacts_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$task_artifacts_run":rw --env=XDG_STATE_HOME="$task_artifacts_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$task_artifacts_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$task_artifacts_url" "$task_artifacts_run"
 else
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$task_artifacts_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$task_artifacts_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/task-artifact-detail-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$task_artifacts_url" "$task_artifacts_run"
 fi
}
run_task_artifacts_client >"$task_artifacts_run/client.log" 2>&1 || { tail -35 "$task_artifacts_run/client.log"; tail -25 "$task_artifacts_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$task_artifacts_run/client.log"; then
 echo 'FAIL: task-artifacts runtime error'; tail -30 "$task_artifacts_run/client.log"; exit 1
fi
rg '^OK:' "$task_artifacts_run/client.log"
