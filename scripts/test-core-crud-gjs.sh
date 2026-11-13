#!/bin/sh
set -eu
core_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
core_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$core_reference/VERSION")" = '7.10.0'
"$core_python" -c 'import starlette, uvicorn, croniter'
# /api/fs/dirs deliberately confines directory selection to the real home tree.
mkdir -p "$HOME/.cache"
core_run=$(mktemp -d "$HOME/.cache/ouroboros-core-crud.XXXXXX")
echo "Logs at $core_run"
core_display=$((1000 + $$ % 20000))
OUROBOROS_DATA_DIR="$core_run/data" PYTHONPATH="$core_reference${PYTHONPATH:+:$PYTHONPATH}" "$core_python" tests/core-crud-server.py "$core_run" >"$core_run/server.log" 2>&1 &
core_pid=$!
cleanup_core() {
 kill "$core_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$core_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$core_pid" 2>/dev/null; then kill -KILL "$core_pid" 2>/dev/null || true; fi
 wait "$core_pid" 2>/dev/null || true
}
trap cleanup_core EXIT
for i in $(seq 1 100); do test -s "$core_run/port" && break; sleep .1; done
test -s "$core_run/port" || { cat "$core_run/server.log"; exit 1; }
core_url="http://127.0.0.1:$(cat "$core_run/port")"
run_core_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/core-crud-gjs.js "$core_run/client.js"
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$core_display" -s '-screen 0 1280x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$core_run":rw --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$core_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$core_url" "$core_run"
 else
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$core_display" -s '-screen 0 1280x1000x24' env GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/core-crud-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$core_url" "$core_run"
 fi
}
run_core_client >"$core_run/client.log" 2>&1 || { tail -45 "$core_run/client.log"; tail -30 "$core_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$core_run/client.log"; then
 echo 'FAIL: core native runtime error'; tail -30 "$core_run/client.log"; exit 1
fi
rg '^OK:' "$core_run/client.log"
