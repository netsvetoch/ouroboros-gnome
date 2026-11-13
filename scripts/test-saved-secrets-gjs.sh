#!/bin/sh
set -eu
saved_secrets_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
saved_secrets_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$saved_secrets_reference/VERSION")" = '7.10.0'
saved_secrets_run=$(mktemp -d /tmp/ouroboros-saved-secrets.XXXXXX)
echo "Logs at $saved_secrets_run"
saved_secrets_display=$((1000 + $$ % 20000))
PYTHONPATH="$saved_secrets_reference${PYTHONPATH:+:$PYTHONPATH}" "$saved_secrets_python" tests/saved-secrets-server.py "$saved_secrets_run" >"$saved_secrets_run/server.log" 2>&1 &
saved_secrets_pid=$!
cleanup_secrets() {
 kill "$saved_secrets_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$saved_secrets_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$saved_secrets_pid" 2>/dev/null; then kill -KILL "$saved_secrets_pid" 2>/dev/null || true; fi
 wait "$saved_secrets_pid" 2>/dev/null || true
}
trap cleanup_secrets EXIT
for i in $(seq 1 100); do test -s "$saved_secrets_run/port" && break; sleep .1; done
test -s "$saved_secrets_run/port" || { cat "$saved_secrets_run/server.log"; exit 1; }
saved_secrets_url="http://127.0.0.1:$(cat "$saved_secrets_run/port")"
run_saved_secrets_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/saved-secrets-gjs.js "$saved_secrets_run/client.js"
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$saved_secrets_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$saved_secrets_run":rw --env=XDG_STATE_HOME="$saved_secrets_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$saved_secrets_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$saved_secrets_url" "$saved_secrets_run"
 else
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$saved_secrets_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$saved_secrets_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/saved-secrets-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$saved_secrets_url" "$saved_secrets_run"
 fi
}
run_saved_secrets_client >"$saved_secrets_run/client.log" 2>&1 || { tail -35 "$saved_secrets_run/client.log"; tail -25 "$saved_secrets_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$saved_secrets_run/client.log"; then
 echo 'FAIL: saved secrets runtime error'; tail -30 "$saved_secrets_run/client.log"; exit 1
fi
rg '^OK:' "$saved_secrets_run/client.log"
