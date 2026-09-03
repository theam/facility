resource "aws_ecr_repository" "service" {
  for_each = toset(["api", "web"])

  name                 = "${local.name_prefix}/${each.key}"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.facility.arn
  }
}

resource "aws_ecr_lifecycle_policy" "service" {
  for_each = aws_ecr_repository.service

  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the latest 25 releases"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 25
      }
      action = { type = "expire" }
    }]
  })
}

resource "aws_cloudwatch_log_group" "service" {
  for_each = toset(["api", "worker", "web", "migrate"])

  name              = "/facility/${var.environment}/${each.key}"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_cluster" "facility" {
  name = local.name_prefix

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_service_discovery_private_dns_namespace" "facility" {
  name = "${local.name_prefix}.internal"
  vpc  = aws_vpc.facility.id
}

resource "aws_service_discovery_service" "api" {
  name = "api"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.facility.id

    dns_records {
      ttl  = 10
      type = "A"
    }

    routing_policy = "MULTIVALUE"
  }

  health_check_custom_config {
    failure_threshold = 1
  }
}

resource "aws_ecs_task_definition" "service" {
  for_each = local.services

  family                   = "${local.name_prefix}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.key == "worker" ? "1024" : "512"
  memory                   = each.key == "worker" ? "2048" : "1024"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    cpu_architecture        = var.task_cpu_architecture
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    merge(
      {
        name        = each.key
        image       = each.value.image
        essential   = true
        environment = each.value.environment
        secrets     = each.value.secrets
        logConfiguration = {
          logDriver = "awslogs"
          options = {
            awslogs-group         = aws_cloudwatch_log_group.service[each.key].name
            awslogs-region        = var.aws_region
            awslogs-stream-prefix = each.key
          }
        }
      },
      length(each.value.command) > 0 ? { command = each.value.command } : {},
      each.value.port > 0 ? {
        portMappings = [{
          containerPort = each.value.port
          hostPort      = each.value.port
          protocol      = "tcp"
        }]
      } : {},
    )
  ])
}

resource "aws_ecs_service" "service" {
  for_each = local.services

  name             = each.key
  cluster          = aws_ecs_cluster.facility.id
  task_definition  = aws_ecs_task_definition.service[each.key].arn
  desired_count    = each.value.desired_count
  launch_type      = "FARGATE"
  platform_version = "1.4.0"

  deployment_minimum_healthy_percent = each.key == "worker" ? 0 : 50
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = each.key == "worker" ? null : 60

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = [for subnet in aws_subnet.private : subnet.id]
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = false
  }

  dynamic "load_balancer" {
    for_each = contains(["api", "web"], each.key) ? [1] : []

    content {
      target_group_arn = aws_lb_target_group.service[each.key].arn
      container_name   = each.key
      container_port   = each.value.port
    }
  }

  dynamic "service_registries" {
    for_each = each.key == "api" ? [1] : []

    content {
      registry_arn = aws_service_discovery_service.api.arn
    }
  }

  depends_on = [aws_lb_listener.https]
}

resource "aws_ecs_task_definition" "migrate" {
  family                   = "${local.name_prefix}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    cpu_architecture        = var.task_cpu_architecture
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([{
    name        = "migrate"
    image       = "${aws_ecr_repository.service["api"].repository_url}:${var.image_tag}"
    essential   = true
    command     = ["node", "node_modules/@facility/db/dist/bin/deploy.js"]
    environment = local.common_environment
    secrets     = local.common_secrets
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.service["migrate"].name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "migrate"
      }
    }
  }])
}
