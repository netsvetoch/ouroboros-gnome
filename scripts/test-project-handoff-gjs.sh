#!/bin/sh
set -eu
project_handoff_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
project_handoff_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$project_handoff_reference/VERSION")" = '7.10.0'
project_handoff_run=$(mktemp -d /tmp/ouroboros-project-handoff.XXXXXX)
echo "Logs at $project_handoff_run"
project_handoff_display=$((1000 + $$ % 20000))
PYTHONPATH="$project_handoff_reference${PYTHONPATH:+:$PYTHONPATH}" "$project_handoff_python" tests/project-handoff-server.py "$project_handoff_run" >"$project_handoff_run/server.log" 2>&1 &
project_handoff_pid=$!
cleanup_project_handoff() {
 if test -s "$project_handoff_run/port"; then
  "$project_handoff_python" - "$project_handoff_run/port" <<'PY'
import pathlib, sys, urllib.request
try:
    port=pathlib.Path(sys.argv[1]).read_text().strip()
    request=urllib.request.Request('http://127.0.0.1:'+port+'/fixture/control', data=b'{"action":"release-all"}', headers={'Content-Type':'application/json'})
    urllib.request.urlopen(request, timeout=2).close()
except Exception:
    pass
PY
 fi
 kill "$project_handoff_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$project_handoff_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$project_handoff_pid" 2>/dev/null; then kill -KILL "$project_handoff_pid" 2>/dev/null || true; fi
 wait "$project_handoff_pid" 2>/dev/null || true
}
trap cleanup_project_handoff EXIT
for i in $(seq 1 100); do test -s "$project_handoff_run/port" && break; sleep .1; done
test -s "$project_handoff_run/port" || { cat "$project_handoff_run/server.log"; exit 1; }
project_handoff_url="http://127.0.0.1:$(cat "$project_handoff_run/port")"
run_project_handoff_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/project-handoff-gjs.js "$project_handoff_run/client.js"
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$project_handoff_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$project_handoff_run":rw --env=XDG_STATE_HOME="$project_handoff_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$project_handoff_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$project_handoff_url" "$project_handoff_run"
 else
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$project_handoff_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$project_handoff_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/project-handoff-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$project_handoff_url" "$project_handoff_run"
 fi
}
run_project_handoff_client >"$project_handoff_run/client.log" 2>&1 || { tail -35 "$project_handoff_run/client.log"; tail -25 "$project_handoff_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$project_handoff_run/client.log"; then
 echo 'FAIL: project handoff runtime error'; tail -30 "$project_handoff_run/client.log"; exit 1
fi
rg '^OK:' "$project_handoff_run/client.log"
