#!/bin/sh
set -eu
resume_unknown_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
resume_unknown_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$resume_unknown_reference/VERSION")" = '7.10.0'
resume_unknown_run=$(mktemp -d /tmp/ouroboros-task-resume-unknown.XXXXXX)
echo "Logs at $resume_unknown_run"
resume_unknown_display=$((1000 + $$ % 20000))
PYTHONPATH="$resume_unknown_reference${PYTHONPATH:+:$PYTHONPATH}" "$resume_unknown_python" tests/task-resume-unknown-server.py "$resume_unknown_run" >"$resume_unknown_run/server.log" 2>&1 &
resume_unknown_pid=$!
cleanup_resume_unknown() {
 if test -s "$resume_unknown_run/port"; then
  "$resume_unknown_python" - "$resume_unknown_run/port" <<'PY_RELEASE'
import pathlib,sys,urllib.request
try:
    port=pathlib.Path(sys.argv[1]).read_text().strip()
    request=urllib.request.Request('http://127.0.0.1:'+port+'/fixture/control',data=b'{"mode":""}',headers={'Content-Type':'application/json'})
    urllib.request.urlopen(request,timeout=2).close()
except Exception:
    pass
PY_RELEASE
 fi
 kill "$resume_unknown_pid" 2>/dev/null || true
 for i in $(seq 1 30); do kill -0 "$resume_unknown_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$resume_unknown_pid" 2>/dev/null; then kill -KILL "$resume_unknown_pid" 2>/dev/null || true; fi
 wait "$resume_unknown_pid" 2>/dev/null || true
}
trap cleanup_resume_unknown EXIT
for i in $(seq 1 100); do test -s "$resume_unknown_run/port" && break; sleep .1; done
test -s "$resume_unknown_run/port" || { cat "$resume_unknown_run/server.log"; exit 1; }
resume_unknown_url="http://127.0.0.1:$(cat "$resume_unknown_run/port")"
run_resume_unknown_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/task-resume-unknown-gjs.js "$resume_unknown_run/client.js"
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$resume_unknown_display" -s '-screen 0 1280x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$resume_unknown_run":rw --env=XDG_STATE_HOME="$resume_unknown_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$resume_unknown_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$resume_unknown_url" "$resume_unknown_run"
 else
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$resume_unknown_display" -s '-screen 0 1280x1000x24' env XDG_STATE_HOME="$resume_unknown_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/task-resume-unknown-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$resume_unknown_url" "$resume_unknown_run"
 fi
}
run_resume_unknown_client >"$resume_unknown_run/client.log" 2>&1 || { tail -35 "$resume_unknown_run/client.log"; tail -25 "$resume_unknown_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$resume_unknown_run/client.log"; then
 echo 'FAIL: Resume unknown-outcome runtime error'; tail -30 "$resume_unknown_run/client.log"; exit 1
fi
rg '^OK:' "$resume_unknown_run/client.log"
