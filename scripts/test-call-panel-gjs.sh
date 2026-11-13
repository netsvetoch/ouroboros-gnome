#!/bin/sh
set -eu
call_settings_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
call_settings_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$call_settings_reference/VERSION")" = '7.10.0'
call_settings_run=$(mktemp -d /tmp/ouroboros-call-panel.XXXXXX)
echo "Logs at $call_settings_run"
call_settings_display=$((1000 + $$ % 20000))
PYTHONPATH="$call_settings_reference${PYTHONPATH:+:$PYTHONPATH}" "$call_settings_python" tests/call-panel-server.py "$call_settings_run" >"$call_settings_run/server.log" 2>&1 &
call_settings_pid=$!
cleanup_call_settings() {
 if test -s "$call_settings_run/port"; then
  "$call_settings_python" - "$call_settings_run/port" <<'PY'
import pathlib, sys, urllib.request
try:
    port=pathlib.Path(sys.argv[1]).read_text().strip()
    request=urllib.request.Request('http://127.0.0.1:'+port+'/fixture/control', data=b'{"action":"release"}', headers={'Content-Type':'application/json'})
    urllib.request.urlopen(request, timeout=2).close()
except Exception:
    pass
PY
 fi
 kill "$call_settings_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$call_settings_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$call_settings_pid" 2>/dev/null; then kill -KILL "$call_settings_pid" 2>/dev/null || true; fi
 wait "$call_settings_pid" 2>/dev/null || true
}
trap cleanup_call_settings EXIT
for i in $(seq 1 100); do test -s "$call_settings_run/port" && break; sleep .1; done
test -s "$call_settings_run/port" || { cat "$call_settings_run/server.log"; exit 1; }
call_settings_url="http://127.0.0.1:$(cat "$call_settings_run/port")"
run_call_settings_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/call-panel-gjs.js "$call_settings_run/client.js"
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$call_settings_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$call_settings_run":rw --env=XDG_STATE_HOME="$call_settings_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$call_settings_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$call_settings_url" "$call_settings_run"
 else
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$call_settings_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$call_settings_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/call-panel-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$call_settings_url" "$call_settings_run"
 fi
}
run_call_settings_client >"$call_settings_run/client.log" 2>&1 || { tail -35 "$call_settings_run/client.log"; tail -25 "$call_settings_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$call_settings_run/client.log"; then
 echo 'FAIL: Call panel runtime error'; tail -30 "$call_settings_run/client.log"; exit 1
fi
rg '^OK:' "$call_settings_run/client.log"
