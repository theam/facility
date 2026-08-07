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

run "enhanced_scanning_is_an_explicit_scoped_opt_in" {
  command = plan

  variables {
    app_hostname                 = "app.example.com"
    api_hostname                 = "api.example.com"
    mcp_hostname                 = "mcp.example.com"
    enable_ecr_enhanced_scanning = true
  }

  assert {
    condition     = length(aws_ecr_registry_scanning_configuration.facility) == 1
    error_message = "The explicit opt-in must manage one regional ECR registry policy."
  }

  assert {
    condition     = one(aws_ecr_registry_scanning_configuration.facility).scan_type == "ENHANCED"
    error_message = "The managed policy must use Inspector-backed enhanced scanning."
  }

  assert {
    condition     = one(one(aws_ecr_registry_scanning_configuration.facility).rule).scan_frequency == "SCAN_ON_PUSH"
    error_message = "Facility images must be scanned once on push, not continuously rescanned."
  }

  assert {
    condition     = one(one(one(aws_ecr_registry_scanning_configuration.facility).rule).repository_filter).filter == "facility-playground/*"
    error_message = "The paid scan must be limited to this Facility stack's repository prefix."
  }
}

run "enhanced_scanning_is_not_enabled_implicitly" {
  command = plan

  variables {
    app_hostname = "app.example.com"
    api_hostname = "api.example.com"
    mcp_hostname = "mcp.example.com"
  }

  assert {
    condition     = length(aws_ecr_registry_scanning_configuration.facility) == 0
    error_message = "A stack must not take over the account-wide ECR policy without an explicit opt-in."
  }
}
