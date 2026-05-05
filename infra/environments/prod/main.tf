################################################################################
# Locals
################################################################################

locals {
  name        = "dwn-prod"
  environment = "prod"

  s3_bucket_name = "${local.name}-data-${var.aws_region}"

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
# VPC — 3 AZs, per-AZ NAT gateways (HA)
################################################################################

module "vpc" {
  source = "../../modules/vpc"

  name               = local.name
  azs                = ["${var.aws_region}a", "${var.aws_region}b", "${var.aws_region}c"]
  public_subnets     = ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"]
  private_subnets    = ["10.0.11.0/24", "10.0.12.0/24", "10.0.13.0/24"]
  data_subnets       = ["10.0.21.0/24", "10.0.22.0/24", "10.0.23.0/24"]
  single_nat_gateway = false

  tags = local.tags
}

################################################################################
# Aurora PostgreSQL 15 — db.r6g.xlarge writer
################################################################################

module "aurora" {
  source = "../../modules/aurora"

  name               = local.name
  subnet_ids         = module.vpc.data_subnet_ids
  security_group_ids = [module.vpc.sg_aurora_id]
  instance_class     = "db.r6g.xlarge"

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
# NATS JetStream — 3-node cluster for prod
################################################################################

module "nats" {
  source = "../../modules/nats"

  name                   = local.name
  cluster_arn            = module.ecs_cluster.cluster_arn
  vpc_id                 = module.vpc.vpc_id
  subnet_ids             = module.vpc.private_subnet_ids
  nats_security_group_id = module.vpc.sg_nats_id
  cpu                    = 1024
  memory                 = 2048
  replica_count          = 3
  efs_throughput_mode    = "elastic"
  log_retention_days     = 30

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
  cpu                = 1024
  memory             = 2048
  desired_count      = 2
  target_group_arn   = module.alb.http_target_group_arn
  autoscaling_min    = 2
  autoscaling_max    = 20
  log_retention_days = 30

  environment = {
    DS_PORT                   = "3000"
    DS_WEBSOCKET_SERVER       = "false"
    DWN_SERVER_LOG_LEVEL      = "INFO"
    DWN_S3_DATA_BUCKET        = local.s3_bucket_name
    MAX_RECORD_DATA_SIZE      = "1gb"
    NATS_URL                  = module.nats.nats_url
    DWN_EVENT_LOG_PLUGIN_PATH = "/app/dist/esm/src/plugins/event-log-nats.js"
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
  cpu                = 1024
  memory             = 2048
  desired_count      = 2
  target_group_arn   = module.alb.ws_target_group_arn
  autoscaling_min    = 2
  autoscaling_max    = 10
  log_retention_days = 30

  environment = {
    DS_PORT                   = "3000"
    DS_WEBSOCKET_SERVER       = "true"
    DWN_SERVER_LOG_LEVEL      = "INFO"
    DWN_MAX_IN_FLIGHT         = "64"
    NATS_URL                  = module.nats.nats_url
    DWN_EVENT_LOG_PLUGIN_PATH = "/app/dist/esm/src/plugins/event-log-nats.js"
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
# Secret Sync — keep dwn/<env>/database-url in sync with the Aurora master
# secret rotated by AWS, and roll ECS services so they pick up the new value.
################################################################################

module "secret_sync" {
  source = "../../modules/secret-sync"

  name              = local.name
  environment       = local.environment
  target_secret_arn = aws_secretsmanager_secret.database_url.arn
  master_secret_arn = module.aurora.master_secret_arn
  rds_cluster_id    = module.aurora.cluster_id
  rds_cluster_arn   = module.aurora.cluster_arn
  db_name           = "dwn"
  ecs_cluster_name  = module.ecs_cluster.cluster_name
  ecs_cluster_arn   = module.ecs_cluster.cluster_arn
  ecs_service_names = [module.dwn_http.service_name, module.dwn_ws.service_name]
  sns_topic_arn     = var.sns_topic_arn

  tags = local.tags
}

################################################################################
# Monitoring — CloudWatch alarms with SNS notifications
################################################################################

module "monitoring" {
  source = "../../modules/monitoring"

  name              = local.name
  cluster_name      = module.ecs_cluster.cluster_name
  service_name      = module.dwn_http.service_name
  alb_arn_suffix    = module.alb.alb_arn_suffix
  aurora_cluster_id = local.name
  sns_topic_arn     = var.sns_topic_arn

  tags = local.tags
}
