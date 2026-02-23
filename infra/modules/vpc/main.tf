# ─── VPC ──────────────────────────────────────────────────────────────────────

resource "aws_vpc" "this" {
  cidr_block           = var.cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(var.tags, { Name = var.name })
}

# ─── Subnets ──────────────────────────────────────────────────────────────────

resource "aws_subnet" "public" {
  count                   = length(var.public_subnets)
  vpc_id                  = aws_vpc.this.id
  cidr_block              = var.public_subnets[count.index]
  availability_zone       = var.azs[count.index]
  map_public_ip_on_launch = true

  tags = merge(var.tags, {
    Name = "${var.name}-public-${var.azs[count.index]}"
    Tier = "public"
  })
}

resource "aws_subnet" "private" {
  count             = length(var.private_subnets)
  vpc_id            = aws_vpc.this.id
  cidr_block        = var.private_subnets[count.index]
  availability_zone = var.azs[count.index]

  tags = merge(var.tags, {
    Name = "${var.name}-private-${var.azs[count.index]}"
    Tier = "compute"
  })
}

resource "aws_subnet" "data" {
  count             = length(var.data_subnets)
  vpc_id            = aws_vpc.this.id
  cidr_block        = var.data_subnets[count.index]
  availability_zone = var.azs[count.index]

  tags = merge(var.tags, {
    Name = "${var.name}-data-${var.azs[count.index]}"
    Tier = "data"
  })
}

# ─── Internet Gateway ────────────────────────────────────────────────────────

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name}-igw" })
}

# ─── NAT Gateway ─────────────────────────────────────────────────────────────

locals {
  nat_count = var.single_nat_gateway ? 1 : length(var.public_subnets)
}

resource "aws_eip" "nat" {
  count  = local.nat_count
  domain = "vpc"
  tags   = merge(var.tags, { Name = "${var.name}-nat-eip-${count.index}" })
}

resource "aws_nat_gateway" "this" {
  count         = local.nat_count
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  tags = merge(var.tags, { Name = "${var.name}-nat-${count.index}" })

  depends_on = [aws_internet_gateway.this]
}

# ─── Route Tables ─────────────────────────────────────────────────────────────

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name}-public-rt" })
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count          = length(var.public_subnets)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  count  = local.nat_count
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name}-private-rt-${count.index}" })
}

