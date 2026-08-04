#!/usr/bin/env bash
set -euo pipefail

readonly docker_user="facility-docker"
readonly proxy_user="facility-proxy"
readonly untrusted_uid="${FACILITY_UNTRUSTED_UID:-1000}"
readonly untrusted_gid="${FACILITY_UNTRUSTED_GID:-1000}"
readonly docker_runtime="/run/facility-docker"
readonly proxy_runtime="/run/facility-proxy"
readonly bind_runtime="/run/facility-binds"
readonly workspace_view="/work/.facility-mounts"
readonly raw_socket="${docker_runtime}/docker.sock"
readonly public_socket="${proxy_runtime}/docker.sock"
readonly bind_socket="${bind_runtime}/mounter.sock"

if [[ "${FACILITY_CODEBUILD_SMOKE:-}" == "1" && \
  "${FACILITY_CODEBUILD_SMOKE_TIMEOUT_INNER:-}" != "1" ]]; then
  export FACILITY_CODEBUILD_SMOKE_TIMEOUT_INNER=1
  exec timeout --kill-after=30s 10m "$0" "$@"
fi

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
dockerd_pid=""
proxy_pid=""
mounter_pid=""
for name in "${proxy_secret_vars[@]}"; do dockerd_env+=(--unset="$name"); done

stop_process_group() {
  local pid="$1"
  if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
    kill -TERM -- "-$pid" >/dev/null 2>&1 || true
    for _ in $(seq 1 10); do
      if ! kill -0 "$pid" >/dev/null 2>&1; then break; fi
      sleep 1
    done
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill -KILL -- "-$pid" >/dev/null 2>&1 || true
    fi
    wait "$pid" >/dev/null 2>&1 || true
  fi
}

cleanup_runtime() {
  stop_process_group "$proxy_pid"
  stop_process_group "$mounter_pid"
  stop_process_group "$dockerd_pid"
}

if [[ "${FACILITY_CODEBUILD_SMOKE:-}" == "1" && \
  "${FACILITY_CODEBUILD_SMOKE_TIMEOUT_INNER:-}" == "1" ]]; then
  trap cleanup_runtime EXIT
  trap 'exit 124' TERM
  trap 'exit 130' INT
fi

run_untrusted() {
  setpriv --reuid="$untrusted_uid" --regid="$untrusted_gid" --clear-groups -- "$@"
}

start_docker() {
  local storage_driver="$1"
  local data_root="$2"
  echo "Facility CodeBuild: starting rootless Docker (${storage_driver})"
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
  setsid runuser --user "$proxy_user" -- env -i \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    FACILITY_DOCKER_SOCKET="$public_socket" \
    FACILITY_DOCKER_UPSTREAM_SOCKET="$raw_socket" \
    FACILITY_BIND_MOUNTER_SOCKET="$bind_socket" \
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

start_mounter() {
  local docker_uid docker_daemon_pid
  docker_uid="$(id -u "$docker_user")"
  docker_daemon_pid="$(
    ps -eo pid=,pgid=,uid=,comm= | awk \
      -v group="$dockerd_pid" -v uid="$docker_uid" \
      '$2 == group && $3 == uid && $4 == "dockerd" { print $1 }'
  )"
  if [[ -z "$docker_daemon_pid" || "$docker_daemon_pid" == *$'\n'* ]]; then
    echo "Facility could not identify the rootless Docker mount namespace" >&2
    return 1
  fi
  setsid env -i \
    /usr/local/bin/facility-bind-broker \
      "$bind_socket" "/work" "$workspace_view" \
      "$(id -u "$proxy_user")" "$(id -g "$proxy_user")" \
    >>/var/log/facility-bind-mounter.log 2>&1 &
  mounter_pid="$!"
  local readiness_probe='const net=require("node:net"); const socket=net.createConnection(process.argv[1]); let response=""; const timer=setTimeout(()=>socket.destroy(new Error("timeout")),1000); socket.setEncoding("utf8"); socket.on("connect",()=>socket.end("BATCH 1\n.\n")); socket.on("data",chunk=>response+=chunk); socket.on("end",()=>{clearTimeout(timer); const lines=response.trimEnd().split("\n"); if(lines[0]!=="OK 1"||lines.length!==2)process.exit(1); console.log(lines[1])}); socket.on("error",()=>{clearTimeout(timer); process.exit(1)});'
  for _ in $(seq 1 30); do
    if [[ -S "$bind_socket" ]]; then
      # The broker also verifies SO_PEERCRED; filesystem ownership is the first
      # independent gate before a client reaches that check.
      if [[ "$(stat -c '%u:%g:%a' "$bind_socket")" != \
        "$(id -u "$proxy_user"):$(id -g "$proxy_user"):600" ]]; then
        return 1
      fi
      local readiness_alias
      if readiness_alias="$(runuser --user "$proxy_user" -- env -i \
        /usr/local/bin/node -e "$readiness_probe" "$bind_socket")" && \
        [[ "$readiness_alias" == "${workspace_view}/"* ]] && \
        nsenter --mount="/proc/${docker_daemon_pid}/ns/mnt" -- \
          findmnt -rn -T "$readiness_alias" -o TARGET | grep -qx "$readiness_alias"; then
        return 0
      fi
    fi
    if ! kill -0 "$mounter_pid" >/dev/null 2>&1; then return 1; fi
    sleep 1
  done
  return 1
}

