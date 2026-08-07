resource "aws_iam_role" "ecs_execution" {
  name = "${local.name_prefix}-ecs-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role" "task" {
  name = "${local.name_prefix}-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role" "preview_execution" {
  name = "${local.name_prefix}-preview-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role" "preview_task" {
  name = "${local.name_prefix}-preview-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role" "codebuild_runner" {
  name = "${local.name_prefix}-codebuild-runner"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "codebuild.amazonaws.com"
      }
      Action = "sts:AssumeRole"
      Condition = {
        StringEquals = {
          "aws:SourceAccount" = data.aws_caller_identity.current.account_id
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "ecs_execution" {
  name = "${local.name_prefix}-ecs-execution"
  role = aws_iam_role.ecs_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "EcrAuthToken"
        Effect = "Allow"
        Action = [
          "ecr:GetAuthorizationToken"
        ]
        Resource = "*"
      },
      {
        Sid    = "EcrPull"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer"
        ]
        Resource = [for repo in aws_ecr_repository.service : repo.arn]
      },
      {
        Sid    = "WriteLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = [for group in aws_cloudwatch_log_group.service : "${group.arn}:*"]
      },
      {
        Sid    = "ReadTaskSecrets"
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue"
        ]
        Resource = [for secret in aws_secretsmanager_secret.app : secret.arn]
      },
      {
        Sid    = "DecryptTaskSecrets"
        Effect = "Allow"
        Action = [
          "kms:Decrypt"
        ]
        Resource = aws_kms_key.facility.arn
      }
    ]
  })
}

resource "aws_iam_role_policy" "preview_execution" {
  name = "${local.name_prefix}-preview-execution"
  role = aws_iam_role.preview_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "EcrAuthToken"
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Sid    = "PullFacilityImages"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer"
        ]
        Resource = [for repo in aws_ecr_repository.service : repo.arn]
      },
      {
        Sid    = "WritePreviewLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "${aws_cloudwatch_log_group.service["preview"].arn}:*"
      }
    ]
  })
}

resource "aws_iam_role_policy" "task" {
  name = "${local.name_prefix}-task"
  role = aws_iam_role.task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ObjectStorage"
        Effect = "Allow"
        Action = [
          "s3:AbortMultipartUpload",
          "s3:DeleteObject",
          "s3:GetObject",
          "s3:ListBucket",
          "s3:PutObject"
        ]
        Resource = [
          aws_s3_bucket.objects.arn,
          "${aws_s3_bucket.objects.arn}/*"
        ]
      },
      {
        Sid    = "RuntimeSecrets"
        Effect = "Allow"
        Action = [
          "secretsmanager:DescribeSecret",
          "secretsmanager:GetSecretValue"
        ]
        Resource = [for secret in aws_secretsmanager_secret.app : secret.arn]
      },
      {
        Sid    = "KmsForFacilityResources"
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:Encrypt",
          "kms:GenerateDataKey"
        ]
        Resource = aws_kms_key.facility.arn
      },
      {
        Sid    = "LaunchRunnerBuilds"
        Effect = "Allow"
        Action = [
          "codebuild:StartBuild"
        ]
        Resource = aws_codebuild_project.runner.arn
      },
      {
        Sid    = "ManageRunnerBuilds"
        Effect = "Allow"
        Action = [
          "codebuild:BatchGetProjects",
          "codebuild:BatchGetBuilds",
          "codebuild:StopBuild"
        ]
        Resource = aws_codebuild_project.runner.arn
      },
      {
        Sid    = "ReadRunnerLogs"
        Effect = "Allow"
        Action = [
          "logs:GetLogEvents"
        ]
        Resource = "${aws_cloudwatch_log_group.service["runner"].arn}:*"
      },
      {
        Sid      = "RegisterPreviewTaskDefinitions"
        Effect   = "Allow"
        Action   = "ecs:RegisterTaskDefinition"
        Resource = "*"
      },
      {
        Sid      = "DeregisterPreviewTaskDefinitions"
        Effect   = "Allow"
        Action   = "ecs:DeregisterTaskDefinition"
        Resource = "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task-definition/${local.name_prefix}-preview:*"
      },
      {
        Sid      = "LaunchPreviewTasks"
        Effect   = "Allow"
        Action   = "ecs:RunTask"
        Resource = "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task-definition/${local.name_prefix}-preview:*"
        Condition = {
          ArnEquals = {
            "ecs:cluster" = aws_ecs_cluster.facility.arn
          }
        }
      },
      {
        Sid    = "ManagePreviewTasks"
        Effect = "Allow"
        Action = [
          "ecs:DescribeTasks",
          "ecs:StopTask"
        ]
        Resource = "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task/${aws_ecs_cluster.facility.name}/*"
      },
      {
        Sid      = "DiscoverPreviewTasks"
        Effect   = "Allow"
        Action   = "ecs:ListTasks"
        Resource = "*"
        Condition = {
          ArnEquals = {
            "ecs:cluster" = aws_ecs_cluster.facility.arn
          }
        }
      },
      {
        Sid    = "PassPreviewRoles"
        Effect = "Allow"
        Action = "iam:PassRole"
        Resource = [
          aws_iam_role.preview_execution.arn,
          aws_iam_role.preview_task.arn
        ]
        Condition = {
          StringEquals = {
            "iam:PassedToService" = "ecs-tasks.amazonaws.com"
          }
        }
      },
      {
        Sid      = "ReadPreviewLogs"
        Effect   = "Allow"
        Action   = "logs:GetLogEvents"
        Resource = "${aws_cloudwatch_log_group.service["preview"].arn}:*"
      }
    ]
  })
}

