#!/bin/sh
set -eu
places_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
places_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$places_reference/VERSION")" = '7.10.0'
places_run=$(mktemp -d /tmp/ouroboros-places-read.XXXXXX)
echo "Logs at $places_run"
places_display=$((1000 + $$ % 20000))
PYTHONPATH="$places_reference${PYTHONPATH:+:$PYTHONPATH}" "$places_python" tests/places-server.py "$places_run" >"$places_run/server.log" 2>&1 &
places_pid=$!
cleanup_places_read() {
 kill "$places_pid" 2>/dev/null || true
 wait "$places_pid" 2>/dev/null || true
}
trap cleanup_places_read EXIT
for i in $(seq 1 100); do test -s "$places_run/port" && break; sleep .1; done
test -s "$places_run/port" || { cat "$places_run/server.log"; exit 1; }
places_url="http://127.0.0.1:$(cat "$places_run/port")"
run_places_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/places-read-gjs.js "$places_run/client.js"
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$places_display" -s '-screen 0 1280x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$places_run":rw --env=XDG_STATE_HOME="$places_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$places_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$places_url" "$places_run"
 else
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$places_display" -s '-screen 0 1280x1000x24' env XDG_STATE_HOME="$places_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/places-read-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$places_url" "$places_run"
 fi
}
run_places_client >"$places_run/client.log" 2>&1 || { tail -35 "$places_run/client.log"; tail -25 "$places_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$places_run/client.log"; then
 echo 'FAIL: Place read or receipt runtime error'; tail -30 "$places_run/client.log"; exit 1
fi
rg '^OK:' "$places_run/client.log"
