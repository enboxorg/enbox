# ─── Terraform Backend ────────────────────────────────────────────────────────
#
# Phase 1 — initial bootstrap (local state):
#   Leave this file as-is.  Run `terraform init && terraform apply` locally.
#
# Phase 2 — migrate to S3 (after the first apply creates the bucket + table):
#   Uncomment the backend block below, then run:
#     terraform init -migrate-state
#
# After migration, all state is stored in S3 with DynamoDB locking and the
# local terraform.tfstate file can be deleted.
# ──────────────────────────────────────────────────────────────────────────────

# terraform {
#   backend "s3" {
#     bucket         = "enbox-terraform-state"
#     key            = "bootstrap/terraform.tfstate"
#     region         = "us-east-1"
#     dynamodb_table = "enbox-terraform-locks"
#     encrypt        = true
#   }
# }
