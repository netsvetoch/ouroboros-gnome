#!/bin/sh
set -eu
skill_handoff_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
skill_handoff_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$skill_handoff_reference/VERSION")" = '7.10.0'
skill_handoff_run=$(mktemp -d /tmp/ouroboros-skill-handoff.XXXXXX)
echo "Logs at $skill_handoff_run"
skill_handoff_display=$((1000 + $$ % 20000))
PYTHONPATH="$skill_handoff_reference${PYTHONPATH:+:$PYTHONPATH}" "$skill_handoff_python" tests/skill-catalog-server.py "$skill_handoff_run" >"$skill_handoff_run/server.log" 2>&1 &
skill_handoff_pid=$!
cleanup_skill_handoff() {
 if test -s "$skill_handoff_run/port"; then
  "$skill_handoff_python" - "$skill_handoff_run/port" <<'PY'
import pathlib, sys, urllib.request
try:
    port=pathlib.Path(sys.argv[1]).read_text().strip()
    request=urllib.request.Request('http://127.0.0.1:'+port+'/fixture/control', data=b'{"action":"release-all"}', headers={'Content-Type':'application/json'})
    urllib.request.urlopen(request, timeout=2).close()
except Exception:
    pass
PY
 fi
 kill "$skill_handoff_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$skill_handoff_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$skill_handoff_pid" 2>/dev/null; then kill -KILL "$skill_handoff_pid" 2>/dev/null || true; fi
 wait "$skill_handoff_pid" 2>/dev/null || true
}
trap cleanup_skill_handoff EXIT
for i in $(seq 1 100); do test -s "$skill_handoff_run/port" && break; sleep .1; done
test -s "$skill_handoff_run/port" || { cat "$skill_handoff_run/server.log"; exit 1; }
skill_handoff_url="http://127.0.0.1:$(cat "$skill_handoff_run/port")"
run_skill_handoff_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/skill-handoff-gjs.js "$skill_handoff_run/client.js"
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$skill_handoff_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$skill_handoff_run":rw --env=XDG_STATE_HOME="$skill_handoff_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$skill_handoff_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$skill_handoff_url" "$skill_handoff_run"
 else
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$skill_handoff_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$skill_handoff_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/skill-handoff-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$skill_handoff_url" "$skill_handoff_run"
 fi
}
run_skill_handoff_client >"$skill_handoff_run/client.log" 2>&1 || { tail -35 "$skill_handoff_run/client.log"; tail -25 "$skill_handoff_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$skill_handoff_run/client.log"; then
 echo 'FAIL: Skill handoff runtime error'; tail -30 "$skill_handoff_run/client.log"; exit 1
fi
rg '^OK:' "$skill_handoff_run/client.log"
