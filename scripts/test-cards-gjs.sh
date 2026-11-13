#!/bin/sh
set -eu
cards_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
cards_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$cards_reference/VERSION")" = '7.10.0'
cards_run=$(mktemp -d /tmp/ouroboros-cards.XXXXXX)
echo "Logs at $cards_run"
PYTHONPATH="$cards_reference${PYTHONPATH:+:$PYTHONPATH}" "$cards_python" tests/cards-server.py "$cards_run" >"$cards_run/server.log" 2>&1 &
cards_pid=$!
trap 'kill "$cards_pid" 2>/dev/null || true' EXIT
for i in $(seq 1 100); do test -s "$cards_run/port" && break; sleep .1; done
test -s "$cards_run/port" || { cat "$cards_run/server.log"; exit 1; }
cards_url="http://127.0.0.1:$(cat "$cards_run/port")"
run_cards_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/cards-gjs.js "$cards_run/client.js"
  timeout 100s dbus-run-session -- xvfb-run -a -s '-screen 0 1280x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$cards_run":rw --env=XDG_STATE_HOME="$cards_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$cards_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$cards_url" "$cards_run"
 else
  timeout 100s dbus-run-session -- xvfb-run -a -s '-screen 0 1280x1000x24' env XDG_STATE_HOME="$cards_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/cards-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$cards_url" "$cards_run"
 fi
}
run_cards_client >"$cards_run/client.log" 2>&1 || { tail -35 "$cards_run/client.log"; tail -25 "$cards_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$cards_run/client.log"; then
 echo 'FAIL: a Card parsed a literal value as Pango markup'; tail -30 "$cards_run/client.log"; exit 1
fi
rg '^OK:' "$cards_run/client.log"
