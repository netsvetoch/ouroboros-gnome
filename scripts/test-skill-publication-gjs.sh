#!/bin/sh
set -eu
skill_publication_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
skill_publication_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$skill_publication_reference/VERSION")" = '7.10.0'
skill_publication_run=$(mktemp -d /tmp/ouroboros-skill-publication.XXXXXX)
echo "Logs at $skill_publication_run"
skill_publication_display=$((1000 + $$ % 20000))
PYTHONPATH="$skill_publication_reference${PYTHONPATH:+:$PYTHONPATH}" "$skill_publication_python" tests/skill-publication-server.py "$skill_publication_run" >"$skill_publication_run/server.log" 2>&1 &
skill_publication_pid=$!
cleanup_skill_publication() {
 if test -s "$skill_publication_run/port"; then
  "$skill_publication_python" - "$skill_publication_run/port" <<'PY'
import pathlib, sys, urllib.request
try:
    port=pathlib.Path(sys.argv[1]).read_text().strip()
    request=urllib.request.Request('http://127.0.0.1:'+port+'/fixture/control', data=b'{"action":"release-all"}', headers={'Content-Type':'application/json'})
    urllib.request.urlopen(request, timeout=2).close()
except Exception:
    pass
PY
 fi
 kill "$skill_publication_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$skill_publication_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$skill_publication_pid" 2>/dev/null; then kill -KILL "$skill_publication_pid" 2>/dev/null || true; fi
 wait "$skill_publication_pid" 2>/dev/null || true
}
trap cleanup_skill_publication EXIT
for i in $(seq 1 100); do test -s "$skill_publication_run/port" && break; sleep .1; done
test -s "$skill_publication_run/port" || { cat "$skill_publication_run/server.log"; exit 1; }
skill_publication_url="http://127.0.0.1:$(cat "$skill_publication_run/port")"
run_skill_publication_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/skill-publication-gjs.js "$skill_publication_run/client.js"
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$skill_publication_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$skill_publication_run":rw --env=XDG_STATE_HOME="$skill_publication_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$skill_publication_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$skill_publication_url" "$skill_publication_run"
 else
  timeout 180s dbus-run-session -- xvfb-run -a --server-num="$skill_publication_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$skill_publication_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/skill-publication-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$skill_publication_url" "$skill_publication_run"
 fi
}
run_skill_publication_client >"$skill_publication_run/client.log" 2>&1 || { tail -35 "$skill_publication_run/client.log"; tail -25 "$skill_publication_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$skill_publication_run/client.log"; then
 echo 'FAIL: Skill publication runtime error'; tail -30 "$skill_publication_run/client.log"; exit 1
fi
rg '^OK:' "$skill_publication_run/client.log"
