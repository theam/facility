mock_provider "aws" {
  override_during = plan

  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
    }
  }

  mock_data "aws_availability_zones" {
    defaults = {
      names = ["us-east-1a", "us-east-1b"]
    }
  }

  mock_data "aws_cloudfront_cache_policy" {
    defaults = {
      id = "managed-caching-disabled"
    }
  }

  mock_data "aws_cloudfront_origin_request_policy" {
    defaults = {
      id = "managed-all-viewer-except-host"
    }
  }

  mock_data "aws_ec2_managed_prefix_list" {
    defaults = {
      id = "pl-cloudfront-origin-facing"
    }
  }

  mock_resource "aws_cloudfront_distribution" {
    defaults = {
      domain_name = "d111111abcdef8.cloudfront.net"
    }
  }

  mock_resource "aws_lb" {
    defaults = {
      arn      = "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/facility-test/0000000000000000"
      dns_name = "facility-test.us-east-1.elb.amazonaws.com"
      zone_id  = "Z35SXDOTRQ7X7K"
    }
  }

  mock_resource "aws_db_instance" {
    defaults = {
      master_user_secret = [{
        kms_key_id    = "mock-kms-key"
        secret_arn    = "arn:aws:secretsmanager:us-east-1:123456789012:secret:facility-db"
        secret_status = "active"
      }]
    }
  }
}

mock_provider "random" {
  override_during = plan

  mock_resource "random_password" {
    defaults = {
      result = "preview-surface-token-0000000000000000000000000000000000000000"
    }
  }
}

run "codebuild_can_list_only_the_facility_cache_prefix" {
  command = plan

  variables {
    app_hostname = "app.example.com"
    api_hostname = "api.example.com"
    mcp_hostname = "mcp.example.com"
  }

  assert {
    condition     = local.codebuild_cache_list_statement.Action == "s3:ListBucket"
    error_message = "CodeBuild cache restore requires s3:ListBucket."
  }

  assert {
    condition     = local.codebuild_cache_list_statement.Condition.StringLike["s3:prefix"] == ["codebuild-cache/*"]
    error_message = "The bucket listing permission must remain confined to Facility cache objects."
  }
}
