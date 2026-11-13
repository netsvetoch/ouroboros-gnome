#!/bin/sh
set -eu
skill_registry_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
skill_registry_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$skill_registry_reference/VERSION")" = '7.10.0'
skill_registry_run=$(mktemp -d /tmp/ouroboros-skill-registry.XXXXXX)
echo "Logs at $skill_registry_run"
skill_registry_display=$((1000 + $$ % 20000))
PYTHONPATH="$skill_registry_reference${PYTHONPATH:+:$PYTHONPATH}" "$skill_registry_python" tests/skill-registry-server.py "$skill_registry_run" >"$skill_registry_run/server.log" 2>&1 &
skill_registry_pid=$!
cleanup_skill_registry() {
 if test -s "$skill_registry_run/port"; then
  "$skill_registry_python" - "$skill_registry_run/port" <<'PY'
import pathlib, sys, urllib.request
try:
    port=pathlib.Path(sys.argv[1]).read_text().strip()
    request=urllib.request.Request('http://127.0.0.1:'+port+'/fixture/control', data=b'{"action":"release-all"}', headers={'Content-Type':'application/json'})
    urllib.request.urlopen(request, timeout=2).close()
except Exception:
    pass
PY
 fi
 kill "$skill_registry_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$skill_registry_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$skill_registry_pid" 2>/dev/null; then kill -KILL "$skill_registry_pid" 2>/dev/null || true; fi
 wait "$skill_registry_pid" 2>/dev/null || true
}
trap cleanup_skill_registry EXIT
for i in $(seq 1 100); do test -s "$skill_registry_run/port" && break; sleep .1; done
test -s "$skill_registry_run/port" || { cat "$skill_registry_run/server.log"; exit 1; }
skill_registry_url="http://127.0.0.1:$(cat "$skill_registry_run/port")"
run_skill_registry_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/skill-registry-gjs.js "$skill_registry_run/client.js"
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$skill_registry_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$skill_registry_run":rw --env=XDG_STATE_HOME="$skill_registry_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$skill_registry_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$skill_registry_url" "$skill_registry_run"
 else
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$skill_registry_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$skill_registry_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/skill-registry-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$skill_registry_url" "$skill_registry_run"
 fi
}
run_skill_registry_client >"$skill_registry_run/client.log" 2>&1 || { tail -35 "$skill_registry_run/client.log"; tail -25 "$skill_registry_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$skill_registry_run/client.log"; then
 echo 'FAIL: skill-registry runtime error'; tail -30 "$skill_registry_run/client.log"; exit 1
fi
rg '^OK:' "$skill_registry_run/client.log"
