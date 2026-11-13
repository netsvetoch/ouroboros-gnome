#!/bin/sh
set -eu
nested_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
nested_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$nested_reference/VERSION")" = '7.10.0'
nested_run=$(mktemp -d /tmp/ouroboros-nested-tasks.XXXXXX)
echo "Logs at $nested_run"
PYTHONPATH="$nested_reference${PYTHONPATH:+:$PYTHONPATH}" "$nested_python" tests/nested-tasks-server.py "$nested_run" >"$nested_run/server.log" 2>&1 &
nested_pid=$!
trap 'kill "$nested_pid" 2>/dev/null || true' EXIT
for i in $(seq 1 100); do test -s "$nested_run/port" && break; sleep .1; done
test -s "$nested_run/port" || { cat "$nested_run/server.log"; exit 1; }
nested_url="http://127.0.0.1:$(cat "$nested_run/port")"
run_nested_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/nested-tasks-gjs.js "$nested_run/client.js"
  timeout 100s dbus-run-session -- xvfb-run -a -s '-screen 0 1280x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$nested_run":rw --env=XDG_STATE_HOME="$nested_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$nested_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$nested_url" "$nested_run"
 else
  timeout 100s dbus-run-session -- xvfb-run -a -s '-screen 0 1280x1000x24' env XDG_STATE_HOME="$nested_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/nested-tasks-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$nested_url" "$nested_run"
 fi
}
run_nested_client >"$nested_run/client.log" 2>&1 || { tail -35 "$nested_run/client.log"; tail -25 "$nested_run/server.log"; exit 1; }
if rg -q 'from markup due to error parsing markup' "$nested_run/client.log"; then
 echo 'FAIL: nested task parsed literal text as Pango markup'; tail -30 "$nested_run/client.log"; exit 1
fi
rg '^OK:' "$nested_run/client.log"
