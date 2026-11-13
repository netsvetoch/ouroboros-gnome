#!/bin/sh
set -eu
account_maintenance_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
account_maintenance_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$account_maintenance_reference/VERSION")" = '7.10.0'
account_maintenance_run=$(mktemp -d /tmp/ouroboros-account-maintenance.XXXXXX)
echo "Logs at $account_maintenance_run"
account_maintenance_display=$((1000 + $$ % 20000))
PYTHONPATH="$account_maintenance_reference${PYTHONPATH:+:$PYTHONPATH}" "$account_maintenance_python" tests/account-maintenance-server.py "$account_maintenance_run" >"$account_maintenance_run/server.log" 2>&1 &
account_maintenance_pid=$!
cleanup_account_maintenance() {
 if test -s "$account_maintenance_run/port"; then
  "$account_maintenance_python" - "$account_maintenance_run/port" <<'PY'
import pathlib, sys, urllib.request
try:
    port=pathlib.Path(sys.argv[1]).read_text().strip()
    request=urllib.request.Request('http://127.0.0.1:'+port+'/fixture/control', data=b'{"action":"release-all"}', headers={'Content-Type':'application/json'})
    urllib.request.urlopen(request, timeout=2).close()
except Exception:
    pass
PY
 fi
 kill "$account_maintenance_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$account_maintenance_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$account_maintenance_pid" 2>/dev/null; then kill -KILL "$account_maintenance_pid" 2>/dev/null || true; fi
 wait "$account_maintenance_pid" 2>/dev/null || true
}
trap cleanup_account_maintenance EXIT
for i in $(seq 1 100); do test -s "$account_maintenance_run/port" && break; sleep .1; done
test -s "$account_maintenance_run/port" || { cat "$account_maintenance_run/server.log"; exit 1; }
account_maintenance_url="http://127.0.0.1:$(cat "$account_maintenance_run/port")"
run_account_maintenance_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/account-maintenance-gjs.js "$account_maintenance_run/client.js"
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$account_maintenance_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$account_maintenance_run":rw --env=XDG_STATE_HOME="$account_maintenance_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$account_maintenance_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$account_maintenance_url" "$account_maintenance_run"
 else
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$account_maintenance_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$account_maintenance_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/account-maintenance-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$account_maintenance_url" "$account_maintenance_run"
 fi
}
run_account_maintenance_client >"$account_maintenance_run/client.log" 2>&1 || { tail -35 "$account_maintenance_run/client.log"; tail -25 "$account_maintenance_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$account_maintenance_run/client.log"; then
 echo 'FAIL: Account maintenance runtime error'; tail -30 "$account_maintenance_run/client.log"; exit 1
fi
rg '^OK:' "$account_maintenance_run/client.log"
