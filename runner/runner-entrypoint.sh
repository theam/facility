#!/usr/bin/env bash
set -euo pipefail

mkdir -p /work
export HOME=/work
export XDG_CACHE_HOME=/work/.cache
export XDG_CONFIG_HOME=/work/.config
export XDG_DATA_HOME=/work/.local/share
mkdir -p "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"

if [[ "$(id -u)" -eq 0 ]]; then
  chown -R node:node /work
  exec runuser --user node --preserve-environment -- "$@"
fi

exec "$@"
