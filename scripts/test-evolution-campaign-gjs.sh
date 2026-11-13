#!/bin/sh
set -eu
evolution_campaign_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
evolution_campaign_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$evolution_campaign_reference/VERSION")" = '7.10.0'
"$evolution_campaign_python" -c 'import starlette, uvicorn'
evolution_campaign_run=$(mktemp -d /tmp/ouroboros-evolution-campaign.XXXXXX)
echo "Logs at $evolution_campaign_run"
evolution_campaign_display=$((1000 + $$ % 20000))
PYTHONPATH="$evolution_campaign_reference${PYTHONPATH:+:$PYTHONPATH}" "$evolution_campaign_python" tests/evolution-campaign-server.py "$evolution_campaign_run" >"$evolution_campaign_run/server.log" 2>&1 &
evolution_campaign_pid=$!
cleanup_probes() {
 kill "$evolution_campaign_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$evolution_campaign_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$evolution_campaign_pid" 2>/dev/null; then kill -KILL "$evolution_campaign_pid" 2>/dev/null || true; fi
 wait "$evolution_campaign_pid" 2>/dev/null || true
}
trap cleanup_probes EXIT
for i in $(seq 1 100); do test -s "$evolution_campaign_run/port" && break; sleep .1; done
test -s "$evolution_campaign_run/port" || { cat "$evolution_campaign_run/server.log"; exit 1; }
evolution_campaign_url="http://127.0.0.1:$(cat "$evolution_campaign_run/port")"
run_evolution_campaign_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/evolution-campaign-gjs.js "$evolution_campaign_run/client.js"
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$evolution_campaign_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$evolution_campaign_run":rw --env=XDG_STATE_HOME="$evolution_campaign_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$evolution_campaign_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$evolution_campaign_url" "$evolution_campaign_run"
 else
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$evolution_campaign_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$evolution_campaign_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/evolution-campaign-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$evolution_campaign_url" "$evolution_campaign_run"
 fi
}
run_evolution_campaign_client >"$evolution_campaign_run/client.log" 2>&1 || { tail -35 "$evolution_campaign_run/client.log"; tail -25 "$evolution_campaign_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$evolution_campaign_run/client.log"; then
 echo 'FAIL: provider probes runtime error'; tail -30 "$evolution_campaign_run/client.log"; exit 1
fi
rg '^OK:' "$evolution_campaign_run/client.log"
