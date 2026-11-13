#!/bin/sh
set -eu
schedule_holds_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
schedule_holds_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$schedule_holds_reference/VERSION")" = '7.10.0'
schedule_holds_run=$(mktemp -d /tmp/ouroboros-schedule-holds.XXXXXX)
echo "Logs at $schedule_holds_run"
schedule_holds_display=$((1000 + $$ % 20000))
PYTHONPATH="$schedule_holds_reference${PYTHONPATH:+:$PYTHONPATH}" "$schedule_holds_python" tests/schedule-holds-server.py "$schedule_holds_run" >"$schedule_holds_run/server.log" 2>&1 &
schedule_holds_pid=$!
cleanup_holds() {
 kill "$schedule_holds_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$schedule_holds_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$schedule_holds_pid" 2>/dev/null; then kill -KILL "$schedule_holds_pid" 2>/dev/null || true; fi
 wait "$schedule_holds_pid" 2>/dev/null || true
}
trap cleanup_holds EXIT
for i in $(seq 1 100); do test -s "$schedule_holds_run/port" && break; sleep .1; done
test -s "$schedule_holds_run/port" || { cat "$schedule_holds_run/server.log"; exit 1; }
schedule_holds_url="http://127.0.0.1:$(cat "$schedule_holds_run/port")"
run_schedule_holds_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/schedule-holds-gjs.js "$schedule_holds_run/client.js"
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$schedule_holds_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$schedule_holds_run":rw --env=XDG_STATE_HOME="$schedule_holds_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$schedule_holds_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$schedule_holds_url" "$schedule_holds_run"
 else
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$schedule_holds_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$schedule_holds_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/schedule-holds-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$schedule_holds_url" "$schedule_holds_run"
 fi
}
run_schedule_holds_client >"$schedule_holds_run/client.log" 2>&1 || { tail -35 "$schedule_holds_run/client.log"; tail -25 "$schedule_holds_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$schedule_holds_run/client.log"; then
 echo 'FAIL: schedule holds runtime error'; tail -30 "$schedule_holds_run/client.log"; exit 1
fi
rg '^OK:' "$schedule_holds_run/client.log"
