#!/bin/sh
set -eu
auth_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
auth_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$auth_reference/VERSION")" = '7.10.0'
auth_run=$(mktemp -d /tmp/ouroboros-connection-settings.XXXXXX)
echo "Logs at $auth_run"
OUROBOROS_DATA_DIR="$auth_run/data" PYTHONPATH="$auth_reference${PYTHONPATH:+:$PYTHONPATH}" "$auth_python" tests/gateway-auth-server.py "$auth_run" >"$auth_run/server.log" 2>&1 &
auth_pid=$!
cleanup_connection() {
 if test -s "$auth_run/ports.json"; then
  "$auth_python" - "$auth_run/ports.json" <<'PYRELEASE'
import json,sys,urllib.request
try:
 port=json.load(open(sys.argv[1]))['loopback']
 urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:'+str(port)+'/fixture/control',data=b'{"action":"release-all"}',headers={'Content-Type':'application/json'}),timeout=2).close()
except Exception:pass
PYRELEASE
 fi
 kill "$auth_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$auth_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$auth_pid" 2>/dev/null; then kill -KILL "$auth_pid" 2>/dev/null || true; fi
 wait "$auth_pid" 2>/dev/null || true
}
trap cleanup_connection EXIT
for i in $(seq 1 100); do test -s "$auth_run/ports.json" && break; sleep .1; done
test -s "$auth_run/ports.json" || { cat "$auth_run/server.log"; exit 1; }
auth_ports=$("$auth_python" -c 'import json,sys; p=json.load(open(sys.argv[1])); print(p["remote"],p["loopback"])' "$auth_run/ports.json")
set -- $auth_ports
auth_remote="http://127.0.0.1:$1"
auth_local="http://127.0.0.1:$2"
auth_display=$((1000 + $$ % 20000))
run_auth_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/connection-settings-gjs.js "$auth_run/client.js"
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$auth_display" -s '-screen 0 1400x1000x24' flatpak build --socket=x11 --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none --runtime --share=network --filesystem="$auth_run":rw "$OUROBOROS_FLATPAK_BUILD" gjs -m "$auth_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$auth_remote" "$auth_local" "$auth_run"
 else
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$auth_display" -s '-screen 0 1400x1000x24' env GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/connection-settings-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$auth_remote" "$auth_local" "$auth_run"
 fi
}
run_auth_client >"$auth_run/client.log" 2>&1 || { cat "$auth_run/client.log"; cat "$auth_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$auth_run/client.log"; then tail -35 "$auth_run/client.log"; exit 1; fi
rg '^OK:' "$auth_run/client.log"
