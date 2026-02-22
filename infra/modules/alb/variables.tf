variable "name" {
  description = "Name prefix for the ALB and related resources."
  type        = string
}

variable "vpc_id" {
  description = "VPC ID for the target groups."
  type        = string
}

variable "subnet_ids" {
  description = "List of public subnet IDs for the ALB."
  type        = list(string)
}

variable "security_group_ids" {
  description = "List of security group IDs to attach to the ALB."
  type        = list(string)
}

variable "certificate_arn" {
  description = "ARN of the ACM certificate for the HTTPS listener."
  type        = string
}

variable "target_port" {
  description = "Port on the targets that the ALB forwards traffic to."
  type        = number
  default     = 3000
}

variable "tags" {
  description = "Tags to apply to all resources."
  type        = map(string)
  default     = {}
}