resource "aws_iam_role_policy" "codebuild_runner" {
  name = "${local.name_prefix}-codebuild-runner"
  role = aws_iam_role.codebuild_runner.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "WriteRunnerLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "${aws_cloudwatch_log_group.service["runner"].arn}:*"
      },
      {
        Sid      = "EcrAuthToken"
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Sid    = "PullRunnerImage"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer"
        ]
        Resource = aws_ecr_repository.service["runner"].arn
      },
      {
        Sid    = "ReadWriteProjectCaches"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:GetObjectVersion",
          "s3:PutObject"
        ]
        Resource = "${aws_s3_bucket.objects.arn}/codebuild-cache/*"
      },
      local.codebuild_cache_list_statement,
      {
        Sid    = "VerifyCacheBucket"
        Effect = "Allow"
        Action = [
          "s3:GetBucketAcl",
          "s3:GetBucketLocation"
        ]
        Resource = aws_s3_bucket.objects.arn
      },
      {
        Sid    = "EncryptProjectCaches"
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey"
        ]
        Resource = aws_kms_key.facility.arn
        Condition = {
          StringEquals = {
            "kms:ViaService" = "s3.${var.aws_region}.amazonaws.com"
          }
        }
      },
      {
        Sid    = "ManageVpcNetworkInterfaces"
        Effect = "Allow"
        Action = [
          "ec2:CreateNetworkInterface",
          "ec2:DeleteNetworkInterface",
          "ec2:DescribeDhcpOptions",
          "ec2:DescribeNetworkInterfaces",
          "ec2:DescribeSecurityGroups",
          "ec2:DescribeSubnets",
          "ec2:DescribeVpcs"
        ]
        Resource = "*"
      },
      {
        Sid      = "AuthorizeCodeBuildNetworkInterfaces"
        Effect   = "Allow"
        Action   = "ec2:CreateNetworkInterfacePermission"
        Resource = "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:network-interface/*"
        Condition = {
          StringEquals = {
            "ec2:AuthorizedService" = "codebuild.amazonaws.com"
          }
          ArnEquals = {
            "ec2:Subnet" = [for subnet in aws_subnet.private : subnet.arn]
          }
        }
      }
    ]
  })
}

locals {
  # CodeBuild's S3 cache client lists the configured prefix before it downloads
  # an archive. Object-only permissions make every restore fail with
  # AccessDenied. The bucket action remains confined to Facility's cache
  # subtree, so the runner cannot enumerate unrelated object prefixes.
  codebuild_cache_list_statement = {
    Sid      = "ListProjectCachePrefix"
    Effect   = "Allow"
    Action   = "s3:ListBucket"
    Resource = aws_s3_bucket.objects.arn
    Condition = {
      StringLike = {
        "s3:prefix" = ["codebuild-cache/*"]
      }
    }
  }
}
