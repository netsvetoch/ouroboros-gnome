#!/bin/sh
set -eu
response_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to pinned Ouroboros 7.10.0 source}
response_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$response_reference/VERSION")" = '7.10.0'
response_run=$(mktemp -d /tmp/ouroboros-optional-response.XXXXXX)
echo "Logs at $response_run"
"$response_python" tests/optional-response-server.py "$response_run" >"$response_run/server.log" 2>&1 &
response_pid=$!
trap 'kill "$response_pid" 2>/dev/null || true' EXIT
for i in $(seq 1 100); do test -s "$response_run/port" && break; sleep .1; done
test -s "$response_run/port"
response_url="http://127.0.0.1:$(cat "$response_run/port")"
node tests/optional-response-primary.mjs "$response_reference" "$response_url" "$response_run" >"$response_run/primary.log" 2>&1 || { cat "$response_run/primary.log"; exit 1; }
if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
 cp tests/optional-response-gjs.js "$response_run/client.js"
 timeout 90s dbus-run-session -- flatpak build --runtime --share=network --filesystem="$response_run":rw "$OUROBOROS_FLATPAK_BUILD" gjs -m "$response_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$response_url" "$response_run" >"$response_run/client.log" 2>&1 || { cat "$response_run/client.log"; exit 1; }
else
 timeout 90s dbus-run-session -- gjs -m tests/optional-response-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$response_url" "$response_run" >"$response_run/client.log" 2>&1 || { cat "$response_run/client.log"; exit 1; }
fi
if rg -q 'JS ERROR|CRITICAL|Unhandled promise rejection' "$response_run/client.log"; then cat "$response_run/client.log"; exit 1; fi
rg '^OK:' "$response_run/primary.log" "$response_run/client.log"