security_smoke() {
  echo "Facility smoke: checking broker identities and environment"
  local broker_probe='const net=require("node:net"); const socket=net.createConnection(process.argv[1]); const timer=setTimeout(()=>process.exit(1),1000); socket.on("connect",()=>{clearTimeout(timer); socket.destroy(); process.exit(0)}); socket.on("error",()=>{clearTimeout(timer); process.exit(1)});'
  local peer_probe='const net=require("node:net"); const socket=net.createConnection(process.argv[1]); let response=""; const timer=setTimeout(()=>socket.destroy(new Error("timeout")),1000); socket.setEncoding("utf8"); socket.on("data",chunk=>response+=chunk); socket.on("end",()=>{clearTimeout(timer); if(response!=="ERR workspace_bind_peer_denied\n"){console.error(`unexpected broker response: ${JSON.stringify(response)}`);process.exit(1)}}); socket.on("error",error=>{clearTimeout(timer); console.error(`broker peer probe failed: ${error.message}`);process.exit(1)});'
  if ! node -e "$peer_probe" "$bind_socket"; then
    echo "Security smoke failed: the bind broker did not enforce peer credentials" >&2
    return 1
  fi
  if run_untrusted node -e "$broker_probe" "$bind_socket"; then
    echo "Security smoke failed: the agent user reached the bind broker" >&2
    return 1
  fi
  if setpriv --reuid="$(id -u "$docker_user")" --regid="$(id -g "$docker_user")" \
    --clear-groups -- node -e "$broker_probe" "$bind_socket"; then
    echo "Security smoke failed: rootless Docker reached the bind broker" >&2
    return 1
  fi
  if tr '\000' '\n' <"/proc/${mounter_pid}/environ" | grep -q .; then
    echo "Security smoke failed: the bind broker retained an environment" >&2
    return 1
  fi
  echo "Facility smoke: checking metadata egress isolation"
  local isolated_uid
  for isolated_uid in "$untrusted_uid" "$(id -u "$docker_user")" "$(id -u "$proxy_user")"; do
    if ! iptables -C OUTPUT -m owner --uid-owner "$isolated_uid" \
      -d 169.254.0.0/16 -j REJECT; then
      echo "Security smoke failed: an untrusted identity can reach IPv4 metadata" >&2
      return 1
    fi
  done
  if iptables -C OUTPUT -d 169.254.0.0/16 -j REJECT >/dev/null 2>&1; then
    echo "Security smoke failed: metadata isolation also blocked the CodeBuild agent" >&2
    return 1
  fi
  if run_untrusted test -w "$workspace_view" || \
    runuser --user "$docker_user" -- test -w "$workspace_view"; then
    echo "Security smoke failed: an untrusted identity can modify pinned aliases" >&2
    return 1
  fi
  if run_untrusted env --unset=RUNNER_TOKEN sh -c \
    'tr "\000" "\n" 2>/dev/null < "/proc/$1/environ" | grep -q "^RUNNER_TOKEN="' \
    facility-security-probe "$$"; then
    echo "Security smoke failed: the agent user read the runner credential" >&2
    return 1
  fi
  echo "Facility smoke: building the nested Docker probe"
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

  echo "Facility smoke: checking permitted workspace and socket binds"
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

    local race_dir="/work/.facility-security-race"
    local race_original="/work/.facility-security-race-original"
    run_untrusted mkdir "$race_dir"
    run_untrusted sh -c 'printf facility-pinned-bind > "$1/docker.sock"' facility-race "$race_dir"
    container_id="$(docker create \
      --mount "type=bind,src=${race_dir}/docker.sock,dst=/probe,readonly" \
      facility-security-smoke:local cat /probe)"
    run_untrusted mv "$race_dir" "$race_original"
    run_untrusted ln -s "$docker_runtime" "$race_dir"
    for _ in 1 2; do
      if [[ "$(docker start --attach "$container_id")" != "facility-pinned-bind" ]]; then
        echo "Security smoke failed: a delayed container start escaped its pinned bind" >&2
        return 1
      fi
    done
    docker rm "$container_id" >/dev/null
    run_untrusted rm "$race_dir"
    run_untrusted rm "$race_original/docker.sock"
    run_untrusted rmdir "$race_original"
  fi

  echo "Facility smoke: checking denied Docker capabilities and host paths"
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
  if runuser --user "$docker_user" -- test -r "$raw_socket" -o -w "$raw_socket"; then
    echo "Security smoke failed: rootless container identity can open the raw Docker socket" >&2
    return 1
  fi
  local runtime_socket
  runtime_socket="$(find "$docker_runtime" -type s ! -path "$raw_socket" -print -quit)"
  if [[ -z "$runtime_socket" ]]; then
    echo "Security smoke failed: the runtime isolation probe found no internal socket" >&2
    return 1
  fi
  run_untrusted ln -s "$runtime_socket" /work/.facility-security-runtime-escape
  if docker create \
    --mount "type=bind,src=/work/.facility-security-runtime-escape,dst=/runtime.sock" \
    facility-security-smoke:local true >/dev/null 2>&1; then
    echo "Security smoke failed: a workspace symlink crossed the protected runtime view" >&2
    return 1
  fi
  run_untrusted mkdir /work/.facility-security-partial
  run_untrusted sh -c \
    'printf safe-partial-bind > "$1/probe"' facility-partial /work/.facility-security-partial
  local rollback_probe='const net=require("node:net"); const socket=net.createConnection(process.argv[1]); let response=""; const timer=setTimeout(()=>socket.destroy(new Error("timeout")),1000); socket.setEncoding("utf8"); socket.on("connect",()=>socket.end("BATCH 2\n.facility-security-partial/probe\n.facility-security-partial/missing\n")); socket.on("data",chunk=>response+=chunk); socket.on("end",()=>{clearTimeout(timer); process.exit(response==="ERR workspace_bind_source_denied\n"?0:1)}); socket.on("error",()=>{clearTimeout(timer); process.exit(1)});'
  echo "Facility smoke: checking transactional bind rollback"
  local aliases_before aliases_after
  aliases_before="$(findmnt -rn -o TARGET | grep -c "^${workspace_view}/" || true)"
  if ! runuser --user "$proxy_user" -- env -i \
    /usr/local/bin/node -e "$rollback_probe" "$bind_socket"; then
    echo "Security smoke failed: the bind broker did not reject a partial batch" >&2
    return 1
  fi
  aliases_after="$(findmnt -rn -o TARGET | grep -c "^${workspace_view}/" || true)"
  if [[ "$aliases_after" != "$aliases_before" ]]; then
    echo "Security smoke failed: a rejected broker batch leaked a pinned alias" >&2
    return 1
  fi
  if docker create \
    --mount type=bind,src=/work/.facility-security-partial/probe,dst=/safe \
    --mount type=bind,src=/work/.facility-security-runtime-escape,dst=/escape \
    facility-security-smoke:local true >/dev/null 2>&1; then
    echo "Security smoke failed: a partially pinned request reached Docker" >&2
    return 1
  fi
  run_untrusted rm /work/.facility-security-partial/probe
  run_untrusted rmdir /work/.facility-security-partial
  run_untrusted rm /work/.facility-security-runtime-escape
  if ! findmnt -rn -o TARGET | grep -q "^${workspace_view}/"; then
    echo "Security smoke failed: workspace binds did not use pinned mount aliases" >&2
    return 1
  fi
  if [[ "${FACILITY_CODEBUILD_SMOKE_CREATE_ONLY:-}" == "1" ]]; then
    echo "Facility CodeBuild Docker security boundary passed create-only emulation checks"
  else
    echo "Facility CodeBuild Docker security boundary is ready"
  fi
}

