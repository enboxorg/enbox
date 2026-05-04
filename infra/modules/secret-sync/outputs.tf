output "lambda_function_name" {
  description = "Name of the secret-sync Lambda function."
  value       = aws_lambda_function.this.function_name
}

output "lambda_arn" {
  description = "ARN of the secret-sync Lambda function."
  value       = aws_lambda_function.this.arn
}

output "lambda_role_arn" {
  description = "ARN of the IAM role assumed by the secret-sync Lambda."
  value       = aws_iam_role.lambda.arn
}

output "log_group_name" {
  description = "CloudWatch log group for the secret-sync Lambda."
  value       = aws_cloudwatch_log_group.lambda.name
}

output "dlq_arn" {
  description = "ARN of the SQS dead-letter queue for failed Lambda async invocations."
  value       = aws_sqs_queue.dlq.arn
}

output "errors_alarm_arn" {
  description = "ARN of the CloudWatch alarm that fires on Lambda errors."
  value       = aws_cloudwatch_metric_alarm.errors.arn
}
