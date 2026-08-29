data "aws_caller_identity" "current" {}
data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name_prefix = "${var.project}-${var.environment}"
  azs         = slice(data.aws_availability_zones.available.names, 0, 2)

  # The default AWS path owns its isolated HTTPS preview origin. Operators who
  # already own a separate registered site can keep routing it through the ALB.
  managed_preview_origin = trimspace(var.preview_hostname) == ""

  # Interactive MCP OAuth is browser-facing and must never be advertised over
  # the certificate-less validation stack. That mode keeps MCP available with
  # scoped fak_ API keys; adding ACM enables the issuer, signing key, and
  # authorization-server advertisement as one unit.
  interactive_mcp_oauth_enabled = trimspace(var.acm_certificate_arn) != ""

  tags = {
    Project     = var.project
    Environment = var.environment
    ManagedBy   = "terraform"
  }

  ecr_repositories = toset(["api", "gateway", "web", "mcp", "runner"])

  ports = {
    api     = 4400
    worker  = 4400
    gateway = 4410
    web     = 3400
    mcp     = 4420
    runner  = 8080
    migrate = 0
  }

  artifact_images = {
    for name in local.ecr_repositories :
    name => coalesce(
      lookup(var.image_overrides, name, null),
      "${aws_ecr_repository.service[name].repository_url}:${var.container_image_tags[name]}"
    )
  }

  # Worker is a separate fault/scaling boundary that deliberately executes the
  # API artifact with another command. A distinct override remains supported
  # for existing operators, but the AWS fallback no longer stores or scans the
  # same bytes in a second ECR repository.
  images = merge(local.artifact_images, {
    worker = coalesce(lookup(var.image_overrides, "worker", null), local.artifact_images.api)
  })

  public_urls = {
    api     = var.enable_cloudfront_api_endpoint ? "https://${aws_cloudfront_distribution.api[0].domain_name}" : "${var.acm_certificate_arn == "" ? "http" : "https"}://${var.api_hostname}"
    web     = "${var.acm_certificate_arn == "" ? "http" : "https"}://${var.app_hostname}"
    mcp     = "${var.acm_certificate_arn == "" ? "http" : "https"}://${var.mcp_hostname}"
    preview = local.managed_preview_origin ? "https://${aws_cloudfront_distribution.preview[0].domain_name}" : "${var.acm_certificate_arn == "" ? "http" : "https"}://${var.preview_hostname}"
  }

  common_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "LOG_LEVEL", value = "info" },
    { name = "S3_BUCKET", value = aws_s3_bucket.objects.bucket },
    { name = "AWS_REGION", value = var.aws_region },
    # The control plane remains on AWS while sandbox compute is a swappable
    # provider. The migrate+seed task receives the same pair so new profiles
    # are immediately executable on the selected provider.
    { name = "FACILITY_SANDBOX_DRIVER", value = var.sandbox_driver },
    { name = "FACILITY_RUNNER_IMAGE", value = var.sandbox_driver == "vercel" ? var.vercel_runner_image : local.images.runner },
  ]

  aws_sandbox_environment = [
    { name = "FACILITY_AWS_CODEBUILD_PROJECT", value = aws_codebuild_project.runner.name },
    { name = "FACILITY_AWS_CODEBUILD_CACHE_BASE_LOCATION", value = "${aws_s3_bucket.objects.bucket}/codebuild-cache" },
    # Agent runs use CodeBuild; preview services still need an inbound endpoint,
    # so they run as unprivileged, dynamically registered Fargate tasks.
    { name = "FACILITY_AWS_ECS_CLUSTER", value = aws_ecs_cluster.facility.name },
    { name = "FACILITY_AWS_SUBNETS", value = join(",", [for subnet in aws_subnet.private : subnet.id]) },
    { name = "FACILITY_AWS_PREVIEW_SECURITY_GROUPS", value = aws_security_group.sandbox.id },
    { name = "FACILITY_AWS_PREVIEW_TASK_FAMILY", value = "${local.name_prefix}-preview" },
    { name = "FACILITY_AWS_PREVIEW_EXECUTION_ROLE_ARN", value = aws_iam_role.preview_execution.arn },
    { name = "FACILITY_AWS_PREVIEW_TASK_ROLE_ARN", value = aws_iam_role.preview_task.arn },
    { name = "FACILITY_AWS_PREVIEW_LOG_GROUP", value = aws_cloudwatch_log_group.service["preview"].name },
    { name = "FACILITY_AWS_TASK_CPU_ARCHITECTURE", value = var.task_cpu_architecture },
  ]

  vercel_sandbox_environment = [
    { name = "VERCEL_TEAM_ID", value = var.vercel_team_id },
    { name = "VERCEL_PROJECT_ID", value = var.vercel_project_id },
  ]

  sandbox_provider_environment = (
    var.sandbox_driver == "vercel" ? local.vercel_sandbox_environment : local.aws_sandbox_environment
  )

  preview_surface_environment = local.managed_preview_origin ? [
    { name = "FACILITY_PREVIEW_SURFACE_TOKEN", value = random_password.preview_surface[0].result },
  ] : []

  api_oauth_environment = local.interactive_mcp_oauth_enabled ? [
    { name = "FACILITY_OAUTH_ISSUER", value = local.public_urls.web },
    { name = "MCP_PUBLIC_URL", value = local.public_urls.mcp },
  ] : []

  api_environment = concat(local.common_environment, local.sandbox_provider_environment, local.preview_surface_environment, local.api_oauth_environment, [
    { name = "PORT", value = tostring(local.ports.api) },
    { name = "PUBLIC_URL", value = local.public_urls.api },
    { name = "WEB_URL", value = local.public_urls.web },
    { name = "FACILITY_PREVIEW_URL", value = local.public_urls.preview },
    { name = "AUTH_IDENTITY_PROVIDER", value = var.auth_identity_provider },
    { name = "AUTH_CALLBACK_URL", value = "${local.public_urls.web}/api/auth/callback" },
    { name = "GITHUB_OAUTH_ALLOWED_ORGANIZATION", value = lower(trimspace(var.github_oauth_allowed_organization)) },
    { name = "OIDC_ISSUER", value = var.oidc_issuer },
    { name = "FACILITY_INSTANCE_ID", value = var.facility_instance_id },
    { name = "GATEWAY_URL", value = "http://${aws_service_discovery_service.gateway.name}.${aws_service_discovery_private_dns_namespace.facility.name}:${local.ports.gateway}" },
    # AWS sandboxes reach the gateway over private service discovery. Vercel
    # sandboxes use the authenticated provider paths routed through the existing
    # public API hostname; the ALB exposes no other gateway surface.
    { name = "SANDBOX_GATEWAY_URL", value = var.sandbox_driver == "vercel" ? local.public_urls.api : "http://${aws_service_discovery_service.gateway.name}.${aws_service_discovery_private_dns_namespace.facility.name}:${local.ports.gateway}" },
  ])

  worker_environment = concat(local.common_environment, local.sandbox_provider_environment, [
    { name = "PORT", value = tostring(local.ports.worker) },
    { name = "PUBLIC_URL", value = local.public_urls.api },
    { name = "WEB_URL", value = local.public_urls.web },
    { name = "FACILITY_PREVIEW_URL", value = local.public_urls.preview },
    # API and worker can both dispatch/reconcile sandboxes. They must derive the
    # same ownership namespace when an operator pins a stable instance id.
    { name = "FACILITY_INSTANCE_ID", value = var.facility_instance_id },
    { name = "GATEWAY_URL", value = "http://${aws_service_discovery_service.gateway.name}.${aws_service_discovery_private_dns_namespace.facility.name}:${local.ports.gateway}" },
    { name = "SANDBOX_GATEWAY_URL", value = var.sandbox_driver == "vercel" ? local.public_urls.api : "http://${aws_service_discovery_service.gateway.name}.${aws_service_discovery_private_dns_namespace.facility.name}:${local.ports.gateway}" },
  ])

  gateway_environment = concat(local.common_environment, [
    { name = "GATEWAY_PORT", value = tostring(local.ports.gateway) },
    { name = "PORT", value = tostring(local.ports.gateway) },
    { name = "PUBLIC_URL", value = "http://${aws_service_discovery_service.gateway.name}.${aws_service_discovery_private_dns_namespace.facility.name}:${local.ports.gateway}" },
  ])

  web_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "PORT", value = tostring(local.ports.web) },
    { name = "FACILITY_API_URL", value = local.public_urls.api },
  ]

  mcp_oauth_environment = local.interactive_mcp_oauth_enabled ? [
    { name = "MCP_PUBLIC_URL", value = local.public_urls.mcp },
    { name = "MCP_AUTHORIZATION_SERVER", value = local.public_urls.web },
  ] : []

  mcp_environment = concat([
    { name = "NODE_ENV", value = "production" },
    { name = "FACILITY_API_URL", value = local.public_urls.api },
    { name = "MCP_ALLOWED_HOSTS", value = var.mcp_hostname },
  ], local.mcp_oauth_environment)

  app_secret_names = toset([
    "database_url",
    "secret_master_key",
    "github_oauth_client_id",
    "github_oauth_client_secret",
    "oidc_client_id",
    "oidc_client_secret",
    "facility_oauth_jwks",
    "github_app_id",
    "github_app_private_key",
    "github_app_webhook_secret",
    "github_app_slug",
    "package_registry_token",
    "dev_anthropic_api_key",
    "dev_openai_api_key",
    "vercel_token",
  ])

  core_secrets = [
    { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.app["database_url"].arn },
    { name = "SECRET_MASTER_KEY", valueFrom = aws_secretsmanager_secret.app["secret_master_key"].arn },
    { name = "GITHUB_APP_ID", valueFrom = aws_secretsmanager_secret.app["github_app_id"].arn },
    { name = "GITHUB_APP_PRIVATE_KEY", valueFrom = aws_secretsmanager_secret.app["github_app_private_key"].arn },
    { name = "GITHUB_APP_WEBHOOK_SECRET", valueFrom = aws_secretsmanager_secret.app["github_app_webhook_secret"].arn },
    { name = "GITHUB_APP_SLUG", valueFrom = aws_secretsmanager_secret.app["github_app_slug"].arn },
  ]

  identity_secrets = var.auth_identity_provider == "github" ? [
    { name = "GITHUB_OAUTH_CLIENT_ID", valueFrom = aws_secretsmanager_secret.app["github_oauth_client_id"].arn },
    { name = "GITHUB_OAUTH_CLIENT_SECRET", valueFrom = aws_secretsmanager_secret.app["github_oauth_client_secret"].arn },
    ] : [
    { name = "OIDC_CLIENT_ID", valueFrom = aws_secretsmanager_secret.app["oidc_client_id"].arn },
    { name = "OIDC_CLIENT_SECRET", valueFrom = aws_secretsmanager_secret.app["oidc_client_secret"].arn },
  ]

  common_secrets = local.core_secrets
  package_registry_secrets = [
    { name = "PACKAGE_REGISTRY_TOKEN", valueFrom = aws_secretsmanager_secret.app["package_registry_token"].arn },
  ]

  sandbox_provider_secrets = var.sandbox_driver == "vercel" ? [
    { name = "VERCEL_TOKEN", valueFrom = aws_secretsmanager_secret.app["vercel_token"].arn },
  ] : []

  api_secrets = concat(
    local.core_secrets,
    local.identity_secrets,
    local.interactive_mcp_oauth_enabled ? [{ name = "FACILITY_OAUTH_JWKS", valueFrom = aws_secretsmanager_secret.app["facility_oauth_jwks"].arn }] : [],
    var.enable_package_registry_token ? local.package_registry_secrets : [],
    local.sandbox_provider_secrets
  )

  worker_secrets = concat(local.common_secrets, local.sandbox_provider_secrets)

  dev_provider_secrets = [
    { name = "DEV_ANTHROPIC_API_KEY", valueFrom = aws_secretsmanager_secret.app["dev_anthropic_api_key"].arn },
    { name = "DEV_OPENAI_API_KEY", valueFrom = aws_secretsmanager_secret.app["dev_openai_api_key"].arn },
  ]

  gateway_secrets = concat(local.common_secrets, var.enable_dev_provider_fallback ? local.dev_provider_secrets : [])

  log_groups = toset(["api", "worker", "gateway", "web", "mcp", "runner", "preview", "migrate"])

  ecs_services = {
    api = {
      desired_count = var.api_desired_count
      image         = local.images.api
      command       = ["node", "dist/start.js"]
      port          = local.ports.api
      environment   = local.api_environment
      secrets       = local.api_secrets
      public        = true
      health_path   = "/health"
    }
    worker = {
      desired_count = var.worker_desired_count
      image         = local.images.worker
      command       = ["node", "dist/worker.js"]
      port          = local.ports.worker
      environment   = local.worker_environment
      secrets       = local.worker_secrets
      public        = false
      health_path   = "/health"
    }
    gateway = {
      desired_count = var.gateway_desired_count
      image         = local.images.gateway
      command       = []
      port          = local.ports.gateway
      environment   = local.gateway_environment
      secrets       = local.gateway_secrets
      public        = false
      health_path   = "/health"
    }
    web = {
      desired_count = var.web_desired_count
      image         = local.images.web
      command       = []
      port          = local.ports.web
      environment   = local.web_environment
      secrets       = []
      public        = true
      health_path   = "/"
    }
    mcp = {
      desired_count = var.mcp_desired_count
      image         = local.images.mcp
      command       = ["node", "dist/bin/facility-mcp.js", "serve", "--host", "0.0.0.0", "--port", "4420"]
      port          = local.ports.mcp
      environment   = local.mcp_environment
      secrets       = []
      public        = true
      health_path   = "/readyz"
    }
  }
}
