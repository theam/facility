resource "aws_lb" "public" {
  name               = "${local.name_prefix}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = [for subnet in aws_subnet.public : subnet.id]

  enable_deletion_protection = var.enable_deletion_protection

  tags = {
    Name = "${local.name_prefix}-alb"
  }
}

resource "aws_lb_target_group" "service" {
  for_each = {
    api = {
      port        = local.ports.api
      health_path = "/health"
    }
    web = {
      port        = local.ports.web
      health_path = "/"
    }
    mcp = {
      port        = local.ports.mcp
      health_path = "/readyz"
    }
  }

  name        = "${local.name_prefix}-${each.key}"
  port        = each.value.port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.facility.id

  deregistration_delay = var.target_deregistration_delay_seconds

  health_check {
    enabled             = true
    path                = each.value.health_path
    matcher             = "200-399"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.public.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = var.acm_certificate_arn == "" ? (var.enable_cloudfront_api_endpoint ? "forward" : "fixed-response") : "redirect"
    target_group_arn = var.acm_certificate_arn == "" && var.enable_cloudfront_api_endpoint ? aws_lb_target_group.service["api"].arn : null

    dynamic "fixed_response" {
      for_each = var.acm_certificate_arn == "" && !var.enable_cloudfront_api_endpoint ? [1] : []

      content {
        content_type = "text/plain"
        message_body = "Facility hostname not configured"
        status_code  = "404"
      }
    }

    dynamic "redirect" {
      for_each = var.acm_certificate_arn == "" ? [] : [1]

      content {
        host        = "#{host}"
        path        = "/#{path}"
        port        = "443"
        protocol    = "HTTPS"
        query       = "#{query}"
        status_code = "HTTP_301"
      }
    }
  }
}

resource "aws_lb_listener" "https" {
  count = var.acm_certificate_arn == "" ? 0 : 1

  load_balancer_arn = aws_lb.public.arn
  port              = 443
  protocol          = "HTTPS"
  certificate_arn   = var.acm_certificate_arn
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"

  default_action {
    type = "fixed-response"

    fixed_response {
      content_type = "text/plain"
      message_body = "Facility hostname not configured"
      status_code  = "404"
    }
  }
}

moved {
  from = aws_lb_listener_rule.http_api
  to   = aws_lb_listener_rule.http_api[0]
}

moved {
  from = aws_lb_listener_rule.http_web
  to   = aws_lb_listener_rule.http_web[0]
}

moved {
  from = aws_lb_listener_rule.http_mcp
  to   = aws_lb_listener_rule.http_mcp[0]
}

moved {
  from = aws_lb_listener_rule.http_preview
  to   = aws_lb_listener_rule.http_preview[0]
}

resource "aws_lb_listener_rule" "http_api" {
  count = var.acm_certificate_arn == "" ? 1 : 0

  listener_arn = aws_lb_listener.http.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service["api"].arn
  }

  condition {
    host_header {
      values = [var.api_hostname]
    }
  }
}

resource "aws_lb_listener_rule" "http_web" {
  count = var.acm_certificate_arn == "" ? 1 : 0

  listener_arn = aws_lb_listener.http.arn
  priority     = 20

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service["web"].arn
  }

  condition {
    host_header {
      values = [var.app_hostname]
    }
  }
}

resource "aws_lb_listener_rule" "http_mcp" {
  count        = var.acm_certificate_arn == "" ? 1 : 0
  listener_arn = aws_lb_listener.http.arn
  priority     = 30
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service["mcp"].arn
  }
  condition {
    host_header { values = [var.mcp_hostname] }
  }
}

resource "aws_lb_listener_rule" "http_preview" {
  count        = var.acm_certificate_arn == "" ? 1 : 0
  listener_arn = aws_lb_listener.http.arn
  priority     = 40
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service["api"].arn
  }
  condition {
    host_header { values = [var.preview_hostname] }
  }
}

resource "aws_lb_listener_rule" "https_api" {
  count = var.acm_certificate_arn == "" ? 0 : 1

  listener_arn = aws_lb_listener.https[0].arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service["api"].arn
  }

  condition {
    host_header {
      values = [var.api_hostname]
    }
  }
}

resource "aws_lb_listener_rule" "https_web" {
  count = var.acm_certificate_arn == "" ? 0 : 1

  listener_arn = aws_lb_listener.https[0].arn
  priority     = 20

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service["web"].arn
  }

  condition {
    host_header {
      values = [var.app_hostname]
    }
  }
}

resource "aws_lb_listener_rule" "https_mcp" {
  count        = var.acm_certificate_arn == "" ? 0 : 1
  listener_arn = aws_lb_listener.https[0].arn
  priority     = 30
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service["mcp"].arn
  }
  condition {
    host_header { values = [var.mcp_hostname] }
  }
}

resource "aws_lb_listener_rule" "https_preview" {
  count        = var.acm_certificate_arn == "" ? 0 : 1
  listener_arn = aws_lb_listener.https[0].arn
  priority     = 40
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service["api"].arn
  }
  condition {
    host_header { values = [var.preview_hostname] }
  }
}

resource "aws_route53_record" "app" {
  count = var.route53_zone_id == "" ? 0 : 1

  zone_id = var.route53_zone_id
  name    = var.app_hostname
  type    = "A"

  alias {
    name                   = aws_lb.public.dns_name
    zone_id                = aws_lb.public.zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "api" {
  count = var.route53_zone_id == "" ? 0 : 1

  zone_id = var.route53_zone_id
  name    = var.api_hostname
  type    = "A"

  alias {
    name                   = aws_lb.public.dns_name
    zone_id                = aws_lb.public.zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "mcp" {
  count   = var.route53_zone_id == "" ? 0 : 1
  zone_id = var.route53_zone_id
  name    = var.mcp_hostname
  type    = "A"
  alias {
    name                   = aws_lb.public.dns_name
    zone_id                = aws_lb.public.zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "preview" {
  count   = var.preview_route53_zone_id == "" ? 0 : 1
  zone_id = var.preview_route53_zone_id
  name    = var.preview_hostname
  type    = "A"
  alias {
    name                   = aws_lb.public.dns_name
    zone_id                = aws_lb.public.zone_id
    evaluate_target_health = true
  }
}
