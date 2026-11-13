#!/bin/sh
set -eu
diagnostics_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
diagnostics_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$diagnostics_reference/VERSION")" = '7.10.0'
diagnostics_run=$(mktemp -d /tmp/ouroboros-diagnostics.XXXXXX)
echo "Logs at $diagnostics_run"
diagnostics_display=$((1000 + $$ % 20000))
PYTHONPATH="$diagnostics_reference${PYTHONPATH:+:$PYTHONPATH}" "$diagnostics_python" tests/diagnostics-server.py "$diagnostics_run" >"$diagnostics_run/server.log" 2>&1 &
diagnostics_pid=$!
cleanup_diagnostics() {
 if test -s "$diagnostics_run/port"; then
  "$diagnostics_python" - "$diagnostics_run/port" <<'PY'
import pathlib, sys, urllib.request
try:
    port=pathlib.Path(sys.argv[1]).read_text().strip()
    request=urllib.request.Request('http://127.0.0.1:'+port+'/fixture/control', data=b'{"action":"release-all"}', headers={'Content-Type':'application/json'})
    urllib.request.urlopen(request, timeout=2).close()
except Exception:
    pass
PY
 fi
 kill "$diagnostics_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$diagnostics_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$diagnostics_pid" 2>/dev/null; then kill -KILL "$diagnostics_pid" 2>/dev/null || true; fi
 wait "$diagnostics_pid" 2>/dev/null || true
}
trap cleanup_diagnostics EXIT
for i in $(seq 1 100); do test -s "$diagnostics_run/port" && break; sleep .1; done
test -s "$diagnostics_run/port" || { cat "$diagnostics_run/server.log"; exit 1; }
diagnostics_url="http://127.0.0.1:$(cat "$diagnostics_run/port")"
run_diagnostics_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/diagnostics-gjs.js "$diagnostics_run/client.js"
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$diagnostics_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$diagnostics_run":rw --env=XDG_STATE_HOME="$diagnostics_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$diagnostics_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$diagnostics_url" "$diagnostics_run"
 else
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$diagnostics_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$diagnostics_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/diagnostics-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$diagnostics_url" "$diagnostics_run"
 fi
}
run_diagnostics_client >"$diagnostics_run/client.log" 2>&1 || { tail -35 "$diagnostics_run/client.log"; tail -25 "$diagnostics_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$diagnostics_run/client.log"; then
 echo 'FAIL: Diagnostics runtime error'; tail -30 "$diagnostics_run/client.log"; exit 1
fi
rg '^OK:' "$diagnostics_run/client.log"
