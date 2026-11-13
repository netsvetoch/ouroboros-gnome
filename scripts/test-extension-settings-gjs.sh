#!/bin/sh
set -eu
extension_settings_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
extension_settings_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$extension_settings_reference/VERSION")" = '7.10.0'
extension_settings_run=$(mktemp -d /tmp/ouroboros-extension-settings.XXXXXX)
echo "Logs at $extension_settings_run"
extension_settings_display=$((1000 + $$ % 20000))
PYTHONPATH="$extension_settings_reference${PYTHONPATH:+:$PYTHONPATH}" "$extension_settings_python" tests/extension-settings-server.py "$extension_settings_run" >"$extension_settings_run/server.log" 2>&1 &
extension_settings_pid=$!
cleanup_extension_settings() {
 if test -s "$extension_settings_run/port"; then
  "$extension_settings_python" - "$extension_settings_run/port" <<'PY'
import pathlib, sys, urllib.request
try:
    port=pathlib.Path(sys.argv[1]).read_text().strip()
    request=urllib.request.Request('http://127.0.0.1:'+port+'/fixture/control', data=b'{"action":"release-all"}', headers={'Content-Type':'application/json'})
    urllib.request.urlopen(request, timeout=2).close()
except Exception:
    pass
PY
 fi
 kill "$extension_settings_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$extension_settings_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$extension_settings_pid" 2>/dev/null; then kill -KILL "$extension_settings_pid" 2>/dev/null || true; fi
 wait "$extension_settings_pid" 2>/dev/null || true
}
trap cleanup_extension_settings EXIT
for i in $(seq 1 100); do test -s "$extension_settings_run/port" && break; sleep .1; done
test -s "$extension_settings_run/port" || { cat "$extension_settings_run/server.log"; exit 1; }
extension_settings_url="http://127.0.0.1:$(cat "$extension_settings_run/port")"
run_extension_settings_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/extension-settings-gjs.js "$extension_settings_run/client.js"
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$extension_settings_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$extension_settings_run":rw --env=XDG_STATE_HOME="$extension_settings_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$extension_settings_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$extension_settings_url" "$extension_settings_run"
 else
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$extension_settings_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$extension_settings_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/extension-settings-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$extension_settings_url" "$extension_settings_run"
 fi
}
run_extension_settings_client >"$extension_settings_run/client.log" 2>&1 || { tail -35 "$extension_settings_run/client.log"; tail -25 "$extension_settings_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$extension_settings_run/client.log"; then
 echo 'FAIL: Extension settings runtime error'; tail -30 "$extension_settings_run/client.log"; exit 1
fi
rg '^OK:' "$extension_settings_run/client.log"
