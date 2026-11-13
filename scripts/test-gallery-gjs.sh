#!/bin/sh
set -eu
gallery_test_cache=$(mktemp -d /tmp/ouroboros-gallery-test-cache.XXXXXX)
trap 'rm -rf "$gallery_test_cache"' EXIT
timeout 45s dbus-run-session -- xvfb-run -a env GTK_A11Y=none GDK_BACKEND=x11 GSK_RENDERER=cairo XDG_CACHE_HOME="$gallery_test_cache" gjs -m tests/component-gallery-gjs.js
