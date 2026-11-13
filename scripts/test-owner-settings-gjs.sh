#!/bin/sh
set -eu
owner_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
owner_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$owner_reference/VERSION")" = '7.10.0'
owner_run=$(mktemp -d /tmp/ouroboros-owner-settings.XXXXXX)
echo "Logs at $owner_run"
PYTHONPATH="$owner_reference${PYTHONPATH:+:$PYTHONPATH}" "$owner_python" tests/owner-settings-server.py "$owner_run" >"$owner_run/server.log" 2>&1 &
owner_pid=$!
trap 'kill "$owner_pid" 2>/dev/null || true' EXIT
for i in $(seq 1 100); do test -s "$owner_run/port" && break; sleep .1; done
test -s "$owner_run/port" || { cat "$owner_run/server.log"; exit 1; }
owner_url="http://127.0.0.1:$(cat "$owner_run/port")"
run_owner_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/owner-settings-gjs.js "$owner_run/client.js"
  timeout 100s dbus-run-session -- xvfb-run -a -s '-screen 0 1280x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$owner_run":rw --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$owner_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$owner_url" "$owner_run"
 else
  timeout 100s dbus-run-session -- xvfb-run -a -s '-screen 0 1280x1000x24' env GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/owner-settings-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$owner_url" "$owner_run"
 fi
}
run_owner_client >"$owner_run/client.log" 2>&1 || { tail -40 "$owner_run/client.log"; tail -25 "$owner_run/server.log"; exit 1; }
if rg -q 'from markup due to error parsing markup' "$owner_run/client.log"; then
 echo 'FAIL: a literal setting was parsed as Pango markup'; tail -30 "$owner_run/client.log"; exit 1
fi
rg '^OK:' "$owner_run/client.log"
