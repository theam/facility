resource "aws_lb" "facility" {
  name                       = substr(local.name_prefix, 0, 32)
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = [for subnet in aws_subnet.public : subnet.id]
  enable_deletion_protection = var.enable_deletion_protection
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "service" {
  for_each = {
    api = { port = 4400, health = "/readyz" }
    web = { port = 3400, health = "/" }
  }

  name        = substr("${local.name_prefix}-${each.key}", 0, 32)
  port        = each.value.port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.facility.id

  health_check {
    enabled             = true
    path                = each.value.health
    matcher             = "200-399"
    interval            = 30
    timeout             = 10
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.facility.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.facility.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.acm_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service["web"].arn
  }
}

resource "aws_lb_listener_rule" "preview" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 1

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service["api"].arn
  }

  condition {
    host_header { values = [var.preview_hostname] }
  }
}

resource "aws_lb_listener_rule" "control_api_primary" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service["api"].arn
  }

  condition {
    host_header { values = [var.app_hostname] }
  }

  condition {
    path_pattern { values = ["/v1/*", "/mcp", "/mcp/*", "/webhooks/*", "/health"] }
  }
}

resource "aws_lb_listener_rule" "control_api_secondary" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 11

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service["api"].arn
  }

  condition {
    host_header { values = [var.app_hostname] }
  }

  condition {
    path_pattern { values = ["/readyz", "/auth/*", "/oauth/*", "/.well-known/*"] }
  }
}

resource "aws_route53_record" "app" {
  count = var.route53_zone_id == "" ? 0 : 1

  zone_id = var.route53_zone_id
  name    = var.app_hostname
  type    = "A"

  alias {
    name                   = aws_lb.facility.dns_name
    zone_id                = aws_lb.facility.zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "preview" {
  count = var.preview_route53_zone_id == "" ? 0 : 1

  zone_id = var.preview_route53_zone_id
  name    = var.preview_hostname
  type    = "A"

  alias {
    name                   = aws_lb.facility.dns_name
    zone_id                = aws_lb.facility.zone_id
    evaluate_target_health = true
  }
}
