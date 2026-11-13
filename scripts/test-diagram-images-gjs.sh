#!/bin/sh
set -eu
diagram_image_run=$(mktemp -d /tmp/ouroboros-diagram-images.XXXXXX)
python3 tests/diagram-images-server.py "$diagram_image_run" >"$diagram_image_run/server.log" 2>&1 &
diagram_image_pid=$!
trap 'kill "$diagram_image_pid" 2>/dev/null || true' EXIT
for i in $(seq 1 80); do test -s "$diagram_image_run/port" && break; sleep .1; done
test -s "$diagram_image_run/port"
diagram_image_url="http://127.0.0.1:$(cat "$diagram_image_run/port")"
echo "Logs at $diagram_image_run"
timeout 75s dbus-run-session -- xvfb-run -a env GTK_A11Y=none GDK_BACKEND=x11 GSK_RENDERER=cairo gjs -m tests/diagram-images-gjs.js "file://$(pwd)/dist-gjs/gjs/" "$diagram_image_url" >"$diagram_image_run/client.log" 2>&1 || { cat "$diagram_image_run/client.log"; exit 1; }
rg '^OK:' "$diagram_image_run/client.log"
