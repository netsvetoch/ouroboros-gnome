#!/bin/sh
set -eu
card_lifetime_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
card_lifetime_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$card_lifetime_reference/VERSION")" = '7.10.0'
card_lifetime_run=$(mktemp -d /tmp/ouroboros-card-lifetime.XXXXXX)
echo "Logs at $card_lifetime_run"
card_lifetime_display=$((1000 + $$ % 20000))
PYTHONPATH="$card_lifetime_reference${PYTHONPATH:+:$PYTHONPATH}" "$card_lifetime_python" tests/cards-server.py "$card_lifetime_run" lifetime >"$card_lifetime_run/server.log" 2>&1 &
card_lifetime_pid=$!
cleanup_storage() {
 if test -s "$card_lifetime_run/port"; then
  "$card_lifetime_python" - "$card_lifetime_run/port" <<'PY'
import pathlib, sys, urllib.request
try:
    port=pathlib.Path(sys.argv[1]).read_text().strip()
    request=urllib.request.Request('http://127.0.0.1:'+port+'/fixture/control', data=b'{"action":"release-all"}', headers={'Content-Type':'application/json'})
    urllib.request.urlopen(request, timeout=2).close()
except Exception:
    pass
PY
 fi
 kill "$card_lifetime_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$card_lifetime_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$card_lifetime_pid" 2>/dev/null; then kill -KILL "$card_lifetime_pid" 2>/dev/null || true; fi
 wait "$card_lifetime_pid" 2>/dev/null || true
}
trap cleanup_storage EXIT
for i in $(seq 1 100); do test -s "$card_lifetime_run/port" && break; sleep .1; done
test -s "$card_lifetime_run/port" || { cat "$card_lifetime_run/server.log"; exit 1; }
card_lifetime_url="http://127.0.0.1:$(cat "$card_lifetime_run/port")"
run_card_lifetime_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/card-lifetime-gjs.js "$card_lifetime_run/client.js"
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$card_lifetime_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$card_lifetime_run":rw --env=XDG_STATE_HOME="$card_lifetime_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$card_lifetime_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$card_lifetime_url" "$card_lifetime_run"
 else
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$card_lifetime_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$card_lifetime_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/card-lifetime-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$card_lifetime_url" "$card_lifetime_run"
 fi
}
run_card_lifetime_client >"$card_lifetime_run/client.log" 2>&1 || { tail -35 "$card_lifetime_run/client.log"; tail -25 "$card_lifetime_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$card_lifetime_run/client.log"; then
 echo 'FAIL: Storage runtime error'; tail -30 "$card_lifetime_run/client.log"; exit 1
fi
rg '^OK:' "$card_lifetime_run/client.log"