mkdir -p "$docker_runtime" "$proxy_runtime" "$bind_runtime" "$workspace_view" \
  /var/lib/facility-docker/docker-fuse /var/lib/facility-docker/docker-vfs /work
chown -R "$docker_user:$docker_user" "$docker_runtime" /var/lib/facility-docker
chown -R "$proxy_user:$untrusted_gid" "$proxy_runtime"
chown root:"$untrusted_gid" /work
chmod 3770 /work
chmod 0710 "$docker_runtime" "$proxy_runtime"
chown root:root "$bind_runtime"
chmod 0711 "$bind_runtime"
chown root:root "$workspace_view"
chmod 0711 "$workspace_view"
# RootlessKit converts inherited mounts to slaves. A dedicated shared mount
# here is therefore the deterministic master for aliases created later by the
# root broker; dockerd receives those aliases without exposing the raw daemon.
mount --bind "$workspace_view" "$workspace_view"
mount --make-shared "$workspace_view"
if ! findmnt -rn -T "$workspace_view" -o PROPAGATION | grep -qx shared; then
  echo "Facility could not establish shared workspace mount propagation" >&2
  exit 1
fi
: >/var/log/facility-dockerd.log
: >/var/log/facility-docker-proxy.log
: >/var/log/facility-bind-mounter.log

