output "cluster_endpoint" {
  description = "Writer endpoint of the Aurora cluster."
  value       = aws_rds_cluster.this.endpoint
}

output "reader_endpoint" {
  description = "Reader endpoint of the Aurora cluster."
  value       = aws_rds_cluster.this.reader_endpoint
}

output "port" {
  description = "Port the Aurora cluster listens on."
  value       = aws_rds_cluster.this.port
}

output "security_group_id" {
  description = "First security group ID attached to the cluster (pass-through)."
  value       = var.security_group_ids[0]
}

output "master_secret_arn" {
  description = "ARN of the Secrets Manager secret containing master credentials."
  value       = aws_rds_cluster.this.master_user_secret[0].secret_arn
}
