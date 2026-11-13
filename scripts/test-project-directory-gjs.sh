#!/bin/sh
set -eu
project_directory_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
project_directory_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$project_directory_reference/VERSION")" = '7.10.0'
project_directory_run=$(mktemp -d /tmp/ouroboros-project-directory.XXXXXX)
echo "Logs at $project_directory_run"
project_directory_display=$((1000 + $$ % 20000))
PYTHONPATH="$project_directory_reference${PYTHONPATH:+:$PYTHONPATH}" "$project_directory_python" tests/project-directory-server.py "$project_directory_run" >"$project_directory_run/server.log" 2>&1 &
project_directory_pid=$!
cleanup_project_directory() {
 if test -s "$project_directory_run/port"; then
  "$project_directory_python" - "$project_directory_run/port" <<'PY'
import pathlib, sys, urllib.request
try:
    port=pathlib.Path(sys.argv[1]).read_text().strip()
    request=urllib.request.Request('http://127.0.0.1:'+port+'/fixture/control', data=b'{"action":"release-all"}', headers={'Content-Type':'application/json'})
    urllib.request.urlopen(request, timeout=2).close()
except Exception:
    pass
PY
 fi
 kill "$project_directory_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$project_directory_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$project_directory_pid" 2>/dev/null; then kill -KILL "$project_directory_pid" 2>/dev/null || true; fi
 wait "$project_directory_pid" 2>/dev/null || true
}
trap cleanup_project_directory EXIT
for i in $(seq 1 100); do test -s "$project_directory_run/port" && break; sleep .1; done
test -s "$project_directory_run/port" || { cat "$project_directory_run/server.log"; exit 1; }
project_directory_url="http://127.0.0.1:$(cat "$project_directory_run/port")"
run_project_directory_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/project-directory-gjs.js "$project_directory_run/client.js"
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$project_directory_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$project_directory_run":rw --env=XDG_STATE_HOME="$project_directory_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$project_directory_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$project_directory_url" "$project_directory_run"
 else
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$project_directory_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$project_directory_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/project-directory-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$project_directory_url" "$project_directory_run"
 fi
}
run_project_directory_client >"$project_directory_run/client.log" 2>&1 || { tail -35 "$project_directory_run/client.log"; tail -25 "$project_directory_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$project_directory_run/client.log"; then
 echo 'FAIL: project directory runtime error'; tail -30 "$project_directory_run/client.log"; exit 1
fi
rg '^OK:' "$project_directory_run/client.log"
