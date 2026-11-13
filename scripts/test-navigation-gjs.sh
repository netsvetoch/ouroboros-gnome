#!/bin/sh
set -eu
navigation_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
navigation_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$navigation_reference/VERSION")" = '7.10.0'
navigation_run=$(mktemp -d /tmp/ouroboros-navigation.XXXXXX)
echo "Logs at $navigation_run"
navigation_display=$((1000 + $$ % 20000))
PYTHONPATH="$navigation_reference${PYTHONPATH:+:$PYTHONPATH}" "$navigation_python" tests/room-reads-server.py "$navigation_run" >"$navigation_run/server.log" 2>&1 &
navigation_pid=$!
trap 'kill "$navigation_pid" 2>/dev/null || true' EXIT
for i in $(seq 1 100); do test -s "$navigation_run/port" && break; sleep .1; done
test -s "$navigation_run/port" || { cat "$navigation_run/server.log"; exit 1; }
navigation_url="http://127.0.0.1:$(cat "$navigation_run/port")"
run_navigation_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/navigation-gjs.js "$navigation_run/client.js"
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$navigation_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$navigation_run":rw --env=XDG_STATE_HOME="$navigation_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$navigation_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$navigation_url" "$navigation_run"
 else
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$navigation_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$navigation_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/navigation-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$navigation_url" "$navigation_run"
 fi
}
run_navigation_client >"$navigation_run/client.log" 2>&1 || { tail -35 "$navigation_run/client.log"; tail -25 "$navigation_run/server.log"; exit 1; }
if rg -q 'from markup due to error parsing markup' "$navigation_run/client.log"; then
 echo 'FAIL: navigation parsed literal text as Pango markup'; tail -30 "$navigation_run/client.log"; exit 1
fi
rg '^OK:' "$navigation_run/client.log"
navigation_display=$((navigation_display + 1))
run_navigation_app() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/navigation-app-gjs.js "$navigation_run/app.js"
  timeout 35s dbus-run-session -- xvfb-run -a --server-num="$navigation_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$navigation_run":rw --env=XDG_CONFIG_HOME="$navigation_run/app-config" --env=XDG_STATE_HOME="$navigation_run/app-state" --env=OUROBOROS_URL="$navigation_url" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$navigation_run/app.js" file:///app/share/ouroboros-ts-client/gjs/
 else
  timeout 35s dbus-run-session -- xvfb-run -a --server-num="$navigation_display" -s '-screen 0 1600x1000x24' env XDG_CONFIG_HOME="$navigation_run/app-config" XDG_STATE_HOME="$navigation_run/app-state" OUROBOROS_URL="$navigation_url" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/navigation-app-gjs.js "file://$(pwd)/dist-gjs/gjs/"
 fi
}
run_navigation_app >"$navigation_run/app.log" 2>&1 || { tail -25 "$navigation_run/app.log"; exit 1; }
if rg -q 'JS ERROR|Gtk-CRITICAL|Adwaita-CRITICAL|already has a parent' "$navigation_run/app.log"; then
 tail -30 "$navigation_run/app.log"; exit 1
fi
rg '^OK:' "$navigation_run/app.log"
