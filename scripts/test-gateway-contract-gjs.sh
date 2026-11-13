#!/bin/sh
set -eu
gateway_contract_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
gateway_contract_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$gateway_contract_reference/VERSION")" = '7.10.0'
gateway_contract_run=$(mktemp -d /tmp/ouroboros-gateway-contract.XXXXXX)
echo "Logs at $gateway_contract_run"
gateway_contract_display=$((1000 + $$ % 20000))
PYTHONPATH="$gateway_contract_reference${PYTHONPATH:+:$PYTHONPATH}" "$gateway_contract_python" tests/gateway-contract-server.py "$gateway_contract_run" >"$gateway_contract_run/server.log" 2>&1 &
gateway_contract_pid=$!
cleanup_gateway_contract() {
 if test -s "$gateway_contract_run/port"; then
  "$gateway_contract_python" - "$gateway_contract_run/port" <<'PY'
import pathlib, sys, urllib.request
try:
    port=pathlib.Path(sys.argv[1]).read_text().strip()
    request=urllib.request.Request('http://127.0.0.1:'+port+'/fixture/control', data=b'{"action":"release-all"}', headers={'Content-Type':'application/json'})
    urllib.request.urlopen(request, timeout=2).close()
except Exception:
    pass
PY
 fi
 kill "$gateway_contract_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$gateway_contract_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$gateway_contract_pid" 2>/dev/null; then kill -KILL "$gateway_contract_pid" 2>/dev/null || true; fi
 wait "$gateway_contract_pid" 2>/dev/null || true
}
trap cleanup_gateway_contract EXIT
for i in $(seq 1 100); do test -s "$gateway_contract_run/port" && break; sleep .1; done
test -s "$gateway_contract_run/port" || { cat "$gateway_contract_run/server.log"; exit 1; }
gateway_contract_url="http://127.0.0.1:$(cat "$gateway_contract_run/port")"
run_gateway_contract_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/gateway-contract-gjs.js "$gateway_contract_run/client.js"
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$gateway_contract_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$gateway_contract_run":rw --env=XDG_STATE_HOME="$gateway_contract_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$gateway_contract_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$gateway_contract_url" "$gateway_contract_run"
 else
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$gateway_contract_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$gateway_contract_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/gateway-contract-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$gateway_contract_url" "$gateway_contract_run"
 fi
}
run_gateway_contract_client >"$gateway_contract_run/client.log" 2>&1 || { tail -35 "$gateway_contract_run/client.log"; tail -25 "$gateway_contract_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$gateway_contract_run/client.log"; then
 echo 'FAIL: Gateway contract runtime error'; tail -30 "$gateway_contract_run/client.log"; exit 1
fi
rg '^OK:' "$gateway_contract_run/client.log"
