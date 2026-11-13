#!/bin/sh
set -eu
schedule_lifetime_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
schedule_lifetime_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$schedule_lifetime_reference/VERSION")" = '7.10.0'
schedule_lifetime_run=$(mktemp -d /tmp/ouroboros-routing-journal.XXXXXX)
echo "Logs at $schedule_lifetime_run"
schedule_lifetime_display=$((1000 + $$ % 20000))
PYTHONPATH="$schedule_lifetime_reference${PYTHONPATH:+:$PYTHONPATH}" "$schedule_lifetime_python" tests/routing-picker-server.py "$schedule_lifetime_run" --journal >"$schedule_lifetime_run/server.log" 2>&1 &
schedule_lifetime_pid=$!
cleanup_storage() {
 if test -s "$schedule_lifetime_run/port"; then
  "$schedule_lifetime_python" - "$schedule_lifetime_run/port" <<'PY'
import pathlib, sys, urllib.request
try:
    port=pathlib.Path(sys.argv[1]).read_text().strip()
    request=urllib.request.Request('http://127.0.0.1:'+port+'/fixture/control', data=b'{"action":"release-all"}', headers={'Content-Type':'application/json'})
    urllib.request.urlopen(request, timeout=2).close()
except Exception:
    pass
PY
 fi
 kill "$schedule_lifetime_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$schedule_lifetime_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$schedule_lifetime_pid" 2>/dev/null; then kill -KILL "$schedule_lifetime_pid" 2>/dev/null || true; fi
 wait "$schedule_lifetime_pid" 2>/dev/null || true
}
trap cleanup_storage EXIT
for i in $(seq 1 100); do test -s "$schedule_lifetime_run/port" && break; sleep .1; done
test -s "$schedule_lifetime_run/port" || { cat "$schedule_lifetime_run/server.log"; exit 1; }
schedule_lifetime_url="http://127.0.0.1:$(cat "$schedule_lifetime_run/port")"
run_schedule_lifetime_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/routing-journal-gjs.js "$schedule_lifetime_run/client.js"
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$schedule_lifetime_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$schedule_lifetime_run":rw --env=XDG_STATE_HOME="$schedule_lifetime_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$schedule_lifetime_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$schedule_lifetime_url" "$schedule_lifetime_run" "$schedule_phase"
 else
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$schedule_lifetime_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$schedule_lifetime_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/routing-journal-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$schedule_lifetime_url" "$schedule_lifetime_run" "$schedule_phase"
 fi
}
for schedule_phase in prepare recover; do
run_schedule_lifetime_client >>"$schedule_lifetime_run/client.log" 2>&1 || { tail -35 "$schedule_lifetime_run/client.log"; tail -25 "$schedule_lifetime_run/server.log"; exit 1; }
done
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$schedule_lifetime_run/client.log"; then
 echo 'FAIL: Routing journal runtime error'; tail -30 "$schedule_lifetime_run/client.log"; exit 1
fi
rg '^OK:' "$schedule_lifetime_run/client.log"
