#!/bin/sh
set -eu
schedule_once_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
schedule_once_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$schedule_once_reference/VERSION")" = '7.10.0'
schedule_once_run=$(mktemp -d /tmp/ouroboros-schedule-once.XXXXXX)
echo "Logs at $schedule_once_run"
schedule_once_display=$((1000 + $$ % 20000))
PYTHONPATH="$schedule_once_reference${PYTHONPATH:+:$PYTHONPATH}" "$schedule_once_python" tests/schedule-once-server.py "$schedule_once_run" >"$schedule_once_run/server.log" 2>&1 &
schedule_once_pid=$!
cleanup_holds() {
 kill "$schedule_once_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$schedule_once_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$schedule_once_pid" 2>/dev/null; then kill -KILL "$schedule_once_pid" 2>/dev/null || true; fi
 wait "$schedule_once_pid" 2>/dev/null || true
}
trap cleanup_holds EXIT
for i in $(seq 1 100); do test -s "$schedule_once_run/port" && break; sleep .1; done
test -s "$schedule_once_run/port" || { cat "$schedule_once_run/server.log"; exit 1; }
schedule_once_url="http://127.0.0.1:$(cat "$schedule_once_run/port")"
run_schedule_once_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/schedule-once-gjs.js "$schedule_once_run/client.js"
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$schedule_once_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$schedule_once_run":rw --env=XDG_STATE_HOME="$schedule_once_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$schedule_once_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$schedule_once_url" "$schedule_once_run"
 else
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$schedule_once_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$schedule_once_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/schedule-once-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$schedule_once_url" "$schedule_once_run"
 fi
}
run_schedule_once_client >"$schedule_once_run/client.log" 2>&1 || { tail -35 "$schedule_once_run/client.log"; tail -25 "$schedule_once_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$schedule_once_run/client.log"; then
 echo 'FAIL: schedule once runtime error'; tail -30 "$schedule_once_run/client.log"; exit 1
fi
rg '^OK:' "$schedule_once_run/client.log"
