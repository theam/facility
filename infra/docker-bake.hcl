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
  targets = ["api", "gateway", "mcp", "web", "runner"]
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

target "api" {
  inherits = ["service"]
  target   = "api"
  tags     = ["${ECR_REGISTRY}/${ECR_PREFIX}/api:${IMAGE_TAG}"]
}

target "gateway" {
  inherits = ["service"]
  target   = "gateway"
  tags     = ["${ECR_REGISTRY}/${ECR_PREFIX}/gateway:${IMAGE_TAG}"]
}

target "mcp" {
  inherits = ["service"]
  target   = "mcp"
  tags     = ["${ECR_REGISTRY}/${ECR_PREFIX}/mcp:${IMAGE_TAG}"]
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
