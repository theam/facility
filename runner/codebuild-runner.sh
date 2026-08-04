#!/usr/bin/env bash
set -euo pipefail

readonly docker_user="facility-docker"
readonly proxy_user="facility-proxy"
readonly untrusted_uid="${FACILITY_UNTRUSTED_UID:-1000}"
readonly untrusted_gid="${FACILITY_UNTRUSTED_GID:-1000}"
readonly docker_runtime="/run/facility-docker"
readonly proxy_runtime="/run/facility-proxy"
readonly raw_socket="${docker_runtime}/docker.sock"
readonly public_socket="${proxy_runtime}/docker.sock"

credential_vars=(
  AWS_ACCESS_KEY_ID
  AWS_SECRET_ACCESS_KEY
  AWS_SESSION_TOKEN
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
  AWS_CONTAINER_CREDENTIALS_FULL_URI
  AWS_WEB_IDENTITY_TOKEN_FILE
)
proxy_secret_vars=(
  "${credential_vars[@]}"
  RUNNER_TOKEN
  NODE_AUTH_TOKEN
  ANTHROPIC_API_KEY
  OPENAI_API_KEY
  FACILITY_PLATFORM_KEY
  GITHUB_TOKEN
  GH_TOKEN
)

dockerd_env=()
proxy_env=()
dockerd_pid=""
proxy_pid=""
for name in "${proxy_secret_vars[@]}"; do dockerd_env+=(--unset="$name"); done
for name in "${proxy_secret_vars[@]}"; do proxy_env+=(--unset="$name"); done

stop_process_group() {
  local pid="$1"
  if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
    kill -TERM -- "-$pid" >/dev/null 2>&1 || true
    wait "$pid" >/dev/null 2>&1 || true
  fi
}

run_untrusted() {
  setpriv --reuid="$untrusted_uid" --regid="$untrusted_gid" --clear-groups -- "$@"
}

start_docker() {
  local storage_driver="$1"
  local data_root="$2"
  echo "Starting rootless Facility Docker with ${storage_driver}" >>/var/log/facility-dockerd.log
  setsid runuser --user "$docker_user" -- env "${dockerd_env[@]}" \
    HOME=/var/lib/facility-docker \
    XDG_RUNTIME_DIR="$docker_runtime" \
    DOCKER_HOST="unix://${raw_socket}" \
    DOCKERD_ROOTLESS_ROOTLESSKIT_FLAGS="--net=slirp4netns --disable-host-loopback" \
    /usr/share/docker.io/contrib/dockerd-rootless.sh \
      --host="unix://${raw_socket}" \
      --storage-driver="$storage_driver" \
      --data-root="$data_root" \
      >>/var/log/facility-dockerd.log 2>&1 &
  dockerd_pid="$!"

  for _ in $(seq 1 90); do
    if DOCKER_HOST="unix://${raw_socket}" docker info >/dev/null 2>&1; then return 0; fi
    if ! kill -0 "$dockerd_pid" >/dev/null 2>&1; then return 1; fi
    sleep 1
  done
  return 1
}

start_proxy() {
  setsid runuser --user "$proxy_user" -- env "${proxy_env[@]}" \
    FACILITY_DOCKER_SOCKET="$public_socket" \
    FACILITY_DOCKER_UPSTREAM_SOCKET="$raw_socket" \
    node /app/dist/docker-proxy.js \
    >>/var/log/facility-docker-proxy.log 2>&1 &
  proxy_pid="$!"
  for _ in $(seq 1 30); do
    if [[ -S "$public_socket" ]]; then
      # The untrusted process reaches the proxy through the workspace group.
      # Root inside a rootless child maps to facility-docker on the host, so
      # owning this public (policy-enforcing) socket also supports Testcontainers.
      chown "$docker_user:$untrusted_gid" "$public_socket"
      chmod 0660 "$public_socket"
      ln -sfn "$public_socket" /var/run/docker.sock
      return 0
    fi
    if ! kill -0 "$proxy_pid" >/dev/null 2>&1; then return 1; fi
    sleep 1
  done
  return 1
}

