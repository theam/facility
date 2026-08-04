#!/usr/bin/env bash
set -euo pipefail

credential_vars=(
  AWS_ACCESS_KEY_ID
  AWS_SECRET_ACCESS_KEY
  AWS_SESSION_TOKEN
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
  AWS_CONTAINER_CREDENTIALS_FULL_URI
  AWS_WEB_IDENTITY_TOKEN_FILE
)

dockerd_env=()
dockerd_pid=""
for name in "${credential_vars[@]}"; do
  dockerd_env+=(--unset="$name")
done

start_docker() {
  local storage_driver="$1"
  echo "Starting Facility Docker daemon with ${storage_driver}" >>/var/log/facility-dockerd.log
  nohup env "${dockerd_env[@]}" dockerd \
    --host=unix:///var/run/docker.sock \
    --storage-driver="$storage_driver" \
    >>/var/log/facility-dockerd.log 2>&1 &
  dockerd_pid="$!"

  for _ in $(seq 1 60); do
    if docker info >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "$dockerd_pid" >/dev/null 2>&1; then
      return 1
    fi
    sleep 1
  done
  return 1
}

stop_docker() {
  if [[ -n "$dockerd_pid" ]] && kill -0 "$dockerd_pid" >/dev/null 2>&1; then
    kill "$dockerd_pid" >/dev/null 2>&1 || true
    wait "$dockerd_pid" >/dev/null 2>&1 || true
  fi
  dockerd_pid=""
}

: >/var/log/facility-dockerd.log
if ! start_docker overlay2; then
  echo "overlay2 unavailable; retrying with the portable vfs driver" \
    >>/var/log/facility-dockerd.log
  stop_docker
  rm -f /var/run/docker.sock /var/run/docker.pid
  rm -rf /var/lib/docker/*
  start_docker vfs || true
fi

if ! docker info >/dev/null 2>&1; then
  echo "Facility could not start Docker inside the CodeBuild sandbox" >&2
  tail -n 200 /var/log/facility-dockerd.log >&2 || true
  exit 1
fi

chmod 0660 /var/run/docker.sock
chown root:node /var/run/docker.sock
mkdir -p /work
chown node:node /work
export HOME=/work
export XDG_CACHE_HOME=/work/.cache
export XDG_CONFIG_HOME=/work/.config
export XDG_DATA_HOME=/work/.local/share
mkdir -p "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"
chown -R node:node "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME" /work/.local

for name in "${credential_vars[@]}"; do
  unset "$name"
done

if [[ "${FACILITY_CODEBUILD_SMOKE:-}" == "1" ]]; then
  docker info --format 'Facility CodeBuild Docker {{.ServerVersion}} is ready'
  exit 0
fi

if [[ "$#" -eq 0 ]]; then
  set -- node /app/dist/index.js
fi

exec runuser --user node --preserve-environment -- "$@"
