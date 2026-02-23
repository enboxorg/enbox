################################################################################
# Locals
################################################################################

locals {
  name        = "dwn-dev"
  environment = "dev"

  s3_bucket_name = "${local.name}-store-${var.aws_region}"

  tags = {
    Project     = "dwn"
    Environment = local.environment
    ManagedBy   = "terraform"
  }
}

################################################################################
# Secrets Manager — populated post-apply (see outputs for instructions)
################################################################################

resource "aws_secretsmanager_secret" "database_url" {
  name = "dwn/${local.environment}/database-url"
  tags = local.tags
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id     = aws_secretsmanager_secret.database_url.id
  secret_string = "postgres://postgres:CHANGE_ME@${module.aurora.cluster_endpoint}:${module.aurora.port}/dwn"

  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "aws_secretsmanager_secret" "admin_token" {
  name = "dwn/${local.environment}/admin-token"
  tags = local.tags
}

resource "aws_secretsmanager_secret_version" "admin_token" {
  secret_id     = aws_secretsmanager_secret.admin_token.id
  secret_string = "CHANGE_ME"

  lifecycle {
    ignore_changes = [secret_string]
  }
}

################################################################################
# VPC — 2 AZs, single NAT gateway
################################################################################

module "vpc" {
  source = "../../modules/vpc"

  name               = local.name
  azs                = ["${var.aws_region}a", "${var.aws_region}b"]
  public_subnets     = ["10.0.1.0/24", "10.0.2.0/24"]
  private_subnets    = ["10.0.11.0/24", "10.0.12.0/24"]
  data_subnets       = ["10.0.21.0/24", "10.0.22.0/24"]
  single_nat_gateway = true

  tags = local.tags
}

################################################################################
# Aurora PostgreSQL 15 — single writer, db.t4g.medium
################################################################################

module "aurora" {
  source = "../../modules/aurora"

  name               = local.name
  subnet_ids         = module.vpc.data_subnet_ids
  security_group_ids = [module.vpc.sg_aurora_id]
  instance_class     = "db.t4g.medium"

  tags = local.tags
}

################################################################################
# ECS Cluster — Fargate + Fargate Spot
################################################################################

module "ecs_cluster" {
  source = "../../modules/ecs-cluster"

  name = local.name
  tags = local.tags
}

################################################################################
# ALB — internet-facing, HTTPS with WebSocket routing
################################################################################

module "alb" {
  source = "../../modules/alb"

  name               = local.name
  vpc_id             = module.vpc.vpc_id
  subnet_ids         = module.vpc.public_subnet_ids
  security_group_ids = [module.vpc.sg_alb_id]
  certificate_arn    = var.certificate_arn

  tags = local.tags
}

################################################################################
# S3 — DWN data storage with intelligent tiering
################################################################################

module "s3_data" {
  source = "../../modules/s3-data"

  name              = local.s3_bucket_name
  allowed_role_arns = [module.dwn_http.task_role_arn, module.dwn_ws.task_role_arn]
  admin_arns        = ["arn:aws:iam::387235730938:user/enbox-admin", "arn:aws:iam::387235730938:role/github-actions-terraform"]

  tags = local.tags
}

################################################################################
# NATS JetStream — single node for dev
################################################################################

module "nats" {
  source = "../../modules/nats"

  name                   = local.name
  cluster_arn            = module.ecs_cluster.cluster_arn
  vpc_id                 = module.vpc.vpc_id
  subnet_ids             = module.vpc.private_subnet_ids
  nats_security_group_id = module.vpc.sg_nats_id
  cpu                    = 256
  memory                 = 512
  replica_count          = 1
  log_retention_days     = 7

  tags = local.tags
}

################################################################################
# ECS Service — DWN HTTP (API + Records)
################################################################################

module "dwn_http" {
  source = "../../modules/ecs-service"

  name               = "${local.name}-http"
  cluster_arn        = module.ecs_cluster.cluster_arn
  subnet_ids         = module.vpc.private_subnet_ids
  security_group_ids = [module.vpc.sg_dwn_id]
  image              = var.dwn_image
  container_port     = 3000
  cpu                = 512
  memory             = 1024
  desired_count      = 1
  target_group_arn   = module.alb.http_target_group_arn
  autoscaling_min    = 1
  autoscaling_max    = 2
  log_retention_days = 7

  environment = {
    DS_PORT                   = "3000"
    DS_WEBSOCKET_SERVER       = "false"
    DWN_SERVER_LOG_LEVEL      = "INFO"
    DWN_S3_DATA_BUCKET        = local.s3_bucket_name
    MAX_RECORD_DATA_SIZE      = "1gb"
    NATS_URL                  = module.nats.nats_url
    DWN_EVENT_LOG_PLUGIN_PATH = "/app/packages/dwn-server/dist/esm/src/plugins/event-log-nats.js"
  }

  secrets = {
    DWN_STORAGE                = aws_secretsmanager_secret.database_url.arn
    DWN_TTL_CACHE_URL          = aws_secretsmanager_secret.database_url.arn
    DWN_REGISTRATION_STORE_URL = aws_secretsmanager_secret.database_url.arn
    DWN_ADMIN_TOKEN            = aws_secretsmanager_secret.admin_token.arn
  }

  tags = local.tags
}

################################################################################
# ECS Service — DWN WebSocket
################################################################################

module "dwn_ws" {
  source = "../../modules/ecs-service"

  name               = "${local.name}-ws"
  cluster_arn        = module.ecs_cluster.cluster_arn
  subnet_ids         = module.vpc.private_subnet_ids
  security_group_ids = [module.vpc.sg_dwn_id]
  image              = var.dwn_image
  container_port     = 3000
  cpu                = 512
  memory             = 1024
  desired_count      = 1
  target_group_arn   = module.alb.ws_target_group_arn
  autoscaling_min    = 1
  autoscaling_max    = 2
  log_retention_days = 7

  environment = {
    DS_PORT                   = "3000"
    DS_WEBSOCKET_SERVER       = "true"
    DWN_SERVER_LOG_LEVEL      = "INFO"
    DWN_MAX_IN_FLIGHT         = "64"
    NATS_URL                  = module.nats.nats_url
    DWN_EVENT_LOG_PLUGIN_PATH = "/app/packages/dwn-server/dist/esm/src/plugins/event-log-nats.js"
  }

  secrets = {
    DWN_STORAGE                = aws_secretsmanager_secret.database_url.arn
    DWN_TTL_CACHE_URL          = aws_secretsmanager_secret.database_url.arn
    DWN_REGISTRATION_STORE_URL = aws_secretsmanager_secret.database_url.arn
    DWN_ADMIN_TOKEN            = aws_secretsmanager_secret.admin_token.arn
  }

  tags = local.tags
}

################################################################################
# IAM — S3 data access for DWN task roles
################################################################################

resource "aws_iam_role_policy" "dwn_http_s3" {
  name = "s3-data-access"
  role = split("/", module.dwn_http.task_role_arn)[1]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = "${module.s3_data.bucket_arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = module.s3_data.bucket_arn
      },
    ]
  })
}

resource "aws_iam_role_policy" "dwn_ws_s3" {
  name = "s3-data-access"
  role = split("/", module.dwn_ws.task_role_arn)[1]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = "${module.s3_data.bucket_arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = module.s3_data.bucket_arn
      },
    ]
  })
}

################################################################################
# Monitoring — CloudWatch alarms for primary service
################################################################################

module "monitoring" {
  source = "../../modules/monitoring"

  name              = local.name
  cluster_name      = module.ecs_cluster.cluster_name
  service_name      = module.dwn_http.service_name
  alb_arn_suffix    = module.alb.alb_arn_suffix
  aurora_cluster_id = local.name

  tags = local.tags
}
