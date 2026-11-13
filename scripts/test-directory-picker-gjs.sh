#!/bin/sh
set -eu
directory_picker_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
directory_picker_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$directory_picker_reference/VERSION")" = '7.10.0'
mkdir -p "$HOME/.cache"
directory_picker_run=$(mktemp -d "$HOME/.cache/ouroboros-directory-picker.XXXXXX")
echo "Logs at $directory_picker_run"
directory_picker_display=$((1000 + $$ % 20000))
PYTHONPATH="$directory_picker_reference${PYTHONPATH:+:$PYTHONPATH}" "$directory_picker_python" tests/directory-picker-server.py "$directory_picker_run" >"$directory_picker_run/server.log" 2>&1 &
directory_picker_pid=$!
cleanup_directory_picker() {
 if test -s "$directory_picker_run/port"; then
  "$directory_picker_python" - "$directory_picker_run/port" <<'PY'
import pathlib, sys, urllib.request
try:
    port=pathlib.Path(sys.argv[1]).read_text().strip()
    request=urllib.request.Request('http://127.0.0.1:'+port+'/fixture/control', data=b'{"action":"release-all"}', headers={'Content-Type':'application/json'})
    urllib.request.urlopen(request, timeout=2).close()
except Exception:
    pass
PY
 fi
 kill "$directory_picker_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$directory_picker_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$directory_picker_pid" 2>/dev/null; then kill -KILL "$directory_picker_pid" 2>/dev/null || true; fi
 wait "$directory_picker_pid" 2>/dev/null || true
}
trap cleanup_directory_picker EXIT
for i in $(seq 1 100); do test -s "$directory_picker_run/port" && break; sleep .1; done
test -s "$directory_picker_run/port" || { cat "$directory_picker_run/server.log"; exit 1; }
directory_picker_url="http://127.0.0.1:$(cat "$directory_picker_run/port")"
run_directory_picker_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/directory-picker-gjs.js "$directory_picker_run/client.js"
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$directory_picker_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$directory_picker_run":rw --env=XDG_STATE_HOME="$directory_picker_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$directory_picker_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$directory_picker_url" "$directory_picker_run"
 else
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$directory_picker_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$directory_picker_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/directory-picker-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$directory_picker_url" "$directory_picker_run"
 fi
}
run_directory_picker_client >"$directory_picker_run/client.log" 2>&1 || { tail -35 "$directory_picker_run/client.log"; tail -25 "$directory_picker_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$directory_picker_run/client.log"; then
 echo 'FAIL: directory picker runtime error'; tail -30 "$directory_picker_run/client.log"; exit 1
fi
rg '^OK:' "$directory_picker_run/client.log"
