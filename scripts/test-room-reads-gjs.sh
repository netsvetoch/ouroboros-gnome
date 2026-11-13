#!/bin/sh
set -eu
reads_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
reads_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$reads_reference/VERSION")" = '7.10.0'
reads_run=$(mktemp -d /tmp/ouroboros-room-reads.XXXXXX)
echo "Logs at $reads_run"
PYTHONPATH="$reads_reference${PYTHONPATH:+:$PYTHONPATH}" "$reads_python" tests/room-reads-server.py "$reads_run" >"$reads_run/server.log" 2>&1 &
reads_pid=$!
trap 'kill "$reads_pid" 2>/dev/null || true' EXIT
for i in $(seq 1 100); do test -s "$reads_run/port" && break; sleep .1; done
test -s "$reads_run/port" || { cat "$reads_run/server.log"; exit 1; }
reads_url="http://127.0.0.1:$(cat "$reads_run/port")"
run_reads_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/room-reads-gjs.js "$reads_run/client.js"
  timeout 100s dbus-run-session -- xvfb-run -a -s '-screen 0 1280x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$reads_run":rw --env=XDG_STATE_HOME="$reads_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$reads_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$reads_url" "$reads_run"
 else
  timeout 100s dbus-run-session -- xvfb-run -a -s '-screen 0 1280x1000x24' env XDG_STATE_HOME="$reads_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/room-reads-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$reads_url" "$reads_run"
 fi
}
run_reads_client >"$reads_run/client.log" 2>&1 || { tail -35 "$reads_run/client.log"; tail -25 "$reads_run/server.log"; exit 1; }
if rg -q 'from markup due to error parsing markup' "$reads_run/client.log"; then
 echo 'FAIL: read receipt parsed literal text as Pango markup'; tail -30 "$reads_run/client.log"; exit 1
fi
rg '^OK:' "$reads_run/client.log"
