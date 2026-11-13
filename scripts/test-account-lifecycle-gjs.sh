#!/bin/sh
set -eu
account_lifecycle_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
account_lifecycle_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$account_lifecycle_reference/VERSION")" = '7.10.0'
account_lifecycle_run=$(mktemp -d /tmp/ouroboros-account-lifecycle.XXXXXX)
echo "Logs at $account_lifecycle_run"
account_lifecycle_display=$((1000 + $$ % 20000))
PYTHONPATH="$account_lifecycle_reference${PYTHONPATH:+:$PYTHONPATH}" "$account_lifecycle_python" tests/accounts-server.py "$account_lifecycle_run" --lifecycle >"$account_lifecycle_run/server.log" 2>&1 &
account_lifecycle_pid=$!
cleanup_account_lifecycle() {
 if test -s "$account_lifecycle_run/port"; then
  "$account_lifecycle_python" - "$account_lifecycle_run/port" <<'PY'
import pathlib, sys, urllib.request
try:
    port=pathlib.Path(sys.argv[1]).read_text().strip()
    request=urllib.request.Request('http://127.0.0.1:'+port+'/fixture/control', data=b'{"action":"release-all"}', headers={'Content-Type':'application/json'})
    urllib.request.urlopen(request, timeout=2).close()
except Exception:
    pass
PY
 fi
 kill "$account_lifecycle_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$account_lifecycle_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$account_lifecycle_pid" 2>/dev/null; then kill -KILL "$account_lifecycle_pid" 2>/dev/null || true; fi
 wait "$account_lifecycle_pid" 2>/dev/null || true
}
trap cleanup_account_lifecycle EXIT
for i in $(seq 1 100); do test -s "$account_lifecycle_run/port" && break; sleep .1; done
test -s "$account_lifecycle_run/port" || { cat "$account_lifecycle_run/server.log"; exit 1; }
account_lifecycle_url="http://127.0.0.1:$(cat "$account_lifecycle_run/port")"
run_account_lifecycle_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/account-lifecycle-gjs.js "$account_lifecycle_run/client.js"
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$account_lifecycle_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$account_lifecycle_run":rw --env=XDG_STATE_HOME="$account_lifecycle_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$account_lifecycle_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$account_lifecycle_url" "$account_lifecycle_run"
 else
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$account_lifecycle_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$account_lifecycle_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/account-lifecycle-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$account_lifecycle_url" "$account_lifecycle_run"
 fi
}
run_account_lifecycle_client >"$account_lifecycle_run/client.log" 2>&1 || { tail -35 "$account_lifecycle_run/client.log"; tail -25 "$account_lifecycle_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$account_lifecycle_run/client.log"; then
 echo 'FAIL: Accounts runtime error'; tail -30 "$account_lifecycle_run/client.log"; exit 1
fi
rg '^OK:' "$account_lifecycle_run/client.log"
