output "alarm_arns" {
  description = "Map of alarm name to ARN for all CloudWatch alarms."
  value = {
    aurora_cpu  = aws_cloudwatch_metric_alarm.aurora_cpu.arn
    ecs_cpu     = aws_cloudwatch_metric_alarm.ecs_cpu.arn
    ecs_memory  = aws_cloudwatch_metric_alarm.ecs_memory.arn
    alb_5xx     = aws_cloudwatch_metric_alarm.alb_5xx.arn
    alb_latency = aws_cloudwatch_metric_alarm.alb_latency.arn
  }
}
