#!/bin/sh
set -eu
onboarding_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
onboarding_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$onboarding_reference/VERSION")" = '7.10.0'
onboarding_run=$(mktemp -d /tmp/ouroboros-onboarding.XXXXXX)
echo "Logs at $onboarding_run"
onboarding_display=$((1000 + $$ % 20000))
PYTHONPATH="$onboarding_reference${PYTHONPATH:+:$PYTHONPATH}" "$onboarding_python" tests/onboarding-server.py "$onboarding_run" >"$onboarding_run/server.log" 2>&1 &
onboarding_pid=$!
cleanup_onboarding() {
 if test -s "$onboarding_run/port"; then
  "$onboarding_python" - "$onboarding_run/port" <<'PY'
import pathlib, sys, urllib.request
try:
    port=pathlib.Path(sys.argv[1]).read_text().strip()
    request=urllib.request.Request('http://127.0.0.1:'+port+'/fixture/control', data=b'{"action":"release-all"}', headers={'Content-Type':'application/json'})
    urllib.request.urlopen(request, timeout=2).close()
except Exception:
    pass
PY
 fi
 kill "$onboarding_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$onboarding_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$onboarding_pid" 2>/dev/null; then kill -KILL "$onboarding_pid" 2>/dev/null || true; fi
 wait "$onboarding_pid" 2>/dev/null || true
}
trap cleanup_onboarding EXIT
for i in $(seq 1 100); do test -s "$onboarding_run/port" && break; sleep .1; done
test -s "$onboarding_run/port" || { cat "$onboarding_run/server.log"; exit 1; }
onboarding_url="http://127.0.0.1:$(cat "$onboarding_run/port")"
run_onboarding_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/onboarding-gjs.js "$onboarding_run/client.js"
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$onboarding_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$onboarding_run":rw --env=XDG_STATE_HOME="$onboarding_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$onboarding_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$onboarding_url" "$onboarding_run"
 else
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$onboarding_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$onboarding_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/onboarding-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$onboarding_url" "$onboarding_run"
 fi
}
run_onboarding_client >"$onboarding_run/client.log" 2>&1 || { tail -35 "$onboarding_run/client.log"; tail -25 "$onboarding_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$onboarding_run/client.log"; then
 echo 'FAIL: onboarding runtime error'; tail -30 "$onboarding_run/client.log"; exit 1
fi
rg '^OK:' "$onboarding_run/client.log"
