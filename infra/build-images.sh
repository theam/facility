#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AWS_REGION="${AWS_REGION:-us-east-1}"
IMAGE_TAG="${IMAGE_TAG:-$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo latest)}"
CPU_ARCHITECTURE="${CPU_ARCHITECTURE:-X86_64}"

case "$CPU_ARCHITECTURE" in
  X86_64) expected_platform="linux/amd64" ;;
  ARM64) expected_platform="linux/arm64" ;;
  *)
    printf 'CPU_ARCHITECTURE must be X86_64 or ARM64 (received %s)\n' "$CPU_ARCHITECTURE" >&2
    exit 1
    ;;
esac

PLATFORM="${PLATFORM:-$expected_platform}"
if [[ "$PLATFORM" != "$expected_platform" ]]; then
  printf 'PLATFORM=%s does not match CPU_ARCHITECTURE=%s (expected %s)\n' \
    "$PLATFORM" "$CPU_ARCHITECTURE" "$expected_platform" >&2
  exit 1
fi

: "${AWS_ACCOUNT_ID:=$(aws sts get-caller-identity --query Account --output text)}"
: "${ECR_REGISTRY:=${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com}"
: "${ECR_PREFIX:=facility-playground}"

login() {
  aws ecr get-login-password --region "$AWS_REGION" |
    docker login --username AWS --password-stdin "$ECR_REGISTRY"
}

# The api, gateway, and mcp images are stages of the root multi-stage Dockerfile;
# web and runner have their own. api and worker share one image (the worker is
# just `node services/api/dist/worker.js` at runtime).
build_and_push() {
  local name="$1" dockerfile="$2" target="$3"
  local context="${4:-$ROOT_DIR}"
  local image="${ECR_REGISTRY}/${ECR_PREFIX}/${name}:${IMAGE_TAG}"
  local target_arg=()
  local build_args=()
  [[ -n "$target" ]] && target_arg=(--target "$target")
  if [[ "$name" == "web" ]]; then
    : "${FACILITY_API_URL:?FACILITY_API_URL is required to build the web image}"
    build_args=(--build-arg "FACILITY_API_URL=$FACILITY_API_URL")
  fi

  if [[ ! -f "$ROOT_DIR/$dockerfile" ]]; then
    printf 'Missing Dockerfile for %s: %s\n' "$name" "$dockerfile" >&2
    exit 1
  fi
  docker build --platform "$PLATFORM" "${target_arg[@]}" "${build_args[@]}" \
    -f "$ROOT_DIR/$dockerfile" -t "$image" "$context"
  docker push "$image"
  printf '%s=%s\n' "$name" "$image"
}

# Retag an already-built local image into another ECR repo (no rebuild).
retag_and_push() {
  local from="$1" to="$2"
  local src="${ECR_REGISTRY}/${ECR_PREFIX}/${from}:${IMAGE_TAG}"
  local dst="${ECR_REGISTRY}/${ECR_PREFIX}/${to}:${IMAGE_TAG}"
  docker tag "$src" "$dst"
  docker push "$dst"
  printf '%s=%s\n' "$to" "$dst"
}

login
build_and_push api Dockerfile api
# The worker runs the api image with a different command — same bits, own repo.
retag_and_push api worker
build_and_push gateway Dockerfile gateway
build_and_push mcp Dockerfile mcp
build_and_push web apps/web/Dockerfile web
build_and_push runner runner/Dockerfile "" "$ROOT_DIR"
