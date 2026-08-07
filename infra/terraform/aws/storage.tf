resource "aws_s3_bucket" "objects" {
  bucket        = "${local.name_prefix}-objects-${data.aws_caller_identity.current.account_id}"
  force_destroy = var.force_destroy_bucket

  tags = {
    Name = "${local.name_prefix}-objects"
  }
}

resource "aws_s3_bucket_public_access_block" "objects" {
  bucket = aws_s3_bucket.objects.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "objects" {
  bucket = aws_s3_bucket.objects.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "objects" {
  bucket = aws_s3_bucket.objects.id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.facility.arn
      sse_algorithm     = "aws:kms"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "objects" {
  bucket = aws_s3_bucket.objects.id

  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"

    filter {
      prefix = ""
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  # Retention for stored LLM request/response envelopes: "store everything" is
  # bounded by a configurable window so raw bodies are not kept indefinitely.
  rule {
    id     = "expire-envelopes"
    status = "Enabled"

    filter {
      prefix = "envelopes/"
    }

    expiration {
      days = var.envelope_retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = var.envelope_retention_days
    }
  }

  # CodeBuild overwrites one dependency-store cache per Facility project. Keep
  # active caches warm for a month and discard superseded versions quickly.
  rule {
    id     = "expire-codebuild-caches"
    status = "Enabled"

    filter {
      prefix = "codebuild-cache/"
    }

    expiration {
      days = 30
    }

    noncurrent_version_expiration {
      noncurrent_days = 7
    }
  }
}

resource "aws_ecr_repository" "service" {
  for_each = local.ecr_repositories

  name                 = "${local.name_prefix}/${each.key}"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.facility.arn
  }

  tags = {
    Name = "${local.name_prefix}-${each.key}"
  }
}

# ECR exposes fix availability only through Inspector-backed enhanced findings.
# Registry scanning is account-and-region scoped, so shared accounts must leave
# this opt-in disabled and manage their single registry policy centrally.
resource "aws_ecr_registry_scanning_configuration" "facility" {
  count = var.enable_ecr_enhanced_scanning ? 1 : 0

  # This registry policy supersedes each repository's basic scan_on_push setting.
  scan_type = "ENHANCED"

  rule {
    scan_frequency = "SCAN_ON_PUSH"

    repository_filter {
      filter      = "${local.name_prefix}/*"
      filter_type = "WILDCARD"
    }
  }
}

resource "aws_ecr_lifecycle_policy" "service" {
  for_each = aws_ecr_repository.service

  repository = each.value.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 30 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 30
      }
      action = {
        type = "expire"
      }
    }]
  })
}
