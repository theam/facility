#!/usr/bin/env bash
set -euo pipefail

exec node /app/dist/index.js delivery "$@"
