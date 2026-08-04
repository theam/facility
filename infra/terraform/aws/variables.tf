variable "aws_region" {
  description = "AWS region for the reference deployment."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Environment name used in resource names and tags."
  type        = string
  default     = "playground"
}

variable "project" {
  description = "Short project name used in resource names and tags."
  type        = string
  default     = "facility"
}

variable "allowed_http_cidr_blocks" {
  description = "CIDR blocks allowed to reach the public ALB."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.61.0.0/16"
}

variable "app_hostname" {
  description = "Public hostname for the Next.js web app."
  type        = string
}

variable "api_hostname" {
  description = "Public hostname for the Fastify API."
  type        = string
}

variable "mcp_hostname" {
  description = "Public hostname for the Facility MCP resource server."
  type        = string
}

variable "route53_zone_id" {
  description = "Optional Route53 hosted zone ID. When set, app/api alias records are created."
  type        = string
  default     = ""
}

variable "acm_certificate_arn" {
  description = "Optional ACM certificate ARN for HTTPS listeners on the ALB."
  type        = string
  default     = ""
}

variable "enable_cloudfront_api_endpoint" {
  description = "Expose the API through an AWS-managed CloudFront HTTPS hostname when no public DNS zone is available."
  type        = bool
  default     = false
}

variable "auth_identity_provider" {
  description = "Upstream human identity mode: github for direct self-hosted OAuth, oidc for the commercial broker."
  type        = string
  default     = "github"
  validation {
    condition     = contains(["github", "oidc"], var.auth_identity_provider)
    error_message = "auth_identity_provider must be github or oidc."
  }
}

variable "github_oauth_allowed_organization" {
  description = "Optional GitHub organization login whose active members may authenticate in direct GitHub mode. Empty preserves the default invitation and installation checks."
  type        = string
  default     = ""
  validation {
    condition     = trimspace(var.github_oauth_allowed_organization) == "" || can(regex("^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$", trimspace(var.github_oauth_allowed_organization)))
    error_message = "github_oauth_allowed_organization must be empty or a GitHub organization login, not a URL."
  }
}

variable "oidc_issuer" {
  description = "Commercial identity broker issuer when auth_identity_provider is oidc."
  type        = string
  default     = ""
}

variable "facility_instance_id" {
  description = "Stable SaaS instance identifier required by the commercial OIDC broker."
  type        = string
  default     = ""
}

variable "enable_dev_provider_fallback" {
  description = "Inject DEV_ANTHROPIC_API_KEY and DEV_OPENAI_API_KEY into the gateway. Keep false for production."
  type        = bool
  default     = false
}

variable "enable_package_registry_token" {
  description = "Inject the optional private package registry token into the trusted API for scoped runner handoff. Populate the secret before enabling."
  type        = bool
  default     = false
}

variable "database_name" {
  description = "Initial RDS database name."
  type        = string
  default     = "facility"
}

variable "database_username" {
  description = "RDS master username. The password is AWS-managed in Secrets Manager."
  type        = string
  default     = "facility"
}

variable "database_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "database_allocated_storage_gb" {
  description = "Allocated RDS storage in GiB."
  type        = number
  default     = 20
}

variable "database_backup_retention_days" {
  description = "RDS backup retention in days."
  type        = number
  default     = 7
}

variable "enable_deletion_protection" {
  description = "Enable deletion protection on persistent resources."
  type        = bool
  default     = true
}

variable "force_destroy_bucket" {
  description = "Allow Terraform to destroy the object bucket even when it contains objects. Keep false for production."
  type        = bool
  default     = false
}

variable "container_image_tags" {
  description = "Image tags used when image_overrides does not provide a full image URI."
  type = object({
    api     = string
    worker  = string
    gateway = string
    web     = string
    mcp     = string
    runner  = string
  })
  default = {
    api     = "latest"
    worker  = "latest"
    gateway = "latest"
    web     = "latest"
    mcp     = "latest"
    runner  = "latest"
  }
}

variable "image_overrides" {
  description = "Optional full image URI overrides keyed by api, worker, gateway, web, runner."
  type        = map(string)
  default     = {}
}

variable "task_cpu_architecture" {
  description = "CPU architecture for ECS tasks. Images must be built for the matching platform."
  type        = string
  default     = "X86_64"

  validation {
    condition     = contains(["X86_64", "ARM64"], var.task_cpu_architecture)
    error_message = "task_cpu_architecture must be X86_64 or ARM64."
  }
}

variable "api_desired_count" {
  description = "Desired ECS task count for the API service."
  type        = number
  default     = 2
}

variable "worker_desired_count" {
  description = "Desired ECS task count for the worker service."
  type        = number
  default     = 1
}

variable "gateway_desired_count" {
  description = "Desired ECS task count for the internal gateway service."
  type        = number
  default     = 2
}

variable "web_desired_count" {
  description = "Desired ECS task count for the web service."
  type        = number
  default     = 2
}

variable "mcp_desired_count" {
  description = "Desired ECS task count for the public MCP service."
  type        = number
  default     = 2
}

variable "target_deregistration_delay_seconds" {
  description = "Seconds ALB target groups wait for in-flight requests before completing an ECS rollout. Keep the 300-second default for normal production traffic; validation stacks may use a shorter value."
  type        = number
  default     = 300

  validation {
    condition     = var.target_deregistration_delay_seconds >= 0 && var.target_deregistration_delay_seconds <= 3600
    error_message = "target_deregistration_delay_seconds must be between 0 and 3600."
  }
}

variable "task_cpu" {
  description = "Per-service Fargate CPU units."
  type = object({
    api     = number
    worker  = number
    gateway = number
    web     = number
    mcp     = number
    runner  = number
    migrate = number
  })
  default = {
    api     = 512
    worker  = 512
    gateway = 512
    web     = 512
    mcp     = 256
    runner  = 1024
    migrate = 512
  }
}

variable "task_memory" {
  description = "Per-service Fargate memory in MiB."
  type = object({
    api     = number
    worker  = number
    gateway = number
    web     = number
    mcp     = number
    runner  = number
    migrate = number
  })
  default = {
    api     = 1024
    worker  = 1024
    gateway = 1024
    web     = 1024
    mcp     = 512
    runner  = 2048
    migrate = 1024
  }
}

variable "envelope_retention_days" {
  type        = number
  default     = 90
  description = "Days to retain stored LLM request/response envelopes (the objects bucket `envelopes/` prefix) before S3 expires them — bounds raw-body retention for privacy/compliance while preserving recent data-mining."
}
