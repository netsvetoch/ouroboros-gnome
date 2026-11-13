#!/bin/sh
set -eu
secret_questions_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
secret_questions_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$secret_questions_reference/VERSION")" = '7.10.0'
secret_questions_run=$(mktemp -d /tmp/ouroboros-secret-lifetime.XXXXXX)
echo "Logs at $secret_questions_run"
secret_questions_display=$((1000 + $$ % 20000))
PYTHONPATH="$secret_questions_reference${PYTHONPATH:+:$PYTHONPATH}" "$secret_questions_python" tests/secret-questions-server.py "$secret_questions_run" >"$secret_questions_run/server.log" 2>&1 &
secret_questions_pid=$!
cleanup_questions() {
 kill "$secret_questions_pid" 2>/dev/null || true
 for i in $(seq 1 50); do kill -0 "$secret_questions_pid" 2>/dev/null || break; sleep .1; done
 if kill -0 "$secret_questions_pid" 2>/dev/null; then kill -KILL "$secret_questions_pid" 2>/dev/null || true; fi
 wait "$secret_questions_pid" 2>/dev/null || true
}
trap cleanup_questions EXIT
for i in $(seq 1 100); do test -s "$secret_questions_run/port" && break; sleep .1; done
test -s "$secret_questions_run/port" || { cat "$secret_questions_run/server.log"; exit 1; }
secret_questions_url="http://127.0.0.1:$(cat "$secret_questions_run/port")"
run_secret_questions_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/secret-lifetime-gjs.js "$secret_questions_run/client.js"
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$secret_questions_display" -s '-screen 0 1600x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$secret_questions_run":rw --env=XDG_STATE_HOME="$secret_questions_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none "$OUROBOROS_FLATPAK_BUILD" gjs -m "$secret_questions_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$secret_questions_url" "$secret_questions_run"
 else
  timeout 100s dbus-run-session -- xvfb-run -a --server-num="$secret_questions_display" -s '-screen 0 1600x1000x24' env XDG_STATE_HOME="$secret_questions_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none gjs -m tests/secret-lifetime-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$secret_questions_url" "$secret_questions_run"
 fi
}
run_secret_questions_client >"$secret_questions_run/client.log" 2>&1 || { tail -35 "$secret_questions_run/client.log"; tail -25 "$secret_questions_run/server.log"; exit 1; }
if rg -q 'JS ERROR|CRITICAL|from markup due to error parsing markup' "$secret_questions_run/client.log"; then
 echo 'FAIL: native secret runtime error'; tail -30 "$secret_questions_run/client.log"; exit 1
fi
rg '^OK:' "$secret_questions_run/client.log"
