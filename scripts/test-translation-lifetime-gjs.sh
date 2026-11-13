#!/bin/sh
set -eu
translation_lifetime_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
translation_lifetime_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$translation_lifetime_reference/VERSION")" = '7.10.0'
translation_lifetime_run=$(mktemp -d /tmp/ouroboros-translation-lifetime.XXXXXX)
echo "Logs at $translation_lifetime_run"
translation_lifetime_display=$((1000 + $$ % 20000))
PYTHONPATH="$translation_lifetime_reference${PYTHONPATH:+:$PYTHONPATH}" "$translation_lifetime_python" tests/translations-server.py "$translation_lifetime_run" >"$translation_lifetime_run/server.log" 2>&1 &
translation_lifetime_pid=$!
cleanup_translation_lifetime() {
 if test -s "$translation_lifetime_run/port"; then
  "$translation_lifetime_python" - "$translation_lifetime_run/port" <<'PY'
import pathlib, sys, urllib.request
try:
    port=pathlib.Path(sys.argv[1]).read_text().strip()
    request=urllib.request.Request('http://127.0.0.1:'+port+'/fixture/control', data=b'{"action":"release-all"}', headers={'Content-Type':'application/json'})
    urllib.request.urlopen(request, timeout=2).close()
except Exception:
    pass
PY
 fi
 kill "$translation_lifetime_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$translation_lifetime_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$translation_lifetime_pid" 2>/dev/null; then kill -KILL "$translation_lifetime_pid" 2>/dev/null || true; fi
 wait "$translation_lifetime_pid" 2>/dev/null || true
}
trap cleanup_translation_lifetime EXIT
for i in $(seq 1 100); do test -s "$translation_lifetime_run/port" && break; sleep .1; done
test -s "$translation_lifetime_run/port" || { cat "$translation_lifetime_run/server.log"; exit 1; }
translation_lifetime_url="http://127.0.0.1:$(cat "$translation_lifetime_run/port")"
run_translation_lifetime_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/translation-lifetime-gjs.js "$translation_lifetime_run/client.js"
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$translation_lifetime_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$translation_lifetime_run":rw --env=XDG_STATE_HOME="$translation_lifetime_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$translation_lifetime_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$translation_lifetime_url" "$translation_lifetime_run"
 else
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$translation_lifetime_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$translation_lifetime_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/translation-lifetime-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$translation_lifetime_url" "$translation_lifetime_run"
 fi
}
run_translation_lifetime_client >"$translation_lifetime_run/client.log" 2>&1 || { tail -35 "$translation_lifetime_run/client.log"; tail -25 "$translation_lifetime_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$translation_lifetime_run/client.log"; then
 echo 'FAIL: translation lifetime runtime error'; tail -30 "$translation_lifetime_run/client.log"; exit 1
fi
rg '^OK:' "$translation_lifetime_run/client.log"
