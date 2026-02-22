variable "name" {
  description = "Name prefix for alarms and related resources."
  type        = string
}

variable "cluster_name" {
  description = "Name of the ECS cluster to monitor."
  type        = string
}

variable "service_name" {
  description = "Name of the ECS service to monitor."
  type        = string
}

variable "alb_arn_suffix" {
  description = "ARN suffix of the ALB (e.g. app/my-alb/1234567890)."
  type        = string
}

variable "aurora_cluster_id" {
  description = "Identifier of the Aurora cluster to monitor."
  type        = string
}

variable "sns_topic_arn" {
  description = "ARN of the SNS topic for alarm notifications. Empty string to disable notifications."
  type        = string
  default     = ""
}

variable "cpu_threshold" {
  description = "ECS service CPU utilization alarm threshold (percent)."
  type        = number
  default     = 70
}

variable "memory_threshold" {
  description = "ECS service memory utilization alarm threshold (percent)."
  type        = number
  default     = 80
}

variable "aurora_cpu_threshold" {
  description = "Aurora CPU utilization alarm threshold (percent)."
  type        = number
  default     = 70
}

variable "alb_5xx_threshold" {
  description = "ALB 5xx error count alarm threshold."
  type        = number
  default     = 50
}

variable "alb_latency_threshold" {
  description = "ALB target response time P95 alarm threshold (seconds)."
  type        = number
  default     = 1
}

variable "tags" {
  description = "Tags to apply to all resources."
  type        = map(string)
  default     = {}
}
