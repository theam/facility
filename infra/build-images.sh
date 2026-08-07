#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AWS_REGION="${AWS_REGION:-us-east-1}"
IMAGE_TAG="${IMAGE_TAG:-$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo latest)}"
CPU_ARCHITECTURE="${CPU_ARCHITECTURE:-X86_64}"
SOURCE_SHA="${SOURCE_SHA:-$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || true)}"
FACILITY_ALLOW_DIRTY_BUILD="${FACILITY_ALLOW_DIRTY_BUILD:-0}"

if [[ ! "$SOURCE_SHA" =~ ^[0-9a-f]{40,64}$ ]]; then
  printf 'SOURCE_SHA must be a full lowercase commit SHA (received %s)\n' "${SOURCE_SHA:-missing}" >&2
  exit 1
fi

if [[ "$FACILITY_ALLOW_DIRTY_BUILD" != "0" && "$FACILITY_ALLOW_DIRTY_BUILD" != "1" ]]; then
  printf 'FACILITY_ALLOW_DIRTY_BUILD must be 0 or 1 (received %s)\n' \
    "$FACILITY_ALLOW_DIRTY_BUILD" >&2
  exit 1
fi
if ! worktree_status="$(git -C "$ROOT_DIR" status --porcelain=v1 --untracked-files=all 2>/dev/null)"; then
  printf '%s\n' 'Facility release images must be built from a Git worktree.' >&2
  exit 1
fi
if [[ -n "$worktree_status" && "$FACILITY_ALLOW_DIRTY_BUILD" != "1" ]]; then
  printf '%s\n' \
    'Refusing to label uncommitted image bytes with SOURCE_SHA; commit or stash changes, or explicitly set FACILITY_ALLOW_DIRTY_BUILD=1.' >&2
  exit 1
fi
unset worktree_status

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

BAKE_FILE="$ROOT_DIR/infra/docker-bake.hcl"
if [[ ! -f "$BAKE_FILE" ]]; then
  printf 'Missing Facility image build definition: %s\n' "$BAKE_FILE" >&2
  exit 1
fi
if ! docker buildx version >/dev/null 2>&1; then
  printf '%s\n' 'Docker Buildx is required. Install the buildx plugin and retry.' >&2
  exit 1
fi

export ECR_REGISTRY ECR_PREFIX IMAGE_TAG PLATFORM

login

mkdir -p "$ROOT_DIR/.tmp"
metadata_path="$(mktemp "$ROOT_DIR/.tmp/facility-bake-metadata.XXXXXX")"
manifest_path="${MANIFEST_PATH:-$ROOT_DIR/.tmp/facility-aws-release-$SOURCE_SHA.json}"
cleanup() {
  rm -f "$metadata_path"
}
trap cleanup EXIT

# Bake runs independent targets concurrently and shares the root Dockerfile's
# dependency graph. API and worker run the same digest from the API repository
# with different ECS commands, so only one copy is pushed and scanned.
(
  # Bake automatically reads a .env from its working directory. Run from the
  # env-free infra directory so application secrets are neither parsed nor
  # forwarded into the build definition.
  cd "$ROOT_DIR/infra"
  docker buildx bake \
    --allow=fs.read=.. \
    --file "$BAKE_FILE" \
    --metadata-file "$metadata_path" \
    --push
)

node "$ROOT_DIR/scripts/deploy-aws.mjs" manifest \
  --metadata "$metadata_path" \
  --repository-prefix "$ECR_REGISTRY/$ECR_PREFIX" \
  --source-sha "$SOURCE_SHA" \
  --platform "$PLATFORM" \
  --output "$manifest_path" >/dev/null

# Preserve the script's stable machine-readable output contract while making
# the worker alias explicit for callers that still expect all service roles.
api_ref="$ECR_REGISTRY/$ECR_PREFIX/api:$IMAGE_TAG"
printf 'api=%s\n' "$api_ref"
printf 'worker=%s\n' "$api_ref"
for name in gateway mcp web runner; do
  printf '%s=%s/%s/%s:%s\n' "$name" "$ECR_REGISTRY" "$ECR_PREFIX" "$name" "$IMAGE_TAG"
done
printf 'manifest=%s\n' "$manifest_path"
