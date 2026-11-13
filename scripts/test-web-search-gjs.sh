#!/bin/sh
set -eu
web_search_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
web_search_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$web_search_reference/VERSION")" = '7.10.0'
web_search_run=$(mktemp -d /tmp/ouroboros-web-search.XXXXXX)
echo "Logs at $web_search_run"
web_search_display=$((1000 + $$ % 20000))
PYTHONPATH="$web_search_reference${PYTHONPATH:+:$PYTHONPATH}" "$web_search_python" tests/web-search-server.py "$web_search_run" >"$web_search_run/server.log" 2>&1 &
web_search_pid=$!
cleanup_web_search() {
 if test -s "$web_search_run/port"; then
  "$web_search_python" - "$web_search_run/port" <<'PY'
import pathlib, sys, urllib.request
try:
    port=pathlib.Path(sys.argv[1]).read_text().strip()
    request=urllib.request.Request('http://127.0.0.1:'+port+'/fixture/control', data=b'{"action":"release-all"}', headers={'Content-Type':'application/json'})
    urllib.request.urlopen(request, timeout=2).close()
except Exception:
    pass
PY
 fi
 kill "$web_search_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$web_search_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$web_search_pid" 2>/dev/null; then kill -KILL "$web_search_pid" 2>/dev/null || true; fi
 wait "$web_search_pid" 2>/dev/null || true
}
trap cleanup_web_search EXIT
for i in $(seq 1 100); do test -s "$web_search_run/port" && break; sleep .1; done
test -s "$web_search_run/port" || { cat "$web_search_run/server.log"; exit 1; }
web_search_url="http://127.0.0.1:$(cat "$web_search_run/port")"
run_web_search_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/web-search-gjs.js "$web_search_run/client.js"
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$web_search_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$web_search_run":rw --env=XDG_STATE_HOME="$web_search_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$web_search_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$web_search_url" "$web_search_run"
 else
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$web_search_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$web_search_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/web-search-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$web_search_url" "$web_search_run"
 fi
}
run_web_search_client >"$web_search_run/client.log" 2>&1 || { tail -35 "$web_search_run/client.log"; tail -25 "$web_search_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$web_search_run/client.log"; then
 echo 'FAIL: web-search runtime error'; tail -30 "$web_search_run/client.log"; exit 1
fi
rg '^OK:' "$web_search_run/client.log"
