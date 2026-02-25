output "nats_url" {
  description = "NATS client connection URL(s) for DWN services."
  value       = join(",", [for i in range(var.replica_count) : "nats://nats-${i}.${var.cloudmap_namespace_name}:4222"])
}

output "efs_filesystem_id" {
  description = "EFS filesystem ID used for JetStream persistent storage."
  value       = aws_efs_file_system.nats.id
}

output "efs_filesystem_arn" {
  description = "EFS filesystem ARN."
  value       = aws_efs_file_system.nats.arn
}

output "service_arns" {
  description = "ARNs of the NATS ECS services."
  value       = aws_ecs_service.nats[*].id
}

output "task_definition_arns" {
  description = "ARNs of the NATS ECS task definitions."
  value       = aws_ecs_task_definition.nats[*].arn
}

output "cloudmap_namespace_id" {
  description = "CloudMap private DNS namespace ID (for reuse by other modules)."
  value       = aws_service_discovery_private_dns_namespace.this.id
}

output "cloudmap_service_arns" {
  description = "ARNs of the per-node CloudMap service discovery entries."
  value       = aws_service_discovery_service.nats[*].arn
}

output "efs_security_group_id" {
  description = "Security group ID for the EFS filesystem (NFS access)."
  value       = aws_security_group.efs.id
}
