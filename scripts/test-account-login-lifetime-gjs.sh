#!/bin/sh
set -eu
account_login_lifetime_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
account_login_lifetime_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$account_login_lifetime_reference/VERSION")" = '7.10.0'
account_login_lifetime_run=$(mktemp -d /tmp/ouroboros-account-login-lifetime.XXXXXX)
echo "Logs at $account_login_lifetime_run"
account_login_lifetime_display=$((1000 + $$ % 20000))
PYTHONPATH="$account_login_lifetime_reference${PYTHONPATH:+:$PYTHONPATH}" "$account_login_lifetime_python" tests/account-login-server.py "$account_login_lifetime_run" >"$account_login_lifetime_run/server.log" 2>&1 &
account_login_lifetime_pid=$!
cleanup_account_login() {
 if test -s "$account_login_lifetime_run/port"; then
  "$account_login_lifetime_python" - "$account_login_lifetime_run/port" <<'PY'
import pathlib, sys, urllib.request
try:
    port=pathlib.Path(sys.argv[1]).read_text().strip()
    request=urllib.request.Request('http://127.0.0.1:'+port+'/fixture/control', data=b'{"action":"release-all"}', headers={'Content-Type':'application/json'})
    urllib.request.urlopen(request, timeout=2).close()
except Exception:
    pass
PY
 fi
 kill "$account_login_lifetime_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$account_login_lifetime_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$account_login_lifetime_pid" 2>/dev/null; then kill -KILL "$account_login_lifetime_pid" 2>/dev/null || true; fi
 wait "$account_login_lifetime_pid" 2>/dev/null || true
}
trap cleanup_account_login EXIT
for i in $(seq 1 100); do test -s "$account_login_lifetime_run/port" && break; sleep .1; done
test -s "$account_login_lifetime_run/port" || { cat "$account_login_lifetime_run/server.log"; exit 1; }
account_login_lifetime_url="http://127.0.0.1:$(cat "$account_login_lifetime_run/port")"
run_account_login_lifetime_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/account-login-lifetime-gjs.js "$account_login_lifetime_run/client.js"
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$account_login_lifetime_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$account_login_lifetime_run":rw --env=XDG_STATE_HOME="$account_login_lifetime_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$account_login_lifetime_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$account_login_lifetime_url" "$account_login_lifetime_run"
 else
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$account_login_lifetime_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$account_login_lifetime_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/account-login-lifetime-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$account_login_lifetime_url" "$account_login_lifetime_run"
 fi
}
run_account_login_lifetime_client >"$account_login_lifetime_run/client.log" 2>&1 || { tail -35 "$account_login_lifetime_run/client.log"; tail -25 "$account_login_lifetime_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$account_login_lifetime_run/client.log"; then
 echo 'FAIL: Account login runtime error'; tail -30 "$account_login_lifetime_run/client.log"; exit 1
fi
rg '^OK:' "$account_login_lifetime_run/client.log"
