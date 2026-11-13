#!/bin/sh
set -eu
portal_run=$(mktemp -d /tmp/ouroboros-call-devices.XXXXXX)
echo "Logs at $portal_run"
portal_python=${OUROBOROS_PORTAL_TEST_PYTHON:-/usr/bin/python3}
portal_display=$((1000 + $$ % 20000))
export portal_run portal_python
cp tests/call-portal-server.py "$portal_run/server.py"
cp tests/call-devices-gjs.js "$portal_run/client.js"
export portal_dist="file://$(pwd)/dist-gjs/gjs/"
run_portal_fixture() {
 timeout 90s dbus-run-session -- xvfb-run -a --server-num="$portal_display" -s '-screen 0 1200x800x24' sh -eu -c '
  "$portal_python" "$portal_run/server.py" "$portal_run" >"$portal_run/server.log" 2>&1 &
  portal_pid=$!
  trap '\''kill "$portal_pid" 2>/dev/null || true; wait "$portal_pid" 2>/dev/null || true'\'' EXIT
  for i in $(seq 1 100); do test -f "$portal_run/ready" && break; sleep .1; done
  test -f "$portal_run/ready"
  if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
   flatpak build --runtime --socket=x11 --talk-name=org.freedesktop.portal.Desktop --filesystem="$portal_run":rw --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none --env=XDG_CONFIG_HOME="$portal_run/config" "$OUROBOROS_FLATPAK_BUILD" gjs -m "$portal_run/client.js" file:///app/share/ouroboros-ts-client/gjs/
  else
   env GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none XDG_CONFIG_HOME="$portal_run/config" gjs -m "$portal_run/client.js" "$portal_dist"
  fi
 '
}
run_portal_fixture >"$portal_run/client.log" 2>&1 || { tail -35 "$portal_run/client.log"; tail -25 "$portal_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|Traceback' "$portal_run/client.log" "$portal_run/server.log"; then cat "$portal_run/client.log" "$portal_run/server.log"; exit 1; fi
rg '^OK:' "$portal_run/client.log"
