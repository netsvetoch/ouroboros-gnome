#!/bin/sh
set -eu
control_run=$(mktemp -d /tmp/ouroboros-local-recognition.XXXXXX)
echo "Logs at $control_run"
cp tests/fixtures/local-recognition/goforward.raw "$control_run/goforward.raw"
if test -n "${OUROBOROS_FLATPAK_BUILD:-}"; then
 cp tests/local-recognition-gjs.js "$control_run/client.js"
 timeout 100s flatpak build --runtime --unshare=network --filesystem="$control_run":rw "$OUROBOROS_FLATPAK_BUILD" gjs -m "$control_run/client.js" file:///app/share/ouroboros-ts-client/gjs/ "$control_run" /app/bin/pocketsphinx /app/share/pocketsphinx/model/en-us >"$control_run/client.log" 2>&1 || { cat "$control_run/client.log"; exit 1; }
else
 control_pack=${OUROBOROS_SPEECH_BUILD:-$(cat /tmp/ouroboros-flatpak-proof-current)/build}/files
 control_engine=${OUROBOROS_RECOGNITION_EXECUTABLE:-$control_pack/bin/pocketsphinx}
 control_model=${OUROBOROS_RECOGNITION_MODEL:-$control_pack/share/pocketsphinx/model/en-us}
 timeout 100s gjs -m tests/local-recognition-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$control_run" "$control_engine" "$control_model" >"$control_run/client.log" 2>&1 || { cat "$control_run/client.log"; exit 1; }
fi
if rg -q 'JS ERROR|CRITICAL|Unhandled promise rejection' "$control_run/client.log"; then cat "$control_run/client.log"; exit 1; fi
rg '^OK:' "$control_run/client.log"
