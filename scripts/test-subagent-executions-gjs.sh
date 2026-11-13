#!/bin/sh
set -eu
subagent_executions_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
subagent_executions_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$subagent_executions_reference/VERSION")" = '7.10.0'
subagent_executions_run=$(mktemp -d /tmp/ouroboros-subagent-executions.XXXXXX)
echo "Logs at $subagent_executions_run"
subagent_executions_display=$((1000 + $$ % 20000))
PYTHONPATH="$subagent_executions_reference${PYTHONPATH:+:$PYTHONPATH}" "$subagent_executions_python" tests/accounts-server.py "$subagent_executions_run" --executions >"$subagent_executions_run/server.log" 2>&1 &
subagent_executions_pid=$!
cleanup_subagent_executions() {
 kill "$subagent_executions_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$subagent_executions_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$subagent_executions_pid" 2>/dev/null; then kill -KILL "$subagent_executions_pid" 2>/dev/null || true; fi
 wait "$subagent_executions_pid" 2>/dev/null || true
}
trap cleanup_subagent_executions EXIT
for i in $(seq 1 100); do test -s "$subagent_executions_run/port" && break; sleep .1; done
test -s "$subagent_executions_run/port" || { cat "$subagent_executions_run/server.log"; exit 1; }
subagent_executions_url="http://127.0.0.1:$(cat "$subagent_executions_run/port")"
run_subagent_executions_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/subagent-executions-gjs.js "$subagent_executions_run/client.js"
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$subagent_executions_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$subagent_executions_run":rw --env=XDG_STATE_HOME="$subagent_executions_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$subagent_executions_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$subagent_executions_url" "$subagent_executions_run"
 else
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$subagent_executions_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$subagent_executions_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/subagent-executions-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$subagent_executions_url" "$subagent_executions_run"
 fi
}
run_subagent_executions_client >"$subagent_executions_run/client.log" 2>&1 || { tail -35 "$subagent_executions_run/client.log"; tail -25 "$subagent_executions_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$subagent_executions_run/client.log"; then
 echo 'FAIL: subagent execution history runtime error'; tail -30 "$subagent_executions_run/client.log"; exit 1
fi
rg '^OK:' "$subagent_executions_run/client.log"
