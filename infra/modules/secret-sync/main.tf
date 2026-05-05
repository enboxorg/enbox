################################################################################
# Data sources
################################################################################

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

locals {
  function_name = "${var.name}-secret-sync"
  log_group     = "/aws/lambda/${local.function_name}"

  ecs_service_arns = [
    for s in var.ecs_service_names :
    "arn:aws:ecs:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:service/${var.ecs_cluster_name}/${s}"
  ]

  alarm_actions = var.sns_topic_arn != "" ? [var.sns_topic_arn] : []
}

################################################################################
# Lambda package — single-file Python handler
################################################################################

data "archive_file" "lambda" {
  type        = "zip"
  source_file = "${path.module}/lambda/handler.py"
  output_path = "${path.module}/.terraform-build/handler.zip"
}

################################################################################
# CloudWatch Log Group (created explicitly so retention is enforced)
################################################################################

resource "aws_cloudwatch_log_group" "lambda" {
  name              = local.log_group
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

################################################################################
# Dead-letter queue for failed async invocations
################################################################################

resource "aws_sqs_queue" "dlq" {
  name                      = "${local.function_name}-dlq"
  message_retention_seconds = 1209600 # 14 days
  tags                      = var.tags
}

################################################################################
# IAM — Lambda execution role
################################################################################

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${local.function_name}-role"
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = var.tags
}

data "aws_iam_policy_document" "lambda" {
  # CloudWatch Logs
  statement {
    sid    = "Logs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.lambda.arn}:*"]
  }

  # Read the AWS-managed master secret
  statement {
    sid       = "ReadMasterSecret"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = [var.master_secret_arn]
  }

  # Read & write the consumer secret
  statement {
    sid    = "ManageTargetSecret"
    effect = "Allow"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:PutSecretValue",
      "secretsmanager:DescribeSecret",
    ]
    resources = [var.target_secret_arn]
  }

  # Discover the live writer endpoint
  statement {
    sid       = "DescribeCluster"
    effect    = "Allow"
    actions   = ["rds:DescribeDBClusters"]
    resources = [var.rds_cluster_arn]
  }

  # Force ECS redeploy + read service status
  statement {
    sid    = "RollEcsServices"
    effect = "Allow"
    actions = [
      "ecs:UpdateService",
      "ecs:DescribeServices",
    ]
    resources = local.ecs_service_arns
  }

  # CloudWatch metrics — namespace-scoped via condition (PutMetricData has no
  # resource-level support, but we can require a specific namespace)
  statement {
    sid       = "EmitMetrics"
    effect    = "Allow"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["DWN/SecretSync"]
    }
  }

  # Send poison events to the DLQ
  statement {
    sid       = "WriteDlq"
    effect    = "Allow"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.dlq.arn]
  }
}

resource "aws_iam_role_policy" "lambda" {
  name   = "${local.function_name}-policy"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda.json
}

################################################################################
# Lambda function
################################################################################

resource "aws_lambda_function" "this" {
  function_name = local.function_name
  role          = aws_iam_role.lambda.arn

  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256

  runtime     = "python3.12"
  handler     = "handler.lambda_handler"
  timeout     = var.lambda_timeout
  memory_size = var.lambda_memory_mb

  # Serialize executions: rotation events and the drift-check schedule may
  # otherwise overlap.
  reserved_concurrent_executions = 1

  environment {
    variables = {
      ENVIRONMENT       = var.environment
      TARGET_SECRET_ARN = var.target_secret_arn
      MASTER_SECRET_ARN = var.master_secret_arn
      RDS_CLUSTER_ID    = var.rds_cluster_id
      DB_NAME           = var.db_name
      ECS_CLUSTER_NAME  = var.ecs_cluster_name
      ECS_SERVICE_NAMES = join(",", var.ecs_service_names)
    }
  }

  dead_letter_config {
    target_arn = aws_sqs_queue.dlq.arn
  }

  depends_on = [
    aws_iam_role_policy.lambda,
    aws_cloudwatch_log_group.lambda,
  ]

  tags = var.tags
}

################################################################################
# EventBridge — rotation success events from Secrets Manager
################################################################################

resource "aws_cloudwatch_event_rule" "rotation" {
  name        = "${local.function_name}-rotation"
  description = "Fires when AWS rotates the Aurora master secret for ${var.name}."

  event_pattern = jsonencode({
    source      = ["aws.secretsmanager"]
    detail-type = ["AWS Service Event via CloudTrail"]
    detail = {
      eventName = ["RotationSucceeded"]
      additionalEventData = {
        SecretId = [var.master_secret_arn]
      }
    }
  })

  tags = var.tags
}

resource "aws_cloudwatch_event_target" "rotation" {
  rule      = aws_cloudwatch_event_rule.rotation.name
  target_id = "lambda"
  arn       = aws_lambda_function.this.arn
}

resource "aws_lambda_permission" "rotation" {
  statement_id  = "AllowEventBridgeRotation"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.this.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.rotation.arn
}

################################################################################
# EventBridge — periodic drift-check safety net
################################################################################

resource "aws_cloudwatch_event_rule" "drift_check" {
  name                = "${local.function_name}-drift-check"
  description         = "Periodic drift-check for the ${var.name} database-url secret."
  schedule_expression = var.drift_check_schedule
  tags                = var.tags
}

resource "aws_cloudwatch_event_target" "drift_check" {
  rule      = aws_cloudwatch_event_rule.drift_check.name
  target_id = "lambda"
  arn       = aws_lambda_function.this.arn
  input     = jsonencode({ source = "drift-check" })
}

resource "aws_lambda_permission" "drift_check" {
  statement_id  = "AllowEventBridgeDriftCheck"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.this.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.drift_check.arn
}

################################################################################
# CloudWatch alarms
################################################################################

resource "aws_cloudwatch_metric_alarm" "errors" {
  alarm_name          = "${local.function_name}-errors"
  alarm_description   = "Lambda ${local.function_name} errors > 0 over 5 minutes"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.this.function_name
  }

  alarm_actions             = local.alarm_actions
  ok_actions                = local.alarm_actions
  insufficient_data_actions = []

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "dlq_depth" {
  alarm_name          = "${local.function_name}-dlq-depth"
  alarm_description   = "Lambda ${local.function_name} DLQ has unprocessed messages"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.dlq.name
  }

  alarm_actions             = local.alarm_actions
  ok_actions                = local.alarm_actions
  insufficient_data_actions = []

  tags = var.tags
}

# Catches the case where EventBridge silently stops triggering us. The
# drift-check schedule fires 6×/hour, so a full hour of zero invocations is
# a strong signal of a wiring problem (broken rule, IAM, or async retry
# exhaustion) rather than a transient EventBridge hiccup.
resource "aws_cloudwatch_metric_alarm" "stale" {
  alarm_name          = "${local.function_name}-stale"
  alarm_description   = "Lambda ${local.function_name} has not been invoked in 1 hour (EventBridge wiring may be broken; drift-check should fire 6×/hour)"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Invocations"
  namespace           = "AWS/Lambda"
  period              = 3600
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "breaching"

  dimensions = {
    FunctionName = aws_lambda_function.this.function_name
  }

  alarm_actions             = local.alarm_actions
  ok_actions                = local.alarm_actions
  insufficient_data_actions = []

  tags = var.tags
}
