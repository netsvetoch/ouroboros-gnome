#!/bin/sh
set -eu
event_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
event_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$event_reference/VERSION")" = '7.10.0'
event_run=$(mktemp -d /tmp/ouroboros-task-events.XXXXXX)
echo "Logs at $event_run"
event_display=$((1000 + $$ % 20000))
PYTHONPATH="$event_reference${PYTHONPATH:+:$PYTHONPATH}" "$event_python" tests/task-events-server.py "$event_run" >"$event_run/server.log" 2>&1 &
event_pid=$!
cleanup_events() {
 kill "$event_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$event_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$event_pid" 2>/dev/null; then kill -KILL "$event_pid" 2>/dev/null || true; fi
 wait "$event_pid" 2>/dev/null || true
}
trap cleanup_events EXIT
for i in $(seq 1 100); do test -s "$event_run/port" && break; sleep .1; done
test -s "$event_run/port" || { cat "$event_run/server.log"; exit 1; }
event_url="http://127.0.0.1:$(cat "$event_run/port")"
run_event_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/task-events-gjs.js "$event_run/client.js"
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$event_display" -s '-screen 0 1280x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$event_run":rw --env=XDG_STATE_HOME="$event_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$event_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$event_url" "$event_run"
 else
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$event_display" -s '-screen 0 1280x1000x24' env XDG_STATE_HOME="$event_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/task-events-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$event_url" "$event_run"
 fi
}
run_event_client >"$event_run/client.log" 2>&1 || { tail -35 "$event_run/client.log"; tail -25 "$event_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$event_run/client.log"; then
 echo 'FAIL: native event runtime error'; tail -30 "$event_run/client.log"; exit 1
fi
rg '^OK:' "$event_run/client.log"
