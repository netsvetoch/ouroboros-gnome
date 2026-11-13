#!/bin/sh
set -eu
panel_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
panel_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$panel_reference/VERSION")" = '7.10.0'
panel_run=$(mktemp -d /tmp/ouroboros-project-panel.XXXXXX)
echo "Logs at $panel_run"
panel_display=$((1000 + $$ % 20000))
PYTHONPATH="$panel_reference${PYTHONPATH:+:$PYTHONPATH}" "$panel_python" tests/room-reads-server.py "$panel_run" >"$panel_run/server.log" 2>&1 &
panel_pid=$!
trap 'kill "$panel_pid" 2>/dev/null || true' EXIT
for i in $(seq 1 100); do test -s "$panel_run/port" && break; sleep .1; done
test -s "$panel_run/port" || { cat "$panel_run/server.log"; exit 1; }
panel_url="http://127.0.0.1:$(cat "$panel_run/port")"
run_panel_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/project-panel-gjs.js "$panel_run/client.js"
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$panel_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$panel_run":rw --env=XDG_STATE_HOME="$panel_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$panel_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$panel_url" "$panel_run"
 else
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$panel_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$panel_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/project-panel-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$panel_url" "$panel_run"
 fi
}
run_panel_client >"$panel_run/client.log" 2>&1 || { tail -35 "$panel_run/client.log"; tail -25 "$panel_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$panel_run/client.log"; then
 echo 'FAIL: native project panel runtime error'; tail -30 "$panel_run/client.log"; exit 1
fi
rg '^OK:' "$panel_run/client.log"