resource "aws_route" "private_nat" {
  count                  = local.nat_count
  route_table_id         = aws_route_table.private[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[count.index].id
}

resource "aws_route_table_association" "private" {
  count          = length(var.private_subnets)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[var.single_nat_gateway ? 0 : count.index].id
}

resource "aws_route_table_association" "data" {
  count          = length(var.data_subnets)
  subnet_id      = aws_subnet.data[count.index].id
  route_table_id = aws_route_table.private[var.single_nat_gateway ? 0 : count.index].id
}

# ─── Security Groups ─────────────────────────────────────────────────────────

resource "aws_security_group" "alb" {
  name_prefix = "${var.name}-alb-"
  description = "ALB - inbound HTTPS from internet"
  vpc_id      = aws_vpc.this.id

  tags = merge(var.tags, { Name = "${var.name}-sg-alb" })

  lifecycle { create_before_destroy = true }
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from internet"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP from internet (redirect to HTTPS)"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "alb_all" {
  security_group_id = aws_security_group.alb.id
  description       = "All outbound"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_security_group" "dwn" {
  name_prefix = "${var.name}-dwn-"
  description = "DWN ECS tasks - inbound from ALB on port 3000"
  vpc_id      = aws_vpc.this.id

  tags = merge(var.tags, { Name = "${var.name}-sg-dwn" })

  lifecycle { create_before_destroy = true }
}

resource "aws_vpc_security_group_ingress_rule" "dwn_from_alb" {
  security_group_id            = aws_security_group.dwn.id
  description                  = "DWN HTTP from ALB"
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  referenced_security_group_id = aws_security_group.alb.id
}

resource "aws_vpc_security_group_egress_rule" "dwn_all" {
  security_group_id = aws_security_group.dwn.id
  description       = "All outbound"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_security_group" "nats" {
  name_prefix = "${var.name}-nats-"
  description = "NATS JetStream - inbound from DWN tasks and self (cluster routing)"
  vpc_id      = aws_vpc.this.id

  tags = merge(var.tags, { Name = "${var.name}-sg-nats" })

  lifecycle { create_before_destroy = true }
}

resource "aws_vpc_security_group_ingress_rule" "nats_client" {
  security_group_id            = aws_security_group.nats.id
  description                  = "NATS client from DWN"
  ip_protocol                  = "tcp"
  from_port                    = 4222
  to_port                      = 4222
  referenced_security_group_id = aws_security_group.dwn.id
}

resource "aws_vpc_security_group_ingress_rule" "nats_cluster" {
  security_group_id            = aws_security_group.nats.id
  description                  = "NATS cluster routing (self)"
  ip_protocol                  = "tcp"
  from_port                    = 6222
  to_port                      = 6222
  referenced_security_group_id = aws_security_group.nats.id
}

resource "aws_vpc_security_group_egress_rule" "nats_all" {
  security_group_id = aws_security_group.nats.id
  description       = "All outbound"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_security_group" "aurora" {
  name_prefix = "${var.name}-aurora-"
  description = "Aurora PostgreSQL - inbound 5432 from DWN tasks"
  vpc_id      = aws_vpc.this.id

  tags = merge(var.tags, { Name = "${var.name}-sg-aurora" })

  lifecycle { create_before_destroy = true }
}

resource "aws_vpc_security_group_ingress_rule" "aurora_from_dwn" {
  security_group_id            = aws_security_group.aurora.id
  description                  = "PostgreSQL from DWN"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.dwn.id
}

resource "aws_vpc_security_group_egress_rule" "aurora_all" {
  security_group_id = aws_security_group.aurora.id
  description       = "All outbound"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# ─── VPC Endpoints ────────────────────────────────────────────────────────────

resource "aws_security_group" "vpc_endpoints" {
  count       = var.enable_vpc_endpoints ? 1 : 0
  name_prefix = "${var.name}-vpce-"
  description = "VPC interface endpoints - HTTPS from private subnets"
  vpc_id      = aws_vpc.this.id

  tags = merge(var.tags, { Name = "${var.name}-sg-vpce" })

  lifecycle { create_before_destroy = true }
}

resource "aws_vpc_security_group_ingress_rule" "vpce_https" {
  count             = var.enable_vpc_endpoints ? 1 : 0
  security_group_id = aws_security_group.vpc_endpoints[0].id
  description       = "HTTPS from VPC"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = var.cidr
}

resource "aws_vpc_security_group_egress_rule" "vpce_all" {
  count             = var.enable_vpc_endpoints ? 1 : 0
  security_group_id = aws_security_group.vpc_endpoints[0].id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# S3 Gateway endpoint (free, no interface needed)
resource "aws_vpc_endpoint" "s3" {
  count             = var.enable_vpc_endpoints ? 1 : 0
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${var.azs[0] == "" ? "us-east-1" : regex("^[a-z]+-[a-z]+-[0-9]+", var.azs[0])}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = aws_route_table.private[*].id

  tags = merge(var.tags, { Name = "${var.name}-vpce-s3" })
}

# Interface endpoints
locals {
  interface_endpoints = var.enable_vpc_endpoints ? toset([
    "ecr.api",
    "ecr.dkr",
    "logs",
    "secretsmanager",
    "kms",
  ]) : toset([])

  region = regex("^[a-z]+-[a-z]+-[0-9]+", var.azs[0])
}

resource "aws_vpc_endpoint" "interface" {
  for_each = local.interface_endpoints

  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${local.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.vpc_endpoints[0].id]

  tags = merge(var.tags, { Name = "${var.name}-vpce-${each.key}" })
}
