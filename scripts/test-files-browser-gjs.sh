#!/bin/sh
set -eu
files_browser_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
files_browser_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$files_browser_reference/VERSION")" = '7.10.0'
files_browser_run=$(mktemp -d /tmp/ouroboros-files-browser.XXXXXX)
echo "Logs at $files_browser_run"
files_browser_display=$((1000 + $$ % 20000))
PYTHONPATH="$files_browser_reference${PYTHONPATH:+:$PYTHONPATH}" "$files_browser_python" tests/files-browser-server.py "$files_browser_run" >"$files_browser_run/server.log" 2>&1 &
files_browser_pid=$!
cleanup_files_browser() {
 if test -s "$files_browser_run/port"; then
  "$files_browser_python" - "$files_browser_run/port" <<'PY'
import pathlib, sys, urllib.request
try:
    port=pathlib.Path(sys.argv[1]).read_text().strip()
    request=urllib.request.Request('http://127.0.0.1:'+port+'/fixture/control', data=b'{"action":"release-all"}', headers={'Content-Type':'application/json'})
    urllib.request.urlopen(request, timeout=2).close()
except Exception:
    pass
PY
 fi
 kill "$files_browser_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$files_browser_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$files_browser_pid" 2>/dev/null; then kill -KILL "$files_browser_pid" 2>/dev/null || true; fi
 wait "$files_browser_pid" 2>/dev/null || true
}
trap cleanup_files_browser EXIT
for i in $(seq 1 100); do test -s "$files_browser_run/port" && break; sleep .1; done
test -s "$files_browser_run/port" || { cat "$files_browser_run/server.log"; exit 1; }
files_browser_url="http://127.0.0.1:$(cat "$files_browser_run/port")"
run_files_browser_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/files-browser-gjs.js "$files_browser_run/client.js"
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$files_browser_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$files_browser_run":rw --env=XDG_STATE_HOME="$files_browser_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$files_browser_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$files_browser_url" "$files_browser_run"
 else
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$files_browser_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$files_browser_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/files-browser-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$files_browser_url" "$files_browser_run"
 fi
}
run_files_browser_client >"$files_browser_run/client.log" 2>&1 || { tail -35 "$files_browser_run/client.log"; tail -25 "$files_browser_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$files_browser_run/client.log"; then
 echo 'FAIL: task-artifacts runtime error'; tail -30 "$files_browser_run/client.log"; exit 1
fi
rg '^OK:' "$files_browser_run/client.log"
