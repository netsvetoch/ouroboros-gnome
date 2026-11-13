#!/bin/sh
set -eu
command_receipts_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
command_receipts_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$command_receipts_reference/VERSION")" = '7.10.0'
command_receipts_run=$(mktemp -d /tmp/ouroboros-command-receipts.XXXXXX)
echo "Logs at $command_receipts_run"
command_receipts_display=$((1000 + $$ % 20000))
PYTHONPATH="$command_receipts_reference${PYTHONPATH:+:$PYTHONPATH}" "$command_receipts_python" tests/owner-i18n-server.py "$command_receipts_run" --real-chat --command-receipts >"$command_receipts_run/server.log" 2>&1 &
command_receipts_pid=$!
cleanup_questions() {
 kill "$command_receipts_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$command_receipts_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$command_receipts_pid" 2>/dev/null; then kill -KILL "$command_receipts_pid" 2>/dev/null || true; fi
 wait "$command_receipts_pid" 2>/dev/null || true
}
trap cleanup_questions EXIT
for i in $(seq 1 100); do test -s "$command_receipts_run/port" && break; sleep .1; done
test -s "$command_receipts_run/port" || { cat "$command_receipts_run/server.log"; exit 1; }
command_receipts_url="http://127.0.0.1:$(cat "$command_receipts_run/port")"
run_command_receipts_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/command-receipts-gjs.js "$command_receipts_run/client.js"
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$command_receipts_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$command_receipts_run":rw --env=TZ=Asia/Yerevan --env=XDG_STATE_HOME="$command_receipts_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$command_receipts_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$command_receipts_url" "$command_receipts_run"
 else
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$command_receipts_display" -s '-screen 0 1600x1000x24' env TZ=Asia/Yerevan XDG_STATE_HOME="$command_receipts_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/command-receipts-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$command_receipts_url" "$command_receipts_run"
 fi
}
run_command_receipts_client >"$command_receipts_run/client.log" 2>&1 || { tail -35 "$command_receipts_run/client.log"; tail -25 "$command_receipts_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$command_receipts_run/client.log"; then
 echo 'FAIL: command receipts runtime error'; tail -30 "$command_receipts_run/client.log"; exit 1
fi
rg '^OK:' "$command_receipts_run/client.log"
