variable "name" {
  description = "Name prefix for all NATS resources."
  type        = string
}

variable "cluster_arn" {
  description = "ARN of the ECS cluster to deploy NATS into."
  type        = string
}

variable "vpc_id" {
  description = "VPC ID for CloudMap namespace and EFS security group."
  type        = string
}

variable "subnet_ids" {
  description = "Subnet IDs for ECS tasks and EFS mount targets."
  type        = list(string)
}

variable "nats_security_group_id" {
  description = "Security group ID for NATS tasks (inbound 4222, 6222)."
  type        = string
}

variable "nats_image" {
  description = "NATS container image."
  type        = string
  default     = "nats:2.10-alpine"
}

variable "cpu" {
  description = "CPU units for each NATS task (256 = 0.25 vCPU)."
  type        = number
  default     = 512
}

variable "memory" {
  description = "Memory in MiB for each NATS task."
  type        = number
  default     = 1024
}

variable "replica_count" {
  description = "Number of NATS nodes (1 for dev, 3 for prod)."
  type        = number
  default     = 1

  validation {
    condition     = var.replica_count >= 1 && var.replica_count <= 5
    error_message = "replica_count must be between 1 and 5."
  }
}

variable "jetstream_max_mem" {
  description = "JetStream max in-memory storage per node (e.g. 256MB)."
  type        = string
  default     = "256MB"
}

variable "jetstream_max_file" {
  description = "JetStream max file storage per node (e.g. 10GB)."
  type        = string
  default     = "10GB"
}

variable "efs_throughput_mode" {
  description = "EFS throughput mode: bursting or elastic."
  type        = string
  default     = "bursting"

  validation {
    condition     = contains(["bursting", "elastic"], var.efs_throughput_mode)
    error_message = "efs_throughput_mode must be 'bursting' or 'elastic'."
  }
}

variable "cloudmap_namespace_name" {
  description = "Private DNS namespace name for NATS service discovery."
  type        = string
  default     = "nats.local"
}

variable "log_retention_days" {
  description = "Number of days to retain CloudWatch logs."
  type        = number
  default     = 14
}

variable "tags" {
  description = "Tags to apply to all resources."
  type        = map(string)
  default     = {}
}
