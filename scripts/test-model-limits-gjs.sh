#!/bin/sh
set -eu
model_limits_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
model_limits_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$model_limits_reference/VERSION")" = '7.10.0'
model_limits_run=$(mktemp -d /tmp/ouroboros-model-limits.XXXXXX)
echo "Logs at $model_limits_run"
model_limits_display=$((1000 + $$ % 20000))
PYTHONPATH="$model_limits_reference${PYTHONPATH:+:$PYTHONPATH}" "$model_limits_python" tests/model-limits-server.py "$model_limits_run" >"$model_limits_run/server.log" 2>&1 &
model_limits_pid=$!
cleanup_limits() {
 kill "$model_limits_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$model_limits_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$model_limits_pid" 2>/dev/null; then kill -KILL "$model_limits_pid" 2>/dev/null || true; fi
 wait "$model_limits_pid" 2>/dev/null || true
}
trap cleanup_limits EXIT
for i in $(seq 1 100); do test -s "$model_limits_run/port" && break; sleep .1; done
test -s "$model_limits_run/port" || { cat "$model_limits_run/server.log"; exit 1; }
model_limits_url="http://127.0.0.1:$(cat "$model_limits_run/port")"
run_model_limits_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/model-limits-gjs.js "$model_limits_run/client.js"
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$model_limits_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$model_limits_run":rw --env=XDG_STATE_HOME="$model_limits_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$model_limits_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$model_limits_url" "$model_limits_run"
 else
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$model_limits_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$model_limits_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/model-limits-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$model_limits_url" "$model_limits_run"
 fi
}
run_model_limits_client >"$model_limits_run/client.log" 2>&1 || { tail -35 "$model_limits_run/client.log"; tail -25 "$model_limits_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$model_limits_run/client.log"; then
 echo 'FAIL: model limits runtime error'; tail -30 "$model_limits_run/client.log"; exit 1
fi
rg '^OK:' "$model_limits_run/client.log"
