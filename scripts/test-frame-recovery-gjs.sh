#!/bin/sh
set -eu
control_reference=${OUROBOROS_REFERENCE:?Set OUROBOROS_REFERENCE to the pinned Ouroboros 7.10.0 source directory}
control_python=${OUROBOROS_TEST_PYTHON:-python3}
test "$(cat "$control_reference/VERSION")" = '7.10.0'
control_run=$(mktemp -d /tmp/ouroboros-frame-recovery.XXXXXX)
echo "Logs at $control_run"
PYTHONPATH="$control_reference${PYTHONPATH:+:$PYTHONPATH}" "$control_python" tests/widget-runtime-server.py "$control_run" "$control_reference" holds >"$control_run/server.log" 2>&1 &
control_pid=$!
trap 'kill "$control_pid" 2>/dev/null || true' EXIT
for i in $(seq 1 100); do test -s "$control_run/port" && break; sleep .1; done
test -s "$control_run/port" || { cat "$control_run/server.log"; exit 1; }
control_url="http://127.0.0.1:$(cat "$control_run/port")"
run_control_client() {
 if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
  cp tests/frame-recovery-gjs.js "$control_run/client.js"
  timeout 160s dbus-run-session -- xvfb-run -a --server-num="$recovery_display" -s '-screen 0 1280x1000x24' flatpak build --runtime --share=network --socket=x11 --filesystem="$control_run":rw --env=XDG_STATE_HOME="$control_run/client-state" --env=GDK_BACKEND=x11 --env=GSK_RENDERER=cairo --env=GTK_A11Y=none --env=GTK_IM_MODULE=simple "$OUROBOROS_FLATPAK_BUILD" gjs -m "$control_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$control_url" "$control_run" "$1"
 else
  timeout 160s dbus-run-session -- xvfb-run -a --server-num="$recovery_display" -s '-screen 0 1280x1000x24' env XDG_STATE_HOME="$control_run/client-state" GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none GTK_IM_MODULE=simple gjs -m tests/frame-recovery-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$control_url" "$control_run" "$1"
 fi
}
recovery_index=0
for recovery_phase in crash recover verify batch-seed batch-recover; do
 recovery_index=$((recovery_index + 1))
 recovery_display=$((1000 + ($$ % 2000) * 6 + recovery_index))
 recovery_status=0
 run_control_client "$recovery_phase" >"$control_run/client-$recovery_phase.log" 2>&1 || recovery_status=$?
 recovery_expected=0
 test "$recovery_phase" != crash || recovery_expected=137
 if test "$recovery_status" != "$recovery_expected"; then tail -35 "$control_run/client-$recovery_phase.log"; tail -25 "$control_run/server.log"; exit 1; fi
 if rg -q 'JS ERROR|CRITICAL|Unhandled promise rejection|from markup due to error parsing markup' "$control_run/client-$recovery_phase.log"; then
  tail -35 "$control_run/client-$recovery_phase.log"; exit 1
 fi
 rg '^OK:' "$control_run/client-$recovery_phase.log"
done
