output "service_arn" {
  description = "ARN of the ECS service."
  value       = aws_ecs_service.this.id
}

output "service_name" {
  description = "Name of the ECS service."
  value       = aws_ecs_service.this.name
}

output "task_role_arn" {
  description = "ARN of the IAM task role (attach additional policies for application-level permissions)."
  value       = aws_iam_role.task.arn
}

output "execution_role_arn" {
  description = "ARN of the IAM task execution role."
  value       = aws_iam_role.execution.arn
}

output "log_group_name" {
  description = "Name of the CloudWatch log group."
  value       = aws_cloudwatch_log_group.this.name
}
