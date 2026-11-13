#!/bin/sh
set -eu
questions_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
questions_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$questions_reference/VERSION")" = '7.10.0'
questions_run=$(mktemp -d /tmp/ouroboros-questions.XXXXXX)
echo "Logs at $questions_run"
questions_display=$((1000 + $$ % 20000))
PYTHONPATH="$questions_reference${PYTHONPATH:+:$PYTHONPATH}" "$questions_python" tests/questions-server.py "$questions_run" >"$questions_run/server.log" 2>&1 &
questions_pid=$!
cleanup_questions() {
 kill "$questions_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$questions_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$questions_pid" 2>/dev/null; then kill -KILL "$questions_pid" 2>/dev/null || true; fi
 wait "$questions_pid" 2>/dev/null || true
}
trap cleanup_questions EXIT
for i in $(seq 1 100); do test -s "$questions_run/port" && break; sleep .1; done
test -s "$questions_run/port" || { cat "$questions_run/server.log"; exit 1; }
questions_url="http://127.0.0.1:$(cat "$questions_run/port")"
run_questions_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/questions-gjs.js "$questions_run/client.js"
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$questions_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$questions_run":rw --env=XDG_STATE_HOME="$questions_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$questions_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$questions_url" "$questions_run"
 else
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$questions_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$questions_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/questions-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$questions_url" "$questions_run"
 fi
}
run_questions_client >"$questions_run/client.log" 2>&1 || { tail -35 "$questions_run/client.log"; tail -25 "$questions_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$questions_run/client.log"; then
 echo 'FAIL: native question runtime error'; tail -30 "$questions_run/client.log"; exit 1
fi
rg '^OK:' "$questions_run/client.log"
