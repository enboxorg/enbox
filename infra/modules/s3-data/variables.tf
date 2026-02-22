variable "name" {
  description = "Name of the S3 bucket for DWN data storage."
  type        = string
}

variable "allowed_role_arns" {
  description = "List of IAM role ARNs allowed to access the bucket."
  type        = list(string)
}

variable "tags" {
  description = "Tags to apply to all resources."
  type        = map(string)
  default     = {}
}
