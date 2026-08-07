# GHCR publication overlay. Merge this after docker-bake.hcl so one BuildKit
# graph pushes addressable digests without exposing release tags before every
# target succeeds and promotion validates the complete set. Default BuildKit
# provenance embeds per-run timestamps in an unsigned wrapper index, making an
# identical runtime image produce a different digest on replay. The base graph
# disables that wrapper so AWS and GHCR address the same exact runtime manifest.
variable "PUBLISH_REGISTRY" {
  default = "ghcr.io"
}

variable "PUBLISH_PREFIX" {
  default = "theam/facility"
}

target "api" {
  tags       = []
  output     = ["type=image,name=${PUBLISH_REGISTRY}/${PUBLISH_PREFIX}/api,push-by-digest=true,name-canonical=true,push=true"]
  cache-from = ["type=gha,scope=facility-api"]
  cache-to   = ["type=gha,mode=max,scope=facility-api"]
}

target "gateway" {
  tags       = []
  output     = ["type=image,name=${PUBLISH_REGISTRY}/${PUBLISH_PREFIX}/gateway,push-by-digest=true,name-canonical=true,push=true"]
  cache-from = ["type=gha,scope=facility-gateway"]
  cache-to   = ["type=gha,mode=max,scope=facility-gateway"]
}

target "mcp" {
  tags       = []
  output     = ["type=image,name=${PUBLISH_REGISTRY}/${PUBLISH_PREFIX}/mcp,push-by-digest=true,name-canonical=true,push=true"]
  cache-from = ["type=gha,scope=facility-mcp"]
  cache-to   = ["type=gha,mode=max,scope=facility-mcp"]
}

target "web" {
  tags       = []
  output     = ["type=image,name=${PUBLISH_REGISTRY}/${PUBLISH_PREFIX}/web,push-by-digest=true,name-canonical=true,push=true"]
  cache-from = ["type=gha,scope=facility-web"]
  cache-to   = ["type=gha,mode=max,scope=facility-web"]
}

target "runner" {
  tags       = []
  output     = ["type=image,name=${PUBLISH_REGISTRY}/${PUBLISH_PREFIX}/runner,push-by-digest=true,name-canonical=true,push=true"]
  cache-from = ["type=gha,scope=facility-runner"]
  cache-to   = ["type=gha,mode=max,scope=facility-runner"]
}
