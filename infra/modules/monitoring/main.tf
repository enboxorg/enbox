locals {
  alarm_actions = var.sns_topic_arn != "" ? [var.sns_topic_arn] : []
}

################################################################################
# Aurora CPU Utilization
################################################################################

resource "aws_cloudwatch_metric_alarm" "aurora_cpu" {
  alarm_name          = "${var.name}-aurora-cpu-high"
  alarm_description   = "Aurora cluster ${var.aurora_cluster_id} CPU utilization > ${var.aurora_cpu_threshold}%"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = var.aurora_cpu_threshold
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBClusterIdentifier = var.aurora_cluster_id
  }

  alarm_actions             = local.alarm_actions
  ok_actions                = local.alarm_actions
  insufficient_data_actions = []

  tags = var.tags
}

################################################################################
# ECS Service CPU Utilization
################################################################################

resource "aws_cloudwatch_metric_alarm" "ecs_cpu" {
  alarm_name          = "${var.name}-ecs-cpu-high"
  alarm_description   = "ECS service ${var.service_name} CPU utilization > ${var.cpu_threshold}%"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ECS"
  period              = 300
  statistic           = "Average"
  threshold           = var.cpu_threshold
  treat_missing_data  = "notBreaching"

  dimensions = {
    ClusterName = var.cluster_name
    ServiceName = var.service_name
  }

  alarm_actions             = local.alarm_actions
  ok_actions                = local.alarm_actions
  insufficient_data_actions = []

  tags = var.tags
}

################################################################################
# ECS Service Memory Utilization
################################################################################

resource "aws_cloudwatch_metric_alarm" "ecs_memory" {
  alarm_name          = "${var.name}-ecs-memory-high"
  alarm_description   = "ECS service ${var.service_name} memory utilization > ${var.memory_threshold}%"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "MemoryUtilization"
  namespace           = "AWS/ECS"
  period              = 300
  statistic           = "Average"
  threshold           = var.memory_threshold
  treat_missing_data  = "notBreaching"

  dimensions = {
    ClusterName = var.cluster_name
    ServiceName = var.service_name
  }

  alarm_actions             = local.alarm_actions
  ok_actions                = local.alarm_actions
  insufficient_data_actions = []

  tags = var.tags
}

################################################################################
# ALB 5xx Errors
################################################################################

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${var.name}-alb-5xx-high"
  alarm_description   = "ALB 5xx error count > ${var.alb_5xx_threshold}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HTTPCode_ELB_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 300
  statistic           = "Sum"
  threshold           = var.alb_5xx_threshold
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = var.alb_arn_suffix
  }

  alarm_actions             = local.alarm_actions
  ok_actions                = local.alarm_actions
  insufficient_data_actions = []

  tags = var.tags
}

################################################################################
# ALB Target Response Time P95
################################################################################

resource "aws_cloudwatch_metric_alarm" "alb_latency" {
  alarm_name          = "${var.name}-alb-latency-high"
  alarm_description   = "ALB target response time P95 > ${var.alb_latency_threshold}s"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  threshold           = var.alb_latency_threshold
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "latency_p95"
    return_data = true

    metric {
      metric_name = "TargetResponseTime"
      namespace   = "AWS/ApplicationELB"
      period      = 300
      stat        = "p95"

      dimensions = {
        LoadBalancer = var.alb_arn_suffix
      }
    }
  }

  alarm_actions             = local.alarm_actions
  ok_actions                = local.alarm_actions
  insufficient_data_actions = []

  tags = var.tags
}
