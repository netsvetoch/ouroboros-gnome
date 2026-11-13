#!/bin/sh
set -eu
provider_probes_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
provider_probes_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$provider_probes_reference/VERSION")" = '7.10.0'
"$provider_probes_python" -c 'import openai; print("OpenAI SDK " + openai.__version__)'
provider_probes_run=$(mktemp -d /tmp/ouroboros-provider-probes.XXXXXX)
echo "Logs at $provider_probes_run"
provider_probes_display=$((1000 + $$ % 20000))
PYTHONPATH="$provider_probes_reference${PYTHONPATH:+:$PYTHONPATH}" "$provider_probes_python" tests/provider-probes-server.py "$provider_probes_run" >"$provider_probes_run/server.log" 2>&1 &
provider_probes_pid=$!
cleanup_probes() {
 kill "$provider_probes_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$provider_probes_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$provider_probes_pid" 2>/dev/null; then kill -KILL "$provider_probes_pid" 2>/dev/null || true; fi
 wait "$provider_probes_pid" 2>/dev/null || true
}
trap cleanup_probes EXIT
for i in $(seq 1 100); do test -s "$provider_probes_run/port" && break; sleep .1; done
test -s "$provider_probes_run/port" || { cat "$provider_probes_run/server.log"; exit 1; }
provider_probes_url="http://127.0.0.1:$(cat "$provider_probes_run/port")"
run_provider_probes_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/provider-probes-gjs.js "$provider_probes_run/client.js"
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$provider_probes_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$provider_probes_run":rw --env=XDG_STATE_HOME="$provider_probes_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$provider_probes_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$provider_probes_url" "$provider_probes_run"
 else
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$provider_probes_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$provider_probes_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/provider-probes-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$provider_probes_url" "$provider_probes_run"
 fi
}
run_provider_probes_client >"$provider_probes_run/client.log" 2>&1 || { tail -35 "$provider_probes_run/client.log"; tail -25 "$provider_probes_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$provider_probes_run/client.log"; then
 echo 'FAIL: provider probes runtime error'; tail -30 "$provider_probes_run/client.log"; exit 1
fi
rg '^OK:' "$provider_probes_run/client.log"
