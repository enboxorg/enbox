variable "aws_region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "us-east-1"
}

variable "certificate_arn" {
  description = "ACM certificate ARN for the ALB HTTPS listener."
  type        = string
}

variable "dwn_image" {
  description = "DWN server container image URI (e.g. 123456789.dkr.ecr.us-east-1.amazonaws.com/dwn-server:latest)."
  type        = string
}
