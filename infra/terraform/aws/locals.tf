locals {
  name_prefix = "facility-${var.environment}"
  azs         = slice(data.aws_availability_zones.available.names, 0, 2)

  tags = {
    Application = "facility"
    Environment = var.environment
    ManagedBy   = "terraform"
  }

  runtime_secret_keys = toset([
    "DATABASE_URL",
    "SECRET_MASTER_KEY",
    "VERCEL_TOKEN",
    "GITHUB_OAUTH_CLIENT_ID",
    "GITHUB_OAUTH_CLIENT_SECRET",
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_WEBHOOK_SECRET",
    "GITHUB_APP_SLUG",
    "FACILITY_OAUTH_JWKS",
  ])

  common_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "PORT", value = "4400" },
    { name = "PUBLIC_URL", value = "https://${var.app_hostname}" },
    { name = "WEB_URL", value = "https://${var.app_hostname}" },
    { name = "AUTH_CALLBACK_URL", value = "https://${var.app_hostname}/api/auth/callback" },
    { name = "FACILITY_PREVIEW_URL", value = "https://${var.preview_hostname}" },
    { name = "FACILITY_WORKSPACE_DRIVER", value = "vercel" },
    { name = "FACILITY_WORKSPACE_IMAGE", value = var.workspace_image },
    { name = "VERCEL_TEAM_ID", value = var.vercel_team_id },
    { name = "VERCEL_PROJECT_ID", value = var.vercel_project_id },
    { name = "AUTH_IDENTITY_PROVIDER", value = "github" },
    { name = "GITHUB_OAUTH_ALLOWED_ORGANIZATION", value = var.github_oauth_allowed_organization },
    { name = "FACILITY_INSTANCE_ID", value = var.facility_instance_id },
    { name = "FACILITY_OAUTH_ISSUER", value = "https://${var.app_hostname}" },
    { name = "MCP_PUBLIC_URL", value = "https://${var.app_hostname}/mcp" },
  ]

  common_secrets = concat(
    [for name in sort(tolist(local.runtime_secret_keys)) : {
      name      = name
      valueFrom = "${aws_secretsmanager_secret.runtime.arn}:${name}::"
    }],
    [for name, arn in var.project_secret_arns : {
      name      = name
      valueFrom = arn
    }],
  )

  services = {
    api = {
      image         = "${aws_ecr_repository.service["api"].repository_url}:${var.image_tag}"
      command       = []
      port          = 4400
      desired_count = var.api_desired_count
      environment   = local.common_environment
      secrets       = local.common_secrets
    }
    worker = {
      image         = "${aws_ecr_repository.service["api"].repository_url}:${var.image_tag}"
      command       = ["node", "dist/worker.js"]
      port          = 0
      desired_count = var.worker_desired_count
      environment   = local.common_environment
      secrets       = local.common_secrets
    }
    web = {
      image         = "${aws_ecr_repository.service["web"].repository_url}:${var.image_tag}"
      command       = []
      port          = 3400
      desired_count = var.web_desired_count
      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "FACILITY_API_URL", value = "http://api.${aws_service_discovery_private_dns_namespace.facility.name}:4400" },
      ]
      secrets = []
    }
  }
}
