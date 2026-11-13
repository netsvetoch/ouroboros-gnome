#!/bin/sh
# Точка входа flatpak: GJS UI. Gateway — на хосте, см. OUROBOROS_URL.
exec gjs -m /app/share/ouroboros-ts-client/main-gjs.js "$@"
