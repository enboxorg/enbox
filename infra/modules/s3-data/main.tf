################################################################################
# S3 Bucket
################################################################################

resource "aws_s3_bucket" "this" {
  bucket = var.name

  tags = var.tags
}

################################################################################
# Versioning — disabled (content-addressed, immutable by design)
################################################################################

resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id

  versioning_configuration {
    status = "Disabled"
  }
}

################################################################################
# Encryption — SSE-S3
################################################################################

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

################################################################################
# Block all public access
################################################################################

resource "aws_s3_bucket_public_access_block" "this" {
  bucket = aws_s3_bucket.this.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

################################################################################
# Lifecycle — Intelligent Tiering after 30 days
################################################################################

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    id     = "intelligent-tiering"
    status = "Enabled"

    transition {
      days          = 30
      storage_class = "INTELLIGENT_TIERING"
    }
  }
}

################################################################################
# Bucket Policy — restrict to allowed IAM roles
################################################################################

data "aws_iam_policy_document" "bucket" {
  # Allow specified roles full S3 access to this bucket
  statement {
    sid    = "AllowRoleAccess"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = var.allowed_role_arns
    }

    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:ListBucket",
    ]

    resources = [
      aws_s3_bucket.this.arn,
      "${aws_s3_bucket.this.arn}/*",
    ]
  }

  # Deny all other principals
  statement {
    sid    = "DenyOtherAccess"
    effect = "Deny"

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.this.arn,
      "${aws_s3_bucket.this.arn}/*",
    ]

    condition {
      test     = "StringNotLike"
      variable = "aws:PrincipalArn"
      values   = var.allowed_role_arns
    }
  }
}

resource "aws_s3_bucket_policy" "this" {
  bucket = aws_s3_bucket.this.id
  policy = data.aws_iam_policy_document.bucket.json

  depends_on = [aws_s3_bucket_public_access_block.this]
}
