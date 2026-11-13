#!/bin/sh
set -eu
activity_overview_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
activity_overview_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$activity_overview_reference/VERSION")" = '7.10.0'
activity_overview_run=$(mktemp -d /tmp/ouroboros-activity-overview.XXXXXX)
echo "Logs at $activity_overview_run"
activity_overview_display=$((1000 + $$ % 20000))
PYTHONPATH="$activity_overview_reference${PYTHONPATH:+:$PYTHONPATH}" "$activity_overview_python" tests/activity-overview-server.py "$activity_overview_run" >"$activity_overview_run/server.log" 2>&1 &
activity_overview_pid=$!
cleanup_activity_overview() {
 if test -s "$activity_overview_run/port"; then
  "$activity_overview_python" - "$activity_overview_run/port" <<'PY'
import pathlib, sys, urllib.request
try:
    port=pathlib.Path(sys.argv[1]).read_text().strip()
    request=urllib.request.Request('http://127.0.0.1:'+port+'/fixture/control', data=b'{"action":"release-all"}', headers={'Content-Type':'application/json'})
    urllib.request.urlopen(request, timeout=2).close()
except Exception:
    pass
PY
 fi
 kill "$activity_overview_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$activity_overview_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$activity_overview_pid" 2>/dev/null; then kill -KILL "$activity_overview_pid" 2>/dev/null || true; fi
 wait "$activity_overview_pid" 2>/dev/null || true
}
trap cleanup_activity_overview EXIT
for i in $(seq 1 100); do test -s "$activity_overview_run/port" && break; sleep .1; done
test -s "$activity_overview_run/port" || { cat "$activity_overview_run/server.log"; exit 1; }
activity_overview_url="http://127.0.0.1:$(cat "$activity_overview_run/port")"
run_activity_overview_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/activity-overview-gjs.js "$activity_overview_run/client.js"
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$activity_overview_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$activity_overview_run":rw --env=XDG_STATE_HOME="$activity_overview_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$activity_overview_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$activity_overview_url" "$activity_overview_run"
 else
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$activity_overview_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$activity_overview_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/activity-overview-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$activity_overview_url" "$activity_overview_run"
 fi
}
run_activity_overview_client >"$activity_overview_run/client.log" 2>&1 || { tail -35 "$activity_overview_run/client.log"; tail -25 "$activity_overview_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$activity_overview_run/client.log"; then
 echo 'FAIL: activity-overview runtime error'; tail -30 "$activity_overview_run/client.log"; exit 1
fi
rg '^OK:' "$activity_overview_run/client.log"
