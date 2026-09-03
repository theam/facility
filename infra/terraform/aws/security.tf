resource "aws_security_group" "alb" {
  name        = "${local.name_prefix}-alb"
  description = "Public HTTPS entrypoint"
  vpc_id      = aws_vpc.facility.id
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  for_each = toset(var.allowed_http_cidr_blocks)

  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = each.value
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  for_each = toset(var.allowed_http_cidr_blocks)

  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = each.value
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_security_group" "service" {
  name        = "${local.name_prefix}-service"
  description = "Facility ECS tasks"
  vpc_id      = aws_vpc.facility.id
}

resource "aws_vpc_security_group_ingress_rule" "service_from_alb" {
  for_each = toset(["3400", "4400"])

  security_group_id            = aws_security_group.service.id
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = tonumber(each.value)
  to_port                      = tonumber(each.value)
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "api_from_service" {
  security_group_id            = aws_security_group.service.id
  referenced_security_group_id = aws_security_group.service.id
  from_port                    = 4400
  to_port                      = 4400
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_services" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.service.id
  ip_protocol                  = "-1"
}

resource "aws_vpc_security_group_egress_rule" "service_outbound" {
  security_group_id = aws_security_group.service.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_security_group" "database" {
  name        = "${local.name_prefix}-database"
  description = "PostgreSQL from Facility ECS only"
  vpc_id      = aws_vpc.facility.id
}

resource "aws_vpc_security_group_ingress_rule" "database_from_service" {
  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = aws_security_group.service.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "database_outbound" {
  security_group_id = aws_security_group.database.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}
