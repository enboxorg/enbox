# ─── State Backend ────────────────────────────────────────────────────────────

output "state_bucket_name" {
  description = "S3 bucket holding Terraform remote state."
  value       = aws_s3_bucket.state.id
}

output "state_bucket_arn" {
  description = "ARN of the Terraform state S3 bucket."
  value       = aws_s3_bucket.state.arn
}

output "lock_table_name" {
  description = "DynamoDB table used for Terraform state locking."
  value       = aws_dynamodb_table.locks.name
}

output "lock_table_arn" {
  description = "ARN of the DynamoDB lock table."
  value       = aws_dynamodb_table.locks.arn
}

# ─── ECR ──────────────────────────────────────────────────────────────────────

output "ecr_dwn_server_url" {
  description = "ECR repository URL for the dwn-server image."
  value       = aws_ecr_repository.dwn_server.repository_url
}

output "ecr_dwn_server_arn" {
  description = "ARN of the dwn-server ECR repository."
  value       = aws_ecr_repository.dwn_server.arn
}

# ─── IAM Roles ────────────────────────────────────────────────────────────────

output "github_actions_terraform_role_arn" {
  description = "IAM role ARN for Terraform CI/CD (plan/apply)."
  value       = aws_iam_role.github_actions_terraform.arn
}

output "github_actions_ecr_role_arn" {
  description = "IAM role ARN for Docker build + ECR push."
  value       = aws_iam_role.github_actions_ecr.arn
}

# ─── OIDC ─────────────────────────────────────────────────────────────────────

output "github_oidc_provider_arn" {
  description = "ARN of the GitHub Actions OIDC identity provider."
  value       = aws_iam_openid_connect_provider.github.arn
}
