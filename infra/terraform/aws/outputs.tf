output "alb_dns_name" {
  description = "Public ALB DNS name. Point app/api hostnames here when Route53 is not managed by this module."
  value       = aws_lb.public.dns_name
}

output "app_url" {
  description = "Configured public web app URL."
  value       = local.public_urls.web
}

output "api_url" {
  description = "Configured public API URL."
  value       = local.public_urls.api
}

output "mcp_url" {
  description = "Configured public MCP resource URL."
  value       = local.public_urls.mcp
}

output "preview_url" {
  description = "Isolated browser origin for protected preview applications."
  value       = local.public_urls.preview
}

output "github_webhook_url" {
  description = "Public GitHub App webhook URL."
  value       = "${local.public_urls.api}/webhooks/github"
}

output "gateway_internal_url" {
  description = "Internal-only gateway URL reachable from ECS services."
  value       = "http://${aws_service_discovery_service.gateway.name}.${aws_service_discovery_private_dns_namespace.facility.name}:${local.ports.gateway}"
}

output "ecr_repository_urls" {
  description = "ECR repository URLs for build-images.sh."
  value       = { for name, repo in aws_ecr_repository.service : name => repo.repository_url }
}

output "aws_region" {
  description = "AWS region used by the digest-pinned deploy command."
  value       = var.aws_region
}

output "task_cpu_architecture" {
  description = "CPU architecture that release image manifests must match."
  value       = var.task_cpu_architecture
}

output "secret_arns" {
  description = "Secrets Manager ARNs to populate out-of-band. Values are intentionally not managed by Terraform."
  value       = { for name, secret in aws_secretsmanager_secret.app : name => secret.arn }
}

output "rds_endpoint" {
  description = "RDS Postgres endpoint."
  value       = aws_db_instance.postgres.address
}

output "rds_master_user_secret_arn" {
  description = "AWS-managed RDS master password secret ARN."
  value       = aws_db_instance.postgres.master_user_secret[0].secret_arn
}

output "ecs_cluster_name" {
  description = "ECS cluster name."
  value       = aws_ecs_cluster.facility.name
}

output "codebuild_runner_project_name" {
  description = "CodeBuild project used for ephemeral privileged Facility sandboxes."
  value       = aws_codebuild_project.runner.name
}

output "migrate_task_definition_arn" {
  description = "One-shot migration task definition. Run manually; Terraform does not auto-run migrations."
  value       = aws_ecs_task_definition.migrate.arn
}

output "service_task_definition_arns" {
  description = "Terraform-rendered service templates used to register digest-pinned release revisions."
  value       = { for name, task in aws_ecs_task_definition.service : name => task.arn }
}

output "private_subnet_ids" {
  description = "Private subnet IDs for one-shot ECS tasks."
  value       = [for subnet in aws_subnet.private : subnet.id]
}

output "service_security_group_id" {
  description = "Security group ID for ECS services and one-shot tasks."
  value       = aws_security_group.service.id
}
