variable "region" {
  description = "AWS region for all bootstrap resources."
  type        = string
  default     = "us-east-1"
}

variable "account_id" {
  description = "AWS account ID. Used to scope IAM trust policies."
  type        = string
}

variable "github_org" {
  description = "GitHub organisation that owns the repository."
  type        = string
  default     = "enboxorg"
}

variable "github_repo" {
  description = "GitHub repository name (without org prefix)."
  type        = string
  default     = "enbox"
}

variable "state_bucket_name" {
  description = "Name of the S3 bucket for Terraform remote state."
  type        = string
  default     = "enbox-terraform-state"
}

variable "lock_table_name" {
  description = "Name of the DynamoDB table for Terraform state locking."
  type        = string
  default     = "enbox-terraform-locks"
}
