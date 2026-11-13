#!/bin/sh
set -eu
continuation_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
continuation_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$continuation_reference/VERSION")" = '7.10.0'
continuation_run=$(mktemp -d /tmp/ouroboros-task-continuation.XXXXXX)
echo "Logs at $continuation_run"
PYTHONPATH="$continuation_reference${PYTHONPATH:+:$PYTHONPATH}" "$continuation_python" tests/task-continuation-server.py "$continuation_run" >"$continuation_run/server.log" 2>&1 &
continuation_pid=$!
trap 'kill "$continuation_pid" 2>/dev/null || true' EXIT
for i in $(seq 1 100); do test -s "$continuation_run/port" && break; sleep .1; done
test -s "$continuation_run/port" || { cat "$continuation_run/server.log"; exit 1; }
continuation_url="http://127.0.0.1:$(cat "$continuation_run/port")"
run_continuation_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/task-continuation-gjs.js "$continuation_run/client.js"
  timeout 100s dbus-run-session -- xvfb-run -a -s '-screen 0 1280x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$continuation_run":rw --env=XDG_STATE_HOME="$continuation_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$continuation_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$continuation_url" "$continuation_run"
 else
  timeout 100s dbus-run-session -- xvfb-run -a -s '-screen 0 1280x1000x24' env XDG_STATE_HOME="$continuation_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/task-continuation-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$continuation_url" "$continuation_run"
 fi
}
run_continuation_client >"$continuation_run/client.log" 2>&1 || { tail -35 "$continuation_run/client.log"; tail -25 "$continuation_run/server.log"; exit 1; }
if rg -q 'from markup due to error parsing markup' "$continuation_run/client.log"; then
 echo 'FAIL: task continuation parsed a literal value as Pango markup'; tail -30 "$continuation_run/client.log"; exit 1
fi
rg '^OK:' "$continuation_run/client.log"
