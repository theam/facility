data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "facility" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = local.name_prefix }
}

resource "aws_internet_gateway" "facility" {
  vpc_id = aws_vpc.facility.id
  tags   = { Name = local.name_prefix }
}

resource "aws_subnet" "public" {
  for_each = { for index, az in local.azs : az => index }

  vpc_id                  = aws_vpc.facility.id
  availability_zone       = each.key
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, each.value)
  map_public_ip_on_launch = true

  tags = { Name = "${local.name_prefix}-public-${each.value + 1}" }
}

resource "aws_subnet" "private" {
  for_each = { for index, az in local.azs : az => index }

  vpc_id            = aws_vpc.facility.id
  availability_zone = each.key
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, each.value + 10)

  tags = { Name = "${local.name_prefix}-private-${each.value + 1}" }
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "${local.name_prefix}-nat" }
}

resource "aws_nat_gateway" "facility" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[local.azs[0]].id

  depends_on = [aws_internet_gateway.facility]
  tags       = { Name = local.name_prefix }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.facility.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.facility.id
  }
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.facility.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.facility.id
  }
}

resource "aws_route_table_association" "private" {
  for_each = aws_subnet.private

  subnet_id      = each.value.id
  route_table_id = aws_route_table.private.id
}
