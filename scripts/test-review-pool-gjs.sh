#!/bin/sh
set -eu
review_pool_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
review_pool_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$review_pool_reference/VERSION")" = '7.10.0'
review_pool_run=$(mktemp -d /tmp/ouroboros-review-pool.XXXXXX)
echo "Logs at $review_pool_run"
review_pool_display=$((1000 + $$ % 20000))
PYTHONPATH="$review_pool_reference${PYTHONPATH:+:$PYTHONPATH}" "$review_pool_python" tests/review-pool-server.py "$review_pool_run" >"$review_pool_run/server.log" 2>&1 &
review_pool_pid=$!
cleanup_review_pool() {
 if test -s "$review_pool_run/port"; then
  "$review_pool_python" - "$review_pool_run/port" <<'PY'
import pathlib, sys, urllib.request
try:
    port=pathlib.Path(sys.argv[1]).read_text().strip()
    request=urllib.request.Request('http://127.0.0.1:'+port+'/fixture/control', data=b'{"action":"release-all"}', headers={'Content-Type':'application/json'})
    urllib.request.urlopen(request, timeout=2).close()
except Exception:
    pass
PY
 fi
 kill "$review_pool_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$review_pool_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$review_pool_pid" 2>/dev/null; then kill -KILL "$review_pool_pid" 2>/dev/null || true; fi
 wait "$review_pool_pid" 2>/dev/null || true
}
trap cleanup_review_pool EXIT
for i in $(seq 1 100); do test -s "$review_pool_run/port" && break; sleep .1; done
test -s "$review_pool_run/port" || { cat "$review_pool_run/server.log"; exit 1; }
review_pool_url="http://127.0.0.1:$(cat "$review_pool_run/port")"
run_review_pool_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/review-pool-gjs.js "$review_pool_run/client.js"
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$review_pool_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$review_pool_run":rw --env=XDG_STATE_HOME="$review_pool_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$review_pool_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$review_pool_url" "$review_pool_run"
 else
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$review_pool_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$review_pool_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/review-pool-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$review_pool_url" "$review_pool_run"
 fi
}
run_review_pool_client >"$review_pool_run/client.log" 2>&1 || { tail -35 "$review_pool_run/client.log"; tail -25 "$review_pool_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$review_pool_run/client.log"; then
 echo 'FAIL: Review pool runtime error'; tail -30 "$review_pool_run/client.log"; exit 1
fi
rg '^OK:' "$review_pool_run/client.log"
