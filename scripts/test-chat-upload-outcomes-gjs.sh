#!/bin/sh
set -eu
native_i18n_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
native_i18n_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$native_i18n_reference/VERSION")" = '7.10.0'
native_i18n_run=$(mktemp -d /tmp/ouroboros-chat-upload-outcomes.XXXXXX)
echo "Logs at $native_i18n_run"
native_i18n_display=$((1000 + $$ % 20000))
PYTHONPATH="$native_i18n_reference${PYTHONPATH:+:$PYTHONPATH}" "$native_i18n_python" tests/owner-i18n-server.py "$native_i18n_run" --real-chat >"$native_i18n_run/server.log" 2>&1 &
native_i18n_pid=$!
cleanup_questions() {
 kill "$native_i18n_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$native_i18n_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$native_i18n_pid" 2>/dev/null; then kill -KILL "$native_i18n_pid" 2>/dev/null || true; fi
 wait "$native_i18n_pid" 2>/dev/null || true
}
trap cleanup_questions EXIT
for i in $(seq 1 100); do test -s "$native_i18n_run/port" && break; sleep .1; done
test -s "$native_i18n_run/port" || { cat "$native_i18n_run/server.log"; exit 1; }
native_i18n_url="http://127.0.0.1:$(cat "$native_i18n_run/port")"
run_native_i18n_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/chat-upload-outcomes-gjs.js "$native_i18n_run/client.js"
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$native_i18n_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$native_i18n_run":rw --env=TZ=Asia/Yerevan --env=XDG_STATE_HOME="$native_i18n_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$native_i18n_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$native_i18n_url" "$native_i18n_run"
 else
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$native_i18n_display" -s '-screen 0 1600x1000x24' env TZ=Asia/Yerevan XDG_STATE_HOME="$native_i18n_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/chat-upload-outcomes-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$native_i18n_url" "$native_i18n_run"
 fi
}
run_native_i18n_client >"$native_i18n_run/client.log" 2>&1 || { tail -35 "$native_i18n_run/client.log"; tail -25 "$native_i18n_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$native_i18n_run/client.log"; then
 echo 'FAIL: settings i18n runtime error'; tail -30 "$native_i18n_run/client.log"; exit 1
fi
rg '^OK:' "$native_i18n_run/client.log"
