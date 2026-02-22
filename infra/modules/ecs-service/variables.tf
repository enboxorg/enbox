variable "name" {
  description = "Name of the ECS service and related resources."
  type        = string
}

variable "cluster_arn" {
  description = "ARN of the ECS cluster to deploy the service into."
  type        = string
}

variable "subnet_ids" {
  description = "List of subnet IDs for the service's network configuration."
  type        = list(string)
}

variable "security_group_ids" {
  description = "List of security group IDs to attach to the service."
  type        = list(string)
}

variable "image" {
  description = "Container image URI (e.g. 123456789.dkr.ecr.us-east-1.amazonaws.com/app:latest)."
  type        = string
}

variable "cpu" {
  description = "CPU units for the task (256 = 0.25 vCPU)."
  type        = number
  default     = 256
}

variable "memory" {
  description = "Memory in MiB for the task."
  type        = number
  default     = 512
}

variable "container_port" {
  description = "Port the container listens on."
  type        = number
}

variable "desired_count" {
  description = "Desired number of running tasks."
  type        = number
  default     = 1
}

variable "environment" {
  description = "Map of environment variables to set on the container."
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Map of secret environment variables. Keys are env var names, values are Secrets Manager or SSM Parameter Store ARNs."
  type        = map(string)
  default     = {}
}

variable "target_group_arn" {
  description = "ARN of an ALB target group to register the service with. Empty string to skip."
  type        = string
  default     = ""
}

variable "autoscaling_min" {
  description = "Minimum number of tasks for auto scaling."
  type        = number
  default     = 1
}

variable "autoscaling_max" {
  description = "Maximum number of tasks for auto scaling."
  type        = number
  default     = 4
}

variable "log_retention_days" {
  description = "Number of days to retain CloudWatch logs."
  type        = number
  default     = 30
}

variable "tags" {
  description = "Tags to apply to all resources."
  type        = map(string)
  default     = {}
}
