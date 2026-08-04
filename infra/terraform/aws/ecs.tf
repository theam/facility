resource "aws_cloudwatch_log_group" "service" {
  for_each = local.log_groups

  name              = "/facility/${var.environment}/${each.key}"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.facility.arn
}

resource "aws_ecs_cluster" "facility" {
  name = local.name_prefix

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_service_discovery_private_dns_namespace" "facility" {
  name        = "${local.name_prefix}.local"
  description = "Facility internal service discovery"
  vpc         = aws_vpc.facility.id
}

resource "aws_service_discovery_service" "gateway" {
  name = "gateway"

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
  for_each = local.ecs_services

  family                   = "${local.name_prefix}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"

  runtime_platform {
    cpu_architecture        = var.task_cpu_architecture
    operating_system_family = "LINUX"
  }
  cpu                = tostring(var.task_cpu[each.key])
  memory             = tostring(var.task_memory[each.key])
  execution_role_arn = aws_iam_role.ecs_execution.arn
  task_role_arn      = aws_iam_role.task.arn

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
      } : {}
    )
  ])
}

resource "aws_ecs_task_definition" "migrate" {
  family                   = "${local.name_prefix}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"

  runtime_platform {
    cpu_architecture        = var.task_cpu_architecture
    operating_system_family = "LINUX"
  }
  cpu                = tostring(var.task_cpu.migrate)
  memory             = tostring(var.task_memory.migrate)
  execution_role_arn = aws_iam_role.ecs_execution.arn
  task_role_arn      = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = "migrate"
      image     = local.images.api
      essential = true
      # Migrate AND seed: bundled roles/action-types/default sandbox profile must
      # exist before administrative instance bootstrap and before `facility doctor`
      # passes. Seed is idempotent (ON CONFLICT) so re-running each deploy is safe.
      command = [
        "sh",
        "-c",
        "node node_modules/@facility/db/dist/bin/migrate.js && node node_modules/@facility/db/dist/bin/seed.js",
      ]
      environment = concat(local.common_environment, [{ name = "FACILITY_SEED_DEMO", value = "0" }])
      secrets     = local.common_secrets
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.service["migrate"].name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "migrate"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "service" {
  for_each = local.ecs_services

  name            = each.key
  cluster         = aws_ecs_cluster.facility.id
  task_definition = aws_ecs_task_definition.service[each.key].arn
  desired_count   = each.value.desired_count
  launch_type     = "FARGATE"

  deployment_minimum_healthy_percent = 50
  deployment_maximum_percent         = 200
  enable_execute_command             = true

  network_configuration {
    subnets          = [for subnet in aws_subnet.private : subnet.id]
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = false
  }

  dynamic "load_balancer" {
    for_each = each.value.public ? [1] : []

    content {
      target_group_arn = aws_lb_target_group.service[each.key].arn
      container_name   = each.key
      container_port   = each.value.port
    }
  }

  dynamic "service_registries" {
    for_each = each.key == "gateway" ? [1] : []

    content {
      registry_arn = aws_service_discovery_service.gateway.arn
    }
  }

  depends_on = [
    aws_lb_listener.http,
    aws_lb_listener.https,
  ]
}
