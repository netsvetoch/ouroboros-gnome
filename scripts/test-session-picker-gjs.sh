#!/bin/sh
set -eu
session_picker_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
session_picker_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$session_picker_reference/VERSION")" = '7.10.0'
session_picker_run=$(mktemp -d /tmp/ouroboros-session-picker.XXXXXX)
echo "Logs at $session_picker_run"
session_picker_display=$((1000 + $$ % 20000))
PYTHONPATH="$session_picker_reference${PYTHONPATH:+:$PYTHONPATH}" "$session_picker_python" tests/accounts-server.py "$session_picker_run" --session-picker >"$session_picker_run/server.log" 2>&1 &
session_picker_pid=$!
cleanup_session_picker() {
 kill "$session_picker_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$session_picker_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$session_picker_pid" 2>/dev/null; then kill -KILL "$session_picker_pid" 2>/dev/null || true; fi
 wait "$session_picker_pid" 2>/dev/null || true
}
trap cleanup_session_picker EXIT
for i in $(seq 1 100); do test -s "$session_picker_run/port" && break; sleep .1; done
test -s "$session_picker_run/port" || { cat "$session_picker_run/server.log"; exit 1; }
session_picker_url="http://127.0.0.1:$(cat "$session_picker_run/port")"
run_session_picker_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/session-picker-gjs.js "$session_picker_run/client.js"
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$session_picker_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$session_picker_run":rw --env=XDG_STATE_HOME="$session_picker_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$session_picker_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$session_picker_url" "$session_picker_run"
 else
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$session_picker_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$session_picker_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/session-picker-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$session_picker_url" "$session_picker_run"
 fi
}
run_session_picker_client >"$session_picker_run/client.log" 2>&1 || { tail -35 "$session_picker_run/client.log"; tail -25 "$session_picker_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$session_picker_run/client.log"; then
 echo 'FAIL: session picker runtime error'; tail -30 "$session_picker_run/client.log"; exit 1
fi
rg '^OK:' "$session_picker_run/client.log"
