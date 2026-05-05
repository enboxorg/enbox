output "alb_dns_name" {
  description = "DNS name of the Application Load Balancer."
  value       = module.alb.alb_dns_name
}

output "aurora_writer_endpoint" {
  description = "Aurora PostgreSQL writer endpoint."
  value       = module.aurora.cluster_endpoint
}

output "aurora_master_secret_arn" {
  description = "Secrets Manager ARN for Aurora master credentials."
  value       = module.aurora.master_secret_arn
}

output "database_url_secret_arn" {
  description = "Secrets Manager ARN for DWN database connection string. Update post-apply with the real password."
  value       = aws_secretsmanager_secret.database_url.arn
}

output "admin_token_secret_arn" {
  description = "Secrets Manager ARN for DWN admin token. Update post-apply with a strong token."
  value       = aws_secretsmanager_secret.admin_token.arn
}

output "nats_url" {
  description = "NATS JetStream connection URL for DWN services."
  value       = module.nats.nats_url
}

output "s3_data_bucket" {
  description = "S3 bucket name for DWN data storage."
  value       = module.s3_data.bucket_name
}

output "dwn_http_log_group" {
  description = "CloudWatch log group for the DWN HTTP service."
  value       = module.dwn_http.log_group_name
}

output "dwn_ws_log_group" {
  description = "CloudWatch log group for the DWN WebSocket service."
  value       = module.dwn_ws.log_group_name
}

output "secret_sync_lambda_name" {
  description = "Name of the Lambda that keeps dwn/dev/database-url in sync with the Aurora master secret."
  value       = module.secret_sync.lambda_function_name
}

output "post_apply_instructions" {
  description = "Steps to complete after first apply."
  value       = <<-EOT
    1. Populate dwn/dev/database-url from the Aurora master secret (idempotent;
       this also rolls the ECS services). Repeated invocations are no-ops.
       aws lambda invoke \
         --function-name ${module.secret_sync.lambda_function_name} \
         --payload '{"source": "drift-check"}' \
         --cli-binary-format raw-in-base64-out \
         /tmp/secret-sync-out.json && cat /tmp/secret-sync-out.json

    2. Set the admin token (one-time):
       aws secretsmanager put-secret-value \
         --secret-id ${aws_secretsmanager_secret.admin_token.id} \
         --secret-string "$(openssl rand -hex 32)"

    3. Set the provider-auth JWT secret (one-time):
       aws secretsmanager put-secret-value \
         --secret-id ${aws_secretsmanager_secret.provider_auth_jwt_secret.id} \
         --secret-string "$(openssl rand -hex 32)"

    Subsequent Aurora rotations are propagated automatically by the secret-sync
    Lambda. To force a rotation for testing:
      aws secretsmanager rotate-secret \
        --secret-id ${module.aurora.master_secret_arn} \
        --rotate-immediately
  EOT
}
