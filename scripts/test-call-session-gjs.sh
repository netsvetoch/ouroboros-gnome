#!/bin/sh
set -eu
call_session_run=$(mktemp -d /tmp/ouroboros-call-session.XXXXXX)
echo "Logs at $call_session_run"
if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
 cp tests/call-session-gjs.js "$call_session_run/client.js"
 timeout 45s dbus-run-session -- flatpak build --runtime --filesystem="$call_session_run":rw --env=XDG_STATE_HOME="$call_session_run/state" "$OUROBOROS_FLATPAK_BUILD" gjs -m "$call_session_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ >"$call_session_run/client.log" 2>&1 || { cat "$call_session_run/client.log"; exit 1; }
else
 timeout 45s dbus-run-session -- env XDG_STATE_HOME="$call_session_run/state" gjs -m tests/call-session-gjs.js "file://$(pwd)/dist-gjs/gjs/" >"$call_session_run/client.log" 2>&1 || { cat "$call_session_run/client.log"; exit 1; }
fi
if rg -q 'JS ERROR|CRITICAL' "$call_session_run/client.log"; then cat "$call_session_run/client.log"; exit 1; fi
rg '^OK:' "$call_session_run/client.log"
