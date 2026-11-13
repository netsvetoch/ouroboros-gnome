#!/bin/sh
set -eu
storage_manual_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
storage_manual_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$storage_manual_reference/VERSION")" = '7.10.0'
storage_manual_run=$(mktemp -d /tmp/ouroboros-storage-manual.XXXXXX)
echo "Logs at $storage_manual_run"
storage_manual_display=$((1000 + $$ % 20000))
PYTHONPATH="$storage_manual_reference${PYTHONPATH:+:$PYTHONPATH}" "$storage_manual_python" tests/storage-server.py "$storage_manual_run" manual >"$storage_manual_run/server.log" 2>&1 &
storage_manual_pid=$!
cleanup_storage() {
 if test -s "$storage_manual_run/port"; then
  "$storage_manual_python" - "$storage_manual_run/port" <<'PY'
import pathlib, sys, urllib.request
try:
    port=pathlib.Path(sys.argv[1]).read_text().strip()
    request=urllib.request.Request('http://127.0.0.1:'+port+'/fixture/control', data=b'{"action":"release-all"}', headers={'Content-Type':'application/json'})
    urllib.request.urlopen(request, timeout=2).close()
except Exception:
    pass
PY
 fi
 kill "$storage_manual_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$storage_manual_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$storage_manual_pid" 2>/dev/null; then kill -KILL "$storage_manual_pid" 2>/dev/null || true; fi
 wait "$storage_manual_pid" 2>/dev/null || true
}
trap cleanup_storage EXIT
for i in $(seq 1 100); do test -s "$storage_manual_run/port" && break; sleep .1; done
test -s "$storage_manual_run/port" || { cat "$storage_manual_run/server.log"; exit 1; }
storage_manual_url="http://127.0.0.1:$(cat "$storage_manual_run/port")"
run_storage_manual_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/storage-manual-gjs.js "$storage_manual_run/client.js"
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$storage_manual_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$storage_manual_run":rw --env=XDG_STATE_HOME="$storage_manual_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$storage_manual_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$storage_manual_url" "$storage_manual_run"
 else
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$storage_manual_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$storage_manual_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/storage-manual-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$storage_manual_url" "$storage_manual_run"
 fi
}
run_storage_manual_client >"$storage_manual_run/client.log" 2>&1 || { tail -35 "$storage_manual_run/client.log"; tail -25 "$storage_manual_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$storage_manual_run/client.log"; then
 echo 'FAIL: Storage runtime error'; tail -30 "$storage_manual_run/client.log"; exit 1
fi
rg '^OK:' "$storage_manual_run/client.log"
