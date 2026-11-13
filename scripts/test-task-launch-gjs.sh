#!/bin/sh
set -eu
launch_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
launch_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$launch_reference/VERSION")" = '7.10.0'
launch_run=$(mktemp -d /tmp/ouroboros-task-launch.XXXXXX)
echo "Logs at $launch_run"
launch_display=$((1000 + $$ % 20000))
PYTHONPATH="$launch_reference${PYTHONPATH:+:$PYTHONPATH}" "$launch_python" tests/task-launch-server.py "$launch_run" >"$launch_run/server.log" 2>&1 &
launch_pid=$!
cleanup_launch() {
 kill "$launch_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$launch_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$launch_pid" 2>/dev/null; then kill -KILL "$launch_pid" 2>/dev/null || true; fi
 wait "$launch_pid" 2>/dev/null || true
}
trap cleanup_launch EXIT
for i in $(seq 1 100); do test -s "$launch_run/port" && break; sleep .1; done
test -s "$launch_run/port" || { cat "$launch_run/server.log"; exit 1; }
launch_url="http://127.0.0.1:$(cat "$launch_run/port")"
run_launch_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/task-launch-gjs.js "$launch_run/client.js"
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$launch_display" -s '-screen 0 1280x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$launch_run":rw --env=XDG_STATE_HOME="$launch_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$launch_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$launch_url" "$launch_run"
 else
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$launch_display" -s '-screen 0 1280x1000x24' env XDG_STATE_HOME="$launch_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/task-launch-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$launch_url" "$launch_run"
 fi
}
run_launch_client >"$launch_run/client.log" 2>&1 || { tail -35 "$launch_run/client.log"; tail -25 "$launch_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$launch_run/client.log"; then
 echo 'FAIL: native launch runtime error'; tail -30 "$launch_run/client.log"; exit 1
fi
rg '^OK:'  "$launch_run/client.log"