echo "Facility CodeBuild: host boundary configured"

# Neither the runner nor nested builds need link-local metadata endpoints. Block
# the identities that can execute repository-controlled work, including the
# rootlesskit user that originates nested-container traffic. CodeBuild's root
# agent must retain its control-plane connection so builds can report completion.
for isolated_uid in "$untrusted_uid" "$(id -u "$docker_user")" "$(id -u "$proxy_user")"; do
  iptables -I OUTPUT 1 -m owner --uid-owner "$isolated_uid" -d 169.254.0.0/16 -j REJECT
done
iptables -I FORWARD 1 -d 169.254.0.0/16 -j REJECT
if command -v ip6tables >/dev/null 2>&1; then
  for isolated_uid in "$untrusted_uid" "$(id -u "$docker_user")" "$(id -u "$proxy_user")"; do
    ip6tables -I OUTPUT 1 -m owner --uid-owner "$isolated_uid" -d fe80::/10 -j REJECT || true
    ip6tables -I OUTPUT 1 -m owner --uid-owner "$isolated_uid" -d fd00:ec2::254 -j REJECT || true
  done
  ip6tables -I FORWARD 1 -d fe80::/10 -j REJECT || true
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
echo "Facility CodeBuild: rootless Docker is ready"
chmod 0660 "$raw_socket"
# Dockerd keeps its listening descriptor open. Reassign the pathname to the
# proxy identity so even a bind-validation TOCTOU cannot give root inside a
# rootless child access to the unrestricted daemon API.
chown root:"$proxy_user" "$raw_socket"
if ! start_mounter; then
  echo "Facility could not start the transactional bind broker" >&2
  tail -n 200 /var/log/facility-bind-mounter.log >&2 || true
  exit 1
fi
echo "Facility CodeBuild: transactional bind broker is ready"
start_proxy

export DOCKER_HOST="unix://${public_socket}"
if ! docker info >/dev/null 2>&1; then
  echo "Facility could not start the restricted Docker proxy" >&2
  tail -n 200 /var/log/facility-docker-proxy.log >&2 || true
  exit 1
fi
echo "Facility CodeBuild: restricted Docker proxy is ready"

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

if [[ "$#" -eq 0 ]]; then
  # Keep the lifecycle credential in the root runner process. It lowers every
  # repository, model, provisioning, and check child to the untrusted identity.
  exec node /app/dist/index.js
fi

# A sandbox profile may replace the Facility lifecycle with a trusted custom
# runner. It retains RUNNER_TOKEN so it can report lifecycle events/results, but
# it must not inherit root merely because CodeBuild needs root for setup.
exec setpriv --reuid="$untrusted_uid" --regid="$untrusted_gid" --clear-groups -- "$@"
