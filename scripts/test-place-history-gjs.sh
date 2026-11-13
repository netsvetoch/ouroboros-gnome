#!/bin/sh
set -eu
place_history_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
place_history_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$place_history_reference/VERSION")" = '7.10.0'
place_history_run=$(mktemp -d /tmp/ouroboros-place-history.XXXXXX)
echo "Logs at $place_history_run"
place_history_display=$((1000 + $$ % 20000))
PYTHONPATH="$place_history_reference${PYTHONPATH:+:$PYTHONPATH}" "$place_history_python" tests/place-history-server.py "$place_history_run" >"$place_history_run/server.log" 2>&1 &
place_history_pid=$!
cleanup_place_history() {
 if test -s "$place_history_run/port"; then
  "$place_history_python" - "$place_history_run/port" <<'PY'
import pathlib, sys, urllib.request
try:
    port=pathlib.Path(sys.argv[1]).read_text().strip()
    request=urllib.request.Request('http://127.0.0.1:'+port+'/fixture/control', data=b'{"action":"release-all"}', headers={'Content-Type':'application/json'})
    urllib.request.urlopen(request, timeout=2).close()
except Exception:
    pass
PY
 fi
 kill "$place_history_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$place_history_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$place_history_pid" 2>/dev/null; then kill -KILL "$place_history_pid" 2>/dev/null || true; fi
 wait "$place_history_pid" 2>/dev/null || true
}
trap cleanup_place_history EXIT
for i in $(seq 1 600); do test -s "$place_history_run/port" && break; sleep .1; done
test -s "$place_history_run/port" || { cat "$place_history_run/server.log"; exit 1; }
place_history_url="http://127.0.0.1:$(cat "$place_history_run/port")"
run_place_history_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/place-history-gjs.js "$place_history_run/client.js"
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$place_history_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$place_history_run":rw --env=XDG_STATE_HOME="$place_history_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$place_history_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$place_history_url" "$place_history_run"
 else
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$place_history_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$place_history_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/place-history-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$place_history_url" "$place_history_run"
 fi
}
run_place_history_client >"$place_history_run/client.log" 2>&1 || { tail -35 "$place_history_run/client.log"; tail -25 "$place_history_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$place_history_run/client.log"; then
 echo 'FAIL: place-history runtime error'; tail -30 "$place_history_run/client.log"; exit 1
fi
rg '^OK:' "$place_history_run/client.log"
