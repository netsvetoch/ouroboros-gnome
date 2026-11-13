#!/bin/sh
set -eu
mcp_import_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
mcp_import_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$mcp_import_reference/VERSION")" = '7.10.0'
"$mcp_import_python" -c 'import mcp; from importlib.metadata import version; print("MCP SDK " + version("mcp"))'
mcp_import_run=$(mktemp -d /tmp/ouroboros-mcp-import.XXXXXX)
echo "Logs at $mcp_import_run"
mcp_import_display=$((1000 + $$ % 20000))
PYTHONPATH="$mcp_import_reference${PYTHONPATH:+:$PYTHONPATH}" "$mcp_import_python" tests/mcp-probe-server.py "$mcp_import_run" >"$mcp_import_run/server.log" 2>&1 &
mcp_import_pid=$!
cleanup_mcp() {
 kill "$mcp_import_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$mcp_import_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$mcp_import_pid" 2>/dev/null; then kill -KILL "$mcp_import_pid" 2>/dev/null || true; fi
 wait "$mcp_import_pid" 2>/dev/null || true
}
trap cleanup_mcp EXIT
for i in $(seq 1 100); do test -s "$mcp_import_run/port" && break; sleep .1; done
test -s "$mcp_import_run/port" || { cat "$mcp_import_run/server.log"; exit 1; }
mcp_import_url="http://127.0.0.1:$(cat "$mcp_import_run/port")"
run_mcp_import_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/mcp-import-gjs.js "$mcp_import_run/client.js"
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$mcp_import_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$mcp_import_run":rw --env=XDG_STATE_HOME="$mcp_import_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$mcp_import_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$mcp_import_url" "$mcp_import_run"
 else
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$mcp_import_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$mcp_import_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/mcp-import-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$mcp_import_url" "$mcp_import_run"
 fi
}
run_mcp_import_client >"$mcp_import_run/client.log" 2>&1 || { tail -35 "$mcp_import_run/client.log"; tail -25 "$mcp_import_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$mcp_import_run/client.log"; then
 echo 'FAIL: MCP import runtime error'; tail -30 "$mcp_import_run/client.log"; exit 1
fi
rg '^OK:' "$mcp_import_run/client.log"
