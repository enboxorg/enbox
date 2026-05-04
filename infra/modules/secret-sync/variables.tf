variable "name" {
  description = "Name prefix for all resources (e.g. dwn-dev). The Lambda will be named '<name>-secret-sync'."
  type        = string
}

variable "environment" {
  description = "Environment name (e.g. dev, prod). Passed to the Lambda for log context."
  type        = string
}

variable "target_secret_arn" {
  description = "ARN of the Secrets Manager secret holding the canonical Postgres URL (dwn/<env>/database-url)."
  type        = string
}

variable "master_secret_arn" {
  description = "ARN of the Aurora master credentials secret managed by RDS (rds!cluster-...)."
  type        = string
}

variable "rds_cluster_id" {
  description = "Identifier of the Aurora cluster (used by the Lambda to call DescribeDBClusters)."
  type        = string
}

variable "rds_cluster_arn" {
  description = "ARN of the Aurora cluster (used to scope the Lambda's rds:DescribeDBClusters policy)."
  type        = string
}

variable "db_name" {
  description = "Database name to embed in the Postgres URL."
  type        = string
  default     = "dwn"
}

variable "ecs_cluster_name" {
  description = "Name of the ECS cluster hosting the services to roll on rotation."
  type        = string
}

variable "ecs_cluster_arn" {
  description = "ARN of the ECS cluster (used to scope the Lambda's ecs:* policy via condition)."
  type        = string
}

variable "ecs_service_names" {
  description = "Names of ECS services to force-redeploy when the secret changes."
  type        = list(string)
}

variable "sns_topic_arn" {
  description = "Optional SNS topic for alarm notifications. Empty string disables SNS actions."
  type        = string
  default     = ""
}

variable "log_retention_days" {
  description = "Retention for the Lambda CloudWatch log group."
  type        = number
  default     = 30
}

variable "drift_check_schedule" {
  description = "EventBridge schedule expression for the drift-check safety net invocation."
  type        = string
  default     = "rate(6 hours)"
}

variable "lambda_timeout" {
  description = "Lambda function timeout in seconds."
  type        = number
  default     = 60
}

variable "lambda_memory_mb" {
  description = "Lambda function memory in MB."
  type        = number
  default     = 256
}

variable "tags" {
  description = "Tags to apply to all resources."
  type        = map(string)
  default     = {}
}
