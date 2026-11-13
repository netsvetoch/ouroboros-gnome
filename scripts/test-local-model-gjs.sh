#!/bin/sh
set -eu
local_model_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
local_model_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$local_model_reference/VERSION")" = '7.10.0'
"$local_model_python" -c 'import openai, requests; print("OpenAI SDK " + openai.__version__)'
local_model_run=$(mktemp -d /tmp/ouroboros-local-model.XXXXXX)
echo "Logs at $local_model_run"
local_model_display=$((1000 + $$ % 20000))
PYTHONPATH="$local_model_reference${PYTHONPATH:+:$PYTHONPATH}" "$local_model_python" tests/local-model-server.py "$local_model_run" >"$local_model_run/server.log" 2>&1 &
local_model_pid=$!
cleanup_local_model() {
 if test -s "$local_model_run/port"; then
  "$local_model_python" - "$local_model_run/port" <<'PY'
import pathlib, sys, urllib.request
try:
    port=pathlib.Path(sys.argv[1]).read_text().strip()
    request=urllib.request.Request('http://127.0.0.1:'+port+'/fixture/control', data=b'{"action":"release-start"}', headers={'Content-Type':'application/json'})
    urllib.request.urlopen(request, timeout=2).close()
except Exception:
    pass
PY
 fi
 kill "$local_model_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$local_model_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$local_model_pid" 2>/dev/null; then kill -KILL "$local_model_pid" 2>/dev/null || true; fi
 wait "$local_model_pid" 2>/dev/null || true
}
trap cleanup_local_model EXIT
for i in $(seq 1 100); do test -s "$local_model_run/port" && break; sleep .1; done
test -s "$local_model_run/port" || { cat "$local_model_run/server.log"; exit 1; }
local_model_url="http://127.0.0.1:$(cat "$local_model_run/port")"
run_local_model_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/local-model-gjs.js "$local_model_run/client.js"
  timeout 150s dbus-run-session -- xvfb-run -a --server-num="$local_model_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$local_model_run":rw --env=XDG_STATE_HOME="$local_model_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$local_model_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$local_model_url" "$local_model_run"
 else
  timeout 150s dbus-run-session -- xvfb-run -a --server-num="$local_model_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$local_model_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/local-model-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$local_model_url" "$local_model_run"
 fi
}
run_local_model_client >"$local_model_run/client.log" 2>&1 || { tail -35 "$local_model_run/client.log"; tail -25 "$local_model_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$local_model_run/client.log"; then
 echo 'FAIL: Local model runtime error'; tail -30 "$local_model_run/client.log"; exit 1
fi
rg '^OK:' "$local_model_run/client.log"
