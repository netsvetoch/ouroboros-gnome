#!/bin/sh
set -eu
skill_updates_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
skill_updates_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$skill_updates_reference/VERSION")" = '7.10.0'
skill_updates_run=$(mktemp -d /tmp/ouroboros-skill-updates.XXXXXX)
echo "Logs at $skill_updates_run"
skill_updates_display=$((1000 + $$ % 20000))
PYTHONPATH="$skill_updates_reference${PYTHONPATH:+:$PYTHONPATH}" "$skill_updates_python" tests/skill-updates-server.py "$skill_updates_run" >"$skill_updates_run/server.log" 2>&1 &
skill_updates_pid=$!
cleanup_skill_updates() {
 if test -s "$skill_updates_run/port"; then
  "$skill_updates_python" - "$skill_updates_run/port" <<'PY'
import pathlib, sys, urllib.request
try:
    port=pathlib.Path(sys.argv[1]).read_text().strip()
    request=urllib.request.Request('http://127.0.0.1:'+port+'/fixture/control', data=b'{"action":"release-all"}', headers={'Content-Type':'application/json'})
    urllib.request.urlopen(request, timeout=2).close()
except Exception:
    pass
PY
 fi
 kill "$skill_updates_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$skill_updates_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$skill_updates_pid" 2>/dev/null; then kill -KILL "$skill_updates_pid" 2>/dev/null || true; fi
 wait "$skill_updates_pid" 2>/dev/null || true
}
trap cleanup_skill_updates EXIT
for i in $(seq 1 100); do test -s "$skill_updates_run/port" && break; sleep .1; done
test -s "$skill_updates_run/port" || { cat "$skill_updates_run/server.log"; exit 1; }
skill_updates_url="http://127.0.0.1:$(cat "$skill_updates_run/port")"
run_skill_updates_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/skill-updates-gjs.js "$skill_updates_run/client.js"
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$skill_updates_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$skill_updates_run":rw --env=XDG_STATE_HOME="$skill_updates_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$skill_updates_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$skill_updates_url" "$skill_updates_run"
 else
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$skill_updates_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$skill_updates_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/skill-updates-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$skill_updates_url" "$skill_updates_run"
 fi
}
run_skill_updates_client >"$skill_updates_run/client.log" 2>&1 || { tail -35 "$skill_updates_run/client.log"; tail -25 "$skill_updates_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$skill_updates_run/client.log"; then
 echo 'FAIL: Skill updates runtime error'; tail -30 "$skill_updates_run/client.log"; exit 1
fi
rg '^OK:' "$skill_updates_run/client.log"
