#!/bin/sh
set -eu
welcome_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
welcome_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$welcome_reference/VERSION")" = '7.10.0'
welcome_run=$(mktemp -d /tmp/ouroboros-chat-room.XXXXXX)
echo "Logs at $welcome_run"
PYTHONPATH="$welcome_reference${PYTHONPATH:+:$PYTHONPATH}" "$welcome_python" tests/chat-room-server.py "$welcome_run" >"$welcome_run/server.log" 2>&1 &
welcome_pid=$!
trap 'kill "$welcome_pid" 2>/dev/null || true' EXIT
for i in $(seq 1 100); do test -s "$welcome_run/port" && break; sleep .1; done
test -s "$welcome_run/port" || { cat "$welcome_run/server.log"; exit 1; }
welcome_url="http://127.0.0.1:$(cat "$welcome_run/port")"
run_welcome_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/chat-room-gjs.js "$welcome_run/client.js"
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$((1000 + $$ % 20000))" -s '-screen 0 1280x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$welcome_run":rw --env=XDG_STATE_HOME="$welcome_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none --env=GTK_IM_MODULE=simple "$OUROBOROS_FLATPAK_BUILD" gjs -m "$welcome_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$welcome_url" "$welcome_run"
 else
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$((1000 + $$ % 20000))" -s '-screen 0 1280x1000x24' env XDG_STATE_HOME="$welcome_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none GTK_IM_MODULE=simple gjs -m tests/chat-room-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$welcome_url" "$welcome_run"
 fi
}
OUROBOROS_REFERENCE="$welcome_reference" node --test tests/chat-room.test.mjs >"$welcome_run/oracle.log" 2>&1 || { cat "$welcome_run/oracle.log"; exit 1; }
run_welcome_client >"$welcome_run/client.log" 2>&1 || { tail -35 "$welcome_run/client.log"; tail -25 "$welcome_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$welcome_run/client.log"; then
 echo 'FAIL: chat welcome parsed literal text as Pango markup'; tail -30 "$welcome_run/client.log"; exit 1
fi
rg '^OK:' "$welcome_run/client.log"
