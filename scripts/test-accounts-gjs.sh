#!/bin/sh
set -eu
accounts_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
accounts_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$accounts_reference/VERSION")" = '7.10.0'
accounts_run=$(mktemp -d /tmp/ouroboros-accounts.XXXXXX)
echo "Logs at $accounts_run"
accounts_display=$((1000 + $$ % 20000))
PYTHONPATH="$accounts_reference${PYTHONPATH:+:$PYTHONPATH}" "$accounts_python" tests/accounts-server.py "$accounts_run" >"$accounts_run/server.log" 2>&1 &
accounts_pid=$!
cleanup_accounts() {
 if test -s "$accounts_run/port"; then
  "$accounts_python" - "$accounts_run/port" <<'PY'
import pathlib, sys, urllib.request
try:
    port=pathlib.Path(sys.argv[1]).read_text().strip()
    request=urllib.request.Request('http://127.0.0.1:'+port+'/fixture/control', data=b'{"action":"release-all"}', headers={'Content-Type':'application/json'})
    urllib.request.urlopen(request, timeout=2).close()
except Exception:
    pass
PY
 fi
 kill "$accounts_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$accounts_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$accounts_pid" 2>/dev/null; then kill -KILL "$accounts_pid" 2>/dev/null || true; fi
 wait "$accounts_pid" 2>/dev/null || true
}
trap cleanup_accounts EXIT
for i in $(seq 1 100); do test -s "$accounts_run/port" && break; sleep .1; done
test -s "$accounts_run/port" || { cat "$accounts_run/server.log"; exit 1; }
accounts_url="http://127.0.0.1:$(cat "$accounts_run/port")"
run_accounts_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/accounts-gjs.js "$accounts_run/client.js"
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$accounts_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$accounts_run":rw --env=XDG_STATE_HOME="$accounts_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$accounts_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$accounts_url" "$accounts_run"
 else
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$accounts_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$accounts_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/accounts-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$accounts_url" "$accounts_run"
 fi
}
run_accounts_client >"$accounts_run/client.log" 2>&1 || { tail -35 "$accounts_run/client.log"; tail -25 "$accounts_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$accounts_run/client.log"; then
 echo 'FAIL: Accounts runtime error'; tail -30 "$accounts_run/client.log"; exit 1
fi
rg '^OK:' "$accounts_run/client.log"
