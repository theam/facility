variable "ECR_REGISTRY" {
  default = ""
}

variable "ECR_PREFIX" {
  default = "facility-playground"
}

variable "IMAGE_TAG" {
  default = "latest"
}

variable "PLATFORM" {
  default = "linux/amd64"
}

group "default" {
  targets = ["api", "web", "runner"]
}

target "service" {
  context    = ".."
  dockerfile = "Dockerfile"
  platforms  = [PLATFORM]
  # A timestamped provenance wrapper gives identical runtime bytes a new
  # manifest digest on every build. The release manifest pins the exact runtime
  # manifest produced by this build without presenting the wrapper as provenance.
  attest = ["type=provenance,disabled=true"]
}

# Make the shared package build a real dependency edge. Without the named
# context, concurrent target solves may each start the same cold RUN before a
# sibling has populated BuildKit's cache.
target "service-packages" {
  inherits = ["service"]
  target   = "build-service-packages"
}

target "api" {
  inherits = ["service"]
  target   = "api"
  contexts = { build-service-packages = "target:service-packages" }
  tags     = ["${ECR_REGISTRY}/${ECR_PREFIX}/api:${IMAGE_TAG}"]
}

target "web" {
  context    = ".."
  dockerfile = "apps/web/Dockerfile"
  target     = "web"
  platforms  = [PLATFORM]
  tags = ["${ECR_REGISTRY}/${ECR_PREFIX}/web:${IMAGE_TAG}"]
  attest = ["type=provenance,disabled=true"]
}

target "runner" {
  context    = ".."
  dockerfile = "runner/Dockerfile"
  platforms  = [PLATFORM]
  tags       = ["${ECR_REGISTRY}/${ECR_PREFIX}/runner:${IMAGE_TAG}"]
  attest     = ["type=provenance,disabled=true"]
}
