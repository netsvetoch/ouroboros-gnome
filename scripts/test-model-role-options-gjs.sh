#!/bin/sh
set -eu
role_options_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
role_options_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$role_options_reference/VERSION")" = '7.10.0'
role_options_run=$(mktemp -d /tmp/ouroboros-model-role-options.XXXXXX)
echo "Logs at $role_options_run"
role_options_display=$((1000 + $$ % 20000))
PYTHONPATH="$role_options_reference${PYTHONPATH:+:$PYTHONPATH}" "$role_options_python" tests/owner-settings-server.py "$role_options_run" --model-role-options >"$role_options_run/server.log" 2>&1 &
role_options_pid=$!
cleanup_role_options() {
 kill "$role_options_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$role_options_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$role_options_pid" 2>/dev/null; then kill -KILL "$role_options_pid" 2>/dev/null || true; fi
 wait "$role_options_pid" 2>/dev/null || true
}
trap cleanup_role_options EXIT
for i in $(seq 1 100); do test -s "$role_options_run/port" && break; sleep .1; done
test -s "$role_options_run/port" || { cat "$role_options_run/server.log"; exit 1; }
role_options_url="http://127.0.0.1:$(cat "$role_options_run/port")"
run_role_options_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/model-role-options-gjs.js "$role_options_run/client.js"
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$role_options_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$role_options_run":rw --env=XDG_STATE_HOME="$role_options_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$role_options_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$role_options_url" "$role_options_run"
 else
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$role_options_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$role_options_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/model-role-options-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$role_options_url" "$role_options_run"
 fi
}
run_role_options_client >"$role_options_run/client.log" 2>&1 || { tail -35 "$role_options_run/client.log"; tail -25 "$role_options_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$role_options_run/client.log"; then
 echo 'FAIL: model role options runtime error'; tail -30 "$role_options_run/client.log"; exit 1
fi
rg '^OK:' "$role_options_run/client.log"
