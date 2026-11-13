#!/bin/sh
set -eu
translations_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
translations_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$translations_reference/VERSION")" = '7.10.0'
translations_run=$(mktemp -d /tmp/ouroboros-language-profile.XXXXXX)
echo "Logs at $translations_run"
PYTHONPATH="$translations_reference${PYTHONPATH:+:$PYTHONPATH}" "$translations_python" tests/translations-server.py "$translations_run" >"$translations_run/server.log" 2>&1 &
translations_pid=$!
cleanup_translations() {
 if test -s "$translations_run/port"; then
  "$translations_python" - "$translations_run/port" <<'PY'
import pathlib, sys, urllib.request
try:
    port=pathlib.Path(sys.argv[1]).read_text().strip()
    request=urllib.request.Request('http://127.0.0.1:'+port+'/fixture/control', data=b'{"action":"release-all"}', headers={'Content-Type':'application/json'})
    urllib.request.urlopen(request, timeout=2).close()
except Exception:
    pass
PY
 fi
 kill "$translations_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$translations_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$translations_pid" 2>/dev/null; then kill -KILL "$translations_pid" 2>/dev/null || true; fi
 wait "$translations_pid" 2>/dev/null || true
}
trap cleanup_translations EXIT
for i in $(seq 1 100); do test -s "$translations_run/port" && break; sleep .1; done
test -s "$translations_run/port" || { cat "$translations_run/server.log"; exit 1; }
translations_url="http://127.0.0.1:$(cat "$translations_run/port")"
run_translations_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/language-profile-gjs.js "$translations_run/client.js"
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$((1000 + $$ % 20000))" -s '-screen 0 1280x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$translations_run":rw --env=XDG_STATE_HOME="$translations_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none --env=GTK_IM_MODULE=simple "$OUROBOROS_FLATPAK_BUILD" gjs -m "$translations_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$translations_url" "$translations_run"
 else
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$((1000 + $$ % 20000))" -s '-screen 0 1280x1000x24' env XDG_STATE_HOME="$translations_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none GTK_IM_MODULE=simple gjs -m tests/language-profile-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$translations_url" "$translations_run"
 fi
}
run_translations_client >"$translations_run/client.log" 2>&1 || { tail -35 "$translations_run/client.log"; tail -25 "$translations_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$translations_run/client.log"; then
 echo 'FAIL: language profile runtime error or invalid markup'; tail -30 "$translations_run/client.log"; exit 1
fi
rg '^OK:' "$translations_run/client.log"
