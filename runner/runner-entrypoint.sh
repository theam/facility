#!/usr/bin/env bash
set -euo pipefail

mkdir -p /work
export HOME=/work
export XDG_CACHE_HOME=/work/.cache
export XDG_CONFIG_HOME=/work/.config
export XDG_DATA_HOME=/work/.local/share
export COREPACK_HOME="$XDG_CACHE_HOME/node/corepack"
mkdir -p "$COREPACK_HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"

# Corepack caches executable package-manager code. Start every sandbox from the
# read-only image seed, but keep its runtime cache in this run's tmpfs so agent
# code cannot persist an executable into a later run. Unknown pinned versions
# may be downloaded here without weakening that boundary.
if [[ -d /opt/facility-corepack ]]; then
  cp -a /opt/facility-corepack/. "$COREPACK_HOME/"
fi

if [[ "$(id -u)" -eq 0 ]]; then
  chown -R node:node /work
  exec runuser --user node --preserve-environment -- "$@"
fi

exec "$@"
