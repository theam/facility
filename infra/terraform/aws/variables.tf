variable "aws_region" {
  description = "AWS region for the Facility control plane."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Environment name used in resource names and tags."
  type        = string
  default     = "production"
}

variable "vpc_cidr" {
  description = "CIDR block for the Facility VPC."
  type        = string
  default     = "10.61.0.0/16"
}

variable "app_hostname" {
  description = "Public hostname shared by the web UI, API, webhooks, and MCP endpoint."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9.-]+$", var.app_hostname))
    error_message = "app_hostname must be a hostname, not a URL."
  }
}

variable "preview_hostname" {
  description = "Separate public hostname used only for authenticated workspace previews."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9.-]+$", var.preview_hostname)) && var.preview_hostname != var.app_hostname
    error_message = "preview_hostname must be a hostname on a different registered site from app_hostname."
  }
}

variable "route53_zone_id" {
  description = "Optional Route53 hosted zone id for app_hostname."
  type        = string
  default     = ""
}

variable "preview_route53_zone_id" {
  description = "Optional Route53 hosted zone id for preview_hostname. This is normally a different zone from route53_zone_id."
  type        = string
  default     = ""
}

variable "acm_certificate_arn" {
  description = "ACM certificate covering app_hostname and preview_hostname."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:acm:", var.acm_certificate_arn))
    error_message = "acm_certificate_arn must be an ACM certificate ARN."
  }
}

variable "allowed_http_cidr_blocks" {
  description = "CIDR blocks allowed to reach the public load balancer."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "image_tag" {
  description = "Immutable release tag pushed to the module-owned API and web ECR repositories."
  type        = string
  default     = "bootstrap"

  validation {
    condition     = can(regex("^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$", var.image_tag))
    error_message = "image_tag must be a valid non-empty container tag."
  }
}

variable "workspace_image" {
  description = "Runner image visible to Vercel Sandbox."
  type        = string

  validation {
    condition     = trimspace(var.workspace_image) != ""
    error_message = "workspace_image is required."
  }
}

variable "vercel_team_id" {
  description = "Vercel team that owns Facility workspaces."
  type        = string

  validation {
    condition     = trimspace(var.vercel_team_id) != ""
    error_message = "vercel_team_id is required."
  }
}

variable "vercel_project_id" {
  description = "Vercel project that owns Facility workspaces."
  type        = string

  validation {
    condition     = trimspace(var.vercel_project_id) != ""
    error_message = "vercel_project_id is required."
  }
}

variable "facility_instance_id" {
  description = "Stable identifier for this Facility installation."
  type        = string

  validation {
    condition     = trimspace(var.facility_instance_id) != ""
    error_message = "facility_instance_id is required."
  }
}

variable "github_oauth_allowed_organization" {
  description = "Optional GitHub organization whose members may authenticate."
  type        = string
  default     = ""
}

variable "project_secret_arns" {
  description = "Additional engine/project environment variables mapped to Secrets Manager ARNs."
  type        = map(string)
  default     = {}

  validation {
    condition = alltrue([
      for name, arn in var.project_secret_arns :
      can(regex("^FACILITY_PROJECT_[A-Z0-9_]+$", name)) && can(regex("^arn:aws[a-z-]*:secretsmanager:", arn))
    ])
    error_message = "Project secret names must use FACILITY_PROJECT_<PROJECT_ID>_<NAME> and values must be Secrets Manager ARNs."
  }
}

variable "api_desired_count" {
  description = "Desired number of API tasks. Keep zero until image_tag has been pushed."
  type        = number
  default     = 0
}

variable "worker_desired_count" {
  description = "Desired number of worker tasks. Keep zero until image_tag has been pushed."
  type        = number
  default     = 0
}

variable "web_desired_count" {
  description = "Desired number of web tasks. Keep zero until image_tag has been pushed."
  type        = number
  default     = 0
}

variable "task_cpu_architecture" {
  description = "CPU architecture used by the API and web images."
  type        = string
  default     = "X86_64"

  validation {
    condition     = contains(["X86_64", "ARM64"], var.task_cpu_architecture)
    error_message = "task_cpu_architecture must be X86_64 or ARM64."
  }
}

variable "database_instance_class" {
  description = "RDS PostgreSQL instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "database_allocated_storage_gb" {
  description = "Initial RDS storage allocation in GiB."
  type        = number
  default     = 20
}

variable "database_backup_retention_days" {
  description = "RDS automated backup retention."
  type        = number
  default     = 7
}

variable "enable_deletion_protection" {
  description = "Protect the ALB and RDS instance from accidental deletion."
  type        = bool
  default     = true
}

variable "log_retention_days" {
  description = "CloudWatch log retention for API, worker, web, and migration tasks."
  type        = number
  default     = 30
}
