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

output "post_apply_instructions" {
  description = "Steps to complete after first apply."
  value       = <<-EOT
    1. Get the Aurora master password:
       aws secretsmanager get-secret-value --secret-id ${module.aurora.master_secret_arn} \
         --query SecretString --output text | jq -r .password

    2. Update the database URL secret with the real password:
       aws secretsmanager put-secret-value \
         --secret-id ${aws_secretsmanager_secret.database_url.id} \
         --secret-string "postgres://postgres:REAL_PASSWORD@${module.aurora.cluster_endpoint}:${module.aurora.port}/dwn"

    3. Update the admin token secret:
       aws secretsmanager put-secret-value \
         --secret-id ${aws_secretsmanager_secret.admin_token.id} \
         --secret-string "$(openssl rand -hex 32)"

    4. Force new ECS deployments to pick up the updated secrets:
       aws ecs update-service --cluster ${module.ecs_cluster.cluster_name} --service ${module.dwn_http.service_name} --force-new-deployment
       aws ecs update-service --cluster ${module.ecs_cluster.cluster_name} --service ${module.dwn_ws.service_name} --force-new-deployment
  EOT
}