security_smoke() {
  if run_untrusted env --unset=RUNNER_TOKEN sh -c \
    'tr "\000" "\n" 2>/dev/null < "/proc/$1/environ" | grep -q "^RUNNER_TOKEN="' \
    facility-security-probe "$$"; then
    echo "Security smoke failed: the agent user read the runner credential" >&2
    return 1
  fi
  if ! run_untrusted env DOCKER_HOST="unix://${public_socket}" docker info \
    >/dev/null 2>&1; then
    echo "Security smoke failed: the agent user cannot reach restricted Docker" >&2
    return 1
  fi
  mkdir /work/.facility-security-root
  if run_untrusted rmdir /work/.facility-security-root >/dev/null 2>&1; then
    echo "Security smoke failed: the agent user replaced runner-owned state" >&2
    return 1
  fi
  rmdir /work/.facility-security-root
  if run_untrusted test -w /app/dist/index.js; then
    echo "Security smoke failed: the agent user can rewrite the runner" >&2
    return 1
  fi
  local smoke_dir
  smoke_dir="$(mktemp -d)"
  trap 'rm -rf -- "$smoke_dir"' RETURN
  printf 'FROM scratch\nCOPY busybox /bin/busybox\nENTRYPOINT ["/bin/busybox"]\n' \
    >"$smoke_dir/Dockerfile"
  cp /bin/busybox "$smoke_dir/busybox"
  docker build --network=none --tag facility-security-smoke:local "$smoke_dir" >/dev/null
  local container_id
  container_id="$(docker create facility-security-smoke:local true)"
  docker rm "$container_id" >/dev/null
  local volume_name
  volume_name="$(docker volume create facility-security-smoke-volume)"
  docker volume rm "$volume_name" >/dev/null
  if docker volume create --driver local --opt type=none --opt o=bind \
    --opt device=/run/facility-docker facility-security-escape >/dev/null 2>&1; then
    echo "Security smoke failed: a host-path volume reached Docker" >&2
    return 1
  fi

  local bind_dir="/work/.facility-security-bind"
  run_untrusted mkdir "$bind_dir"
  run_untrusted sh -c 'printf facility-workspace-bind-ready > "$1/probe"' facility-bind "$bind_dir"
  if [[ "${FACILITY_CODEBUILD_SMOKE_CREATE_ONLY:-}" == "1" ]]; then
    # Docker Desktop cannot execute an amd64 binary in rootless Docker nested
    # inside its already-emulated amd64 runner. Still validate the proxy policy
    # and the exact host identities locally; native CodeBuild must run the full
    # branch below before deployment is accepted.
    container_id="$(docker create \
      --mount "type=bind,src=${bind_dir}/probe,dst=/probe,readonly" \
      facility-security-smoke:local cat /probe)"
    docker rm "$container_id" >/dev/null
    if [[ "$(runuser --user "$docker_user" -- cat "${bind_dir}/probe")" != \
      "facility-workspace-bind-ready" ]]; then
      echo "Security smoke failed: the rootless daemon identity cannot read the workspace" >&2
      return 1
    fi
    container_id="$(docker create \
      --mount "type=bind,src=${public_socket},dst=/var/run/docker.sock" \
      facility-security-smoke:local sh -c 'test -S /var/run/docker.sock')"
    docker rm "$container_id" >/dev/null
    if ! runuser --user "$docker_user" -- test -r "$public_socket" -a -w "$public_socket"; then
      echo "Security smoke failed: a rootless child cannot use the restricted Docker socket" >&2
      return 1
    fi
  else
    local bind_value
    bind_value="$(docker run --rm \
      --mount "type=bind,src=${bind_dir}/probe,dst=/probe,readonly" \
      facility-security-smoke:local cat /probe)"
    if [[ "$bind_value" != "facility-workspace-bind-ready" ]]; then
      echo "Security smoke failed: rootless Docker cannot read a workspace bind" >&2
      return 1
    fi
    if ! docker run --rm \
      --mount "type=bind,src=${public_socket},dst=/var/run/docker.sock" \
      facility-security-smoke:local sh -c \
        'test -S /var/run/docker.sock && test -r /var/run/docker.sock && test -w /var/run/docker.sock'; then
      echo "Security smoke failed: a rootless child cannot use the restricted Docker socket" >&2
      return 1
    fi
  fi

  if docker create --privileged facility-security-smoke:local true >/dev/null 2>&1; then
    echo "Security smoke failed: privileged containers reached Docker" >&2
    return 1
  fi
  if docker create --pid=host facility-security-smoke:local true >/dev/null 2>&1; then
    echo "Security smoke failed: host PID mode reached Docker" >&2
    return 1
  fi
  if docker create --mount type=bind,src=/proc,dst=/host-proc facility-security-smoke:local true \
    >/dev/null 2>&1; then
    echo "Security smoke failed: a host bind mount reached Docker" >&2
    return 1
  fi
  if run_untrusted env DOCKER_HOST="unix://${raw_socket}" docker info \
    >/dev/null 2>&1; then
    echo "Security smoke failed: the agent user reached the raw Docker socket" >&2
    return 1
  fi
  if [[ "${FACILITY_CODEBUILD_SMOKE_CREATE_ONLY:-}" == "1" ]]; then
    echo "Facility CodeBuild Docker security boundary passed create-only emulation checks"
  else
    echo "Facility CodeBuild Docker security boundary is ready"
  fi
}

