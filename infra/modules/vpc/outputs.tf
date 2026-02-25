output "vpc_id" {
  description = "ID of the VPC."
  value       = aws_vpc.this.id
}

output "vpc_cidr" {
  description = "CIDR block of the VPC."
  value       = aws_vpc.this.cidr_block
}

output "public_subnet_ids" {
  description = "IDs of the public subnets."
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "IDs of the private compute subnets."
  value       = aws_subnet.private[*].id
}

output "data_subnet_ids" {
  description = "IDs of the private data subnets."
  value       = aws_subnet.data[*].id
}

output "sg_alb_id" {
  description = "Security group ID for the ALB."
  value       = aws_security_group.alb.id
}

output "sg_dwn_id" {
  description = "Security group ID for DWN ECS tasks."
  value       = aws_security_group.dwn.id
}

output "sg_nats_id" {
  description = "Security group ID for NATS."
  value       = aws_security_group.nats.id
}

output "sg_aurora_id" {
  description = "Security group ID for Aurora."
  value       = aws_security_group.aurora.id
}
