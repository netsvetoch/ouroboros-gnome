#!/bin/sh
set -eu
map_test_cache=$(mktemp -d /tmp/ouroboros-map-test-cache.XXXXXX)
trap 'rm -rf "$map_test_cache"' EXIT
timeout 30s dbus-run-session -- xvfb-run -a env GTK_A11Y=none GDK_BACKEND=x11 GSK_RENDERER=cairo XDG_CACHE_HOME="$map_test_cache" gjs -m tests/component-map-gjs.js
