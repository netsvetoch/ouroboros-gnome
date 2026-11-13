#!/bin/sh
set -eu
reviews_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
reviews_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$reviews_reference/VERSION")" = '7.10.0'
reviews_run=$(mktemp -d /tmp/ouroboros-task-reviews.XXXXXX)
echo "Logs at $reviews_run"
PYTHONPATH="$reviews_reference${PYTHONPATH:+:$PYTHONPATH}" "$reviews_python" tests/task-reviews-server.py "$reviews_run" >"$reviews_run/server.log" 2>&1 &
reviews_pid=$!
trap 'kill "$reviews_pid" 2>/dev/null || true' EXIT
for i in $(seq 1 100); do test -s "$reviews_run/port" && break; sleep .1; done
test -s "$reviews_run/port" || { cat "$reviews_run/server.log"; exit 1; }
reviews_url="http://127.0.0.1:$(cat "$reviews_run/port")"
run_reviews_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/task-reviews-gjs.js "$reviews_run/client.js"
  timeout 100s dbus-run-session -- xvfb-run -a -s '-screen 0 1280x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$reviews_run":rw --env=XDG_STATE_HOME="$reviews_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$reviews_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$reviews_url" "$reviews_run"
 else
  timeout 100s dbus-run-session -- xvfb-run -a -s '-screen 0 1280x1000x24' env XDG_STATE_HOME="$reviews_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/task-reviews-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$reviews_url" "$reviews_run"
 fi
}
run_reviews_client >"$reviews_run/client.log" 2>&1 || { tail -35 "$reviews_run/client.log"; tail -25 "$reviews_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$reviews_run/client.log"; then
 echo 'FAIL: task reviews parsed a literal value as Pango markup'; tail -30 "$reviews_run/client.log"; exit 1
fi
rg '^OK:' "$reviews_run/client.log"
