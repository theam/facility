output "application_url" {
  value = "https://${var.app_hostname}"
}

output "mcp_url" {
  value = "https://${var.app_hostname}/mcp"
}

output "github_webhook_url" {
  value = "https://${var.app_hostname}/webhooks/github"
}

output "preview_url" {
  value = "https://${var.preview_hostname}"
}

output "load_balancer_dns_name" {
  value = aws_lb.facility.dns_name
}

output "ecr_repository_urls" {
  value = { for name, repository in aws_ecr_repository.service : name => repository.repository_url }
}

output "runtime_secret_arn" {
  value = aws_secretsmanager_secret.runtime.arn
}

output "database_endpoint" {
  value = aws_db_instance.facility.endpoint
}

output "database_master_secret_arn" {
  value     = aws_db_instance.facility.master_user_secret[0].secret_arn
  sensitive = true
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.facility.name
}

output "migrate_task_definition_arn" {
  value = aws_ecs_task_definition.migrate.arn
}

output "private_subnet_ids" {
  value = [for subnet in aws_subnet.private : subnet.id]
}

output "service_security_group_id" {
  value = aws_security_group.service.id
}
