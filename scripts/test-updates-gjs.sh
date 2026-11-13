#!/bin/sh
set -eu
updates_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
updates_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$updates_reference/VERSION")" = '7.10.0'
updates_run=$(mktemp -d /tmp/ouroboros-updates.XXXXXX)
echo "Logs at $updates_run"
updates_display=$((1000 + $$ % 20000))
PYTHONPATH="$updates_reference${PYTHONPATH:+:$PYTHONPATH}" "$updates_python" tests/updates-server.py "$updates_run" >"$updates_run/server.log" 2>&1 &
updates_pid=$!
cleanup_updates() {
 if test -s "$updates_run/port"; then
  "$updates_python" - "$updates_run/port" <<'PY'
import pathlib, sys, urllib.request
try:
    port=pathlib.Path(sys.argv[1]).read_text().strip()
    request=urllib.request.Request('http://127.0.0.1:'+port+'/fixture/control', data=b'{"action":"release-all"}', headers={'Content-Type':'application/json'})
    urllib.request.urlopen(request, timeout=2).close()
except Exception:
    pass
PY
 fi
 kill "$updates_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$updates_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$updates_pid" 2>/dev/null; then kill -KILL "$updates_pid" 2>/dev/null || true; fi
 wait "$updates_pid" 2>/dev/null || true
}
trap cleanup_updates EXIT
for i in $(seq 1 100); do test -s "$updates_run/port" && break; sleep .1; done
test -s "$updates_run/port" || { cat "$updates_run/server.log"; exit 1; }
updates_url="http://127.0.0.1:$(cat "$updates_run/port")"
run_updates_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/updates-gjs.js "$updates_run/client.js"
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$updates_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$updates_run":rw --env=XDG_STATE_HOME="$updates_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$updates_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$updates_url" "$updates_run"
 else
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$updates_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$updates_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/updates-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$updates_url" "$updates_run"
 fi
}
run_updates_client >"$updates_run/client.log" 2>&1 || { tail -35 "$updates_run/client.log"; tail -25 "$updates_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$updates_run/client.log"; then
 echo 'FAIL: Updates runtime error'; tail -30 "$updates_run/client.log"; exit 1
fi
rg '^OK:' "$updates_run/client.log"