mkdir -p "$docker_runtime" "$proxy_runtime" /var/lib/facility-docker/docker-fuse \
  /var/lib/facility-docker/docker-vfs /work
chown -R "$docker_user:$docker_user" "$docker_runtime" /var/lib/facility-docker
chown -R "$proxy_user:$untrusted_gid" "$proxy_runtime"
chown root:"$untrusted_gid" /work
chmod 3770 /work
chmod 0710 "$docker_runtime" "$proxy_runtime"
: >/var/log/facility-dockerd.log
: >/var/log/facility-docker-proxy.log

# Neither the runner nor nested builds need link-local metadata endpoints. Block
# them before untrusted code starts, including traffic forwarded by rootlesskit.
iptables -I OUTPUT 1 -d 169.254.0.0/16 -j REJECT
iptables -I FORWARD 1 -d 169.254.0.0/16 -j REJECT
if command -v ip6tables >/dev/null 2>&1; then
  ip6tables -I OUTPUT 1 -d fe80::/10 -j REJECT || true
  ip6tables -I FORWARD 1 -d fe80::/10 -j REJECT || true
  ip6tables -I OUTPUT 1 -d fd00:ec2::254 -j REJECT || true
  ip6tables -I FORWARD 1 -d fd00:ec2::254 -j REJECT || true
fi

if ! start_docker fuse-overlayfs /var/lib/facility-docker/docker-fuse; then
  echo "fuse-overlayfs unavailable; retrying with the portable vfs driver" \
    >>/var/log/facility-dockerd.log
  stop_process_group "$dockerd_pid"
  dockerd_pid=""
  rm -f "$raw_socket"
  start_docker vfs /var/lib/facility-docker/docker-vfs || true
fi

if ! DOCKER_HOST="unix://${raw_socket}" docker info >/dev/null 2>&1; then
  echo "Facility could not start rootless Docker inside the CodeBuild sandbox" >&2
  tail -n 200 /var/log/facility-dockerd.log >&2 || true
  exit 1
fi
chmod 0660 "$raw_socket"
chgrp "$docker_user" "$raw_socket"
start_proxy

export DOCKER_HOST="unix://${public_socket}"
if ! docker info >/dev/null 2>&1; then
  echo "Facility could not start the restricted Docker proxy" >&2
  tail -n 200 /var/log/facility-docker-proxy.log >&2 || true
  exit 1
fi

for name in "${credential_vars[@]}"; do unset "$name"; done
export HOME=/work
export XDG_CACHE_HOME=/work/.cache
export XDG_CONFIG_HOME=/work/.config
export XDG_DATA_HOME=/work/.local/share
export TMPDIR=/work/.tmp
mkdir -p "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$TMPDIR"
chown -R "$untrusted_uid:$untrusted_gid" "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME" /work/.local \
  "$TMPDIR"
chmod -R g+rwX "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME" /work/.local "$TMPDIR"
umask 0002

if [[ "${FACILITY_CODEBUILD_SMOKE:-}" == "1" ]]; then
  security_smoke
  exit 0
fi

if [[ "$#" -eq 0 ]]; then set -- node /app/dist/index.js; fi

# Keep the lifecycle credential in a root runner process. Every repository,
# model, provisioning, and check command is spawned as the separate `node`
# identity, so it cannot inspect the runner's process environment.
exec "$@"
