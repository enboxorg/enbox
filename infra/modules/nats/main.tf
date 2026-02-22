################################################################################
# Data sources & locals
################################################################################

data "aws_region" "current" {}

locals {
  # Per-node NATS server command arguments.
  # Single-node: JetStream only. Multi-node: adds cluster routing.
  nats_commands = { for i in range(var.replica_count) : i => concat(
    [
      "-n", "nats-${i}",
      "-js",
      "-sd", "/data",
      "-ms", var.jetstream_max_mem,
      "-fs", var.jetstream_max_file,
      "-p", "4222",
      "-m", "8222",
    ],
    var.replica_count > 1 ? [
      "--cluster_name", "${var.name}-nats",
      "--cluster", "nats://0.0.0.0:6222",
      "--routes", join(",", [
        for j in range(var.replica_count) :
        "nats-route://nats-${j}.${var.cloudmap_namespace_name}:6222"
      ]),
    ] : [],
  ) }
}

################################################################################
# CloudMap — private DNS namespace + per-node service entries
################################################################################

resource "aws_service_discovery_private_dns_namespace" "this" {
  name = var.cloudmap_namespace_name
  vpc  = var.vpc_id

  tags = var.tags
}

resource "aws_service_discovery_service" "nats" {
  count = var.replica_count

  name = "nats-${count.index}"

  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.this.id
    routing_policy = "MULTIVALUE"

    dns_records {
      type = "A"
      ttl  = 10
    }
  }

  health_check_custom_config {}

  tags = var.tags
}

################################################################################
# EFS — encrypted filesystem with per-node access points
################################################################################

resource "aws_efs_file_system" "nats" {
  encrypted        = true
  throughput_mode   = var.efs_throughput_mode
  performance_mode = "generalPurpose"

  tags = merge(var.tags, {
    Name = "${var.name}-nats-data"
  })
}

resource "aws_security_group" "efs" {
  name_prefix = "${var.name}-nats-efs-"
  description = "Allow NFS from NATS tasks"
  vpc_id      = var.vpc_id

  ingress {
    description     = "NFS from NATS"
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [var.nats_security_group_id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, {
    Name = "${var.name}-nats-efs"
  })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_efs_mount_target" "nats" {
  count = length(var.subnet_ids)

  file_system_id  = aws_efs_file_system.nats.id
  subnet_id       = var.subnet_ids[count.index]
  security_groups = [aws_security_group.efs.id]
}

# Each NATS node gets an isolated root directory on the shared filesystem.
# UID/GID 1000 matches the `nats` user in the nats:alpine image.
resource "aws_efs_access_point" "nats" {
  count = var.replica_count

  file_system_id = aws_efs_file_system.nats.id

  posix_user {
    gid = 1000
    uid = 1000
  }

  root_directory {
    path = "/nats-${count.index}"

    creation_info {
      owner_gid   = 1000
      owner_uid   = 1000
      permissions = "0755"
    }
  }

  tags = merge(var.tags, {
    Name = "${var.name}-nats-${count.index}"
  })
}

################################################################################
# IAM — Execution role (image pull, logs) + Task role (EFS access)
################################################################################

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name}-nats-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = var.tags
}

data "aws_iam_policy_document" "execution" {
  # Pull public images (NATS from Docker Hub still needs ECR auth token)
  statement {
    actions = [
      "ecr:GetAuthorizationToken",
    ]
    resources = ["*"]
  }

  # CloudWatch Logs
  statement {
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.nats.arn}:*"]
  }
}

resource "aws_iam_role_policy" "execution" {
  name   = "${var.name}-nats-exec"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution.json
}

resource "aws_iam_role" "task" {
  name               = "${var.name}-nats-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = var.tags
}

data "aws_iam_policy_document" "task_efs" {
  statement {
    actions = [
      "elasticfilesystem:ClientMount",
      "elasticfilesystem:ClientWrite",
    ]
    resources = [aws_efs_file_system.nats.arn]
  }
}

resource "aws_iam_role_policy" "task_efs" {
  name   = "efs-access"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task_efs.json
}

################################################################################
# CloudWatch Log Group
################################################################################

resource "aws_cloudwatch_log_group" "nats" {
  name              = "/ecs/${var.name}-nats"
  retention_in_days = var.log_retention_days

  tags = var.tags
}

################################################################################
# ECS — per-node task definitions and services
################################################################################

resource "aws_ecs_task_definition" "nats" {
  count = var.replica_count

  family                   = "${var.name}-nats-${count.index}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = "nats"
      image     = var.nats_image
      essential = true
      command   = local.nats_commands[count.index]

      portMappings = concat(
        [
          { containerPort = 4222, protocol = "tcp" }, # client
          { containerPort = 8222, protocol = "tcp" }, # monitoring
        ],
        var.replica_count > 1 ? [
          { containerPort = 6222, protocol = "tcp" }, # cluster routing
        ] : [],
      )

      healthCheck = {
        command     = ["CMD-SHELL", "wget -qO- http://localhost:8222/healthz || exit 1"]
        interval    = 15
        timeout     = 5
        retries     = 3
        startPeriod = 15
      }

      mountPoints = [
        {
          sourceVolume  = "nats-data"
          containerPath = "/data"
          readOnly      = false
        },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.nats.name
          "awslogs-region"        = data.aws_region.current.id
          "awslogs-stream-prefix" = "nats-${count.index}"
        }
      }
    },
  ])

  volume {
    name = "nats-data"

    efs_volume_configuration {
      file_system_id          = aws_efs_file_system.nats.id
      transit_encryption      = "ENABLED"

      authorization_config {
        access_point_id = aws_efs_access_point.nats[count.index].id
        iam             = "ENABLED"
      }
    }
  }

  tags = var.tags
}

resource "aws_ecs_service" "nats" {
  count = var.replica_count

  name            = "${var.name}-nats-${count.index}"
  cluster         = var.cluster_arn
  task_definition = aws_ecs_task_definition.nats[count.index].arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [var.nats_security_group_id]
    assign_public_ip = false
  }

  service_registries {
    registry_arn = aws_service_discovery_service.nats[count.index].arn
  }

  # Stateful single-task service: stop old task before starting new one
  # to avoid two tasks writing to the same EFS access point.
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # Ensure EFS mount targets are ready before starting tasks
  depends_on = [aws_efs_mount_target.nats]

  tags = var.tags
}
