#!/bin/sh
set -eu
auth_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
auth_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$auth_reference/VERSION")" = '7.10.0'
auth_run=$(mktemp -d /tmp/ouroboros-gateway-auth.XXXXXX)
echo "Logs at $auth_run"
OUROBOROS_DATA_DIR="$auth_run/data" PYTHONPATH="$auth_reference${PYTHONPATH:+:$PYTHONPATH}" "$auth_python" tests/gateway-auth-server.py "$auth_run" >"$auth_run/server.log" 2>&1 &
auth_pid=$!
trap 'kill "$auth_pid" 2>/dev/null || true' EXIT
for i in $(seq 1 100); do test -s "$auth_run/ports.json" && break; sleep .1; done
test -s "$auth_run/ports.json" || { cat "$auth_run/server.log"; exit 1; }
auth_ports=$("$auth_python" -c 'import json,sys; p=json.load(open(sys.argv[1])); print(p["remote"],p["loopback"])' "$auth_run/ports.json")
set -- $auth_ports
auth_remote="http://127.0.0.1:$1"
auth_local="http://127.0.0.1:$2"
run_auth_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/gateway-auth-gjs.js "$auth_run/client.js"
  timeout 45s flatpak build --runtime --share=network --filesystem="$auth_run":rw "$OUROBOROS_FLATPAK_BUILD" gjs -m "$auth_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$auth_remote" "$auth_local"
 else
  timeout 45s gjs -m tests/gateway-auth-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$auth_remote" "$auth_local"
 fi
}
run_auth_client >"$auth_run/client.log" 2>&1 || { cat "$auth_run/client.log"; cat "$auth_run/server.log"; exit 1; }
rg '^OK:' "$auth_run/client.log"
