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

run "managed_preview_needs_no_domain_or_certificate" {
  command = plan

  variables {
    app_hostname = "app.example.com"
    api_hostname = "api.example.com"
    mcp_hostname = "mcp.example.com"
  }

  assert {
    condition     = local.managed_preview_origin
    error_message = "An empty preview_hostname must select the managed preview origin."
  }

  assert {
    condition     = length(aws_cloudfront_distribution.preview) == 1
    error_message = "The managed mode must create one isolated CloudFront distribution."
  }

  assert {
    condition     = length(random_password.preview_surface) == 1
    error_message = "The managed mode must create an unguessable preview-surface token."
  }

  assert {
    condition     = output.preview_url == "https://d111111abcdef8.cloudfront.net"
    error_message = "The managed mode must publish the AWS-assigned HTTPS origin."
  }

  assert {
    condition     = one(aws_cloudfront_distribution.preview[0].origin).domain_name == aws_lb.public.dns_name
    error_message = "Certificate-less managed previews must use the ALB address as their origin."
  }

  assert {
    condition     = one(one(aws_cloudfront_distribution.preview[0].origin).custom_origin_config).origin_protocol_policy == "http-only"
    error_message = "Certificate-less managed previews must use the documented validation-only HTTP origin hop."
  }

  assert {
    condition     = length(aws_lb_listener_rule.http_preview_managed) == 1
    error_message = "Certificate-less managed traffic must have an explicit marked ALB route."
  }

  assert {
    condition     = length(aws_lb_listener_rule.http_preview) == 0 && length(aws_lb_listener_rule.https_preview) == 0
    error_message = "Managed previews must not create custom-hostname ALB routes."
  }

  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.alb_preview_cloudfront) == 1
    error_message = "Managed previews must allow only CloudFront origin traffic on the selected ALB port."
  }

  assert {
    condition     = one([for entry in local.api_environment : entry.value if entry.name == "FACILITY_PREVIEW_SURFACE_TOKEN"]) == random_password.preview_surface[0].result
    error_message = "Only the trusted API path must receive the generated preview-surface token."
  }

  assert {
    condition     = length([for entry in local.worker_environment : entry if entry.name == "FACILITY_PREVIEW_SURFACE_TOKEN"]) == 0
    error_message = "The worker does not serve previews and must not receive the surface token."
  }

  assert {
    condition     = !contains(keys(aws_lb_target_group.service), "gateway") && length(aws_lb_listener_rule.http_vercel_gateway) == 0 && length(aws_lb_listener_rule.https_vercel_gateway) == 0 && length(aws_vpc_security_group_ingress_rule.gateway_from_alb) == 0
    error_message = "The AWS sandbox path must keep the model gateway private."
  }

  assert {
    condition     = !local.interactive_mcp_oauth_enabled && length([for entry in local.api_environment : entry if contains(["FACILITY_OAUTH_ISSUER", "MCP_PUBLIC_URL"], entry.name)]) == 0 && length([for entry in local.api_secrets : entry if entry.name == "FACILITY_OAUTH_JWKS"]) == 0 && length([for entry in local.mcp_environment : entry if contains(["MCP_PUBLIC_URL", "MCP_AUTHORIZATION_SERVER"], entry.name)]) == 0
    error_message = "Certificate-less validation must not configure or advertise interactive MCP OAuth."
  }

  assert {
    condition     = one([for entry in local.mcp_environment : entry.value if entry.name == "MCP_ALLOWED_HOSTS"]) == "mcp.example.com"
    error_message = "Certificate-less validation must retain the MCP listener for scoped fak_ API keys without an OAuth resource."
  }
}

run "managed_preview_uses_the_existing_https_api_origin" {
  command = plan

  variables {
    app_hostname        = "app.example.com"
    api_hostname        = "api.example.com"
    mcp_hostname        = "mcp.example.com"
    acm_certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000"
  }

  assert {
    condition     = local.managed_preview_origin && length(aws_cloudfront_distribution.preview) == 1
    error_message = "The production mode must retain the managed preview distribution."
  }

  assert {
    condition     = one(aws_cloudfront_distribution.preview[0].origin).domain_name == "api.example.com"
    error_message = "CloudFront must use the certificate-backed API hostname as its production origin."
  }

  assert {
    condition     = one(one(aws_cloudfront_distribution.preview[0].origin).custom_origin_config).origin_protocol_policy == "https-only"
    error_message = "CloudFront must encrypt the production origin hop."
  }

  assert {
    condition     = length(aws_lb_listener_rule.http_preview_managed) == 0 && length(aws_lb_listener_rule.https_api) == 1
    error_message = "Production managed previews must reuse the existing HTTPS API host rule."
  }

  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.alb_preview_cloudfront) == 1 && aws_vpc_security_group_ingress_rule.alb_preview_cloudfront[0].from_port == 443 && aws_vpc_security_group_ingress_rule.alb_preview_cloudfront[0].to_port == 443
    error_message = "Production managed previews must admit CloudFront only on the HTTPS origin port."
  }

  assert {
    condition     = local.interactive_mcp_oauth_enabled && one([for entry in local.api_environment : entry.value if entry.name == "FACILITY_OAUTH_ISSUER"]) == "https://app.example.com" && one([for entry in local.api_environment : entry.value if entry.name == "MCP_PUBLIC_URL"]) == "https://mcp.example.com" && length([for entry in local.api_secrets : entry if entry.name == "FACILITY_OAUTH_JWKS"]) == 1 && one([for entry in local.mcp_environment : entry.value if entry.name == "MCP_AUTHORIZATION_SERVER"]) == "https://app.example.com" && one([for entry in local.mcp_environment : entry.value if entry.name == "MCP_PUBLIC_URL"]) == "https://mcp.example.com"
    error_message = "Certificate-backed stacks must configure the web issuer, signing key, and MCP advertisement together."
  }
}

run "custom_preview_keeps_the_advanced_override" {
  command = plan

  variables {
    app_hostname        = "app.example.com"
    api_hostname        = "api.example.com"
    mcp_hostname        = "mcp.example.com"
    preview_hostname    = "preview.example.net"
    acm_certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000"
  }

  assert {
    condition     = !local.managed_preview_origin
    error_message = "A non-empty preview_hostname must select the custom-domain mode."
  }

  assert {
    condition     = length(aws_cloudfront_distribution.preview) == 0 && length(random_password.preview_surface) == 0
    error_message = "The custom-domain mode must not create the managed origin or its token."
  }

  assert {
    condition     = output.preview_url == "https://preview.example.net"
    error_message = "The custom-domain mode must retain the configured HTTPS origin."
  }

  assert {
    condition     = length(aws_lb_listener_rule.https_preview) == 1
    error_message = "The custom-domain mode must route its hostname through the HTTPS listener."
  }

  assert {
    condition     = length(aws_lb_listener_rule.http_preview_managed) == 0 && length(aws_vpc_security_group_ingress_rule.alb_preview_cloudfront) == 0
    error_message = "The custom-domain mode must not retain managed-origin routing or ingress."
  }

  assert {
    condition     = length([for entry in local.api_environment : entry if entry.name == "FACILITY_PREVIEW_SURFACE_TOKEN"]) == 0
    error_message = "The custom-domain mode must not inject a managed-origin token."
  }
}

run "vercel_sandbox_provider_replaces_only_the_compute_binding" {
  command = plan

  variables {
    app_hostname        = "app.example.com"
    api_hostname        = "api.example.com"
    mcp_hostname        = "mcp.example.com"
    sandbox_driver      = "vercel"
    vercel_team_id      = "team_facility"
    vercel_project_id   = "prj_facility"
    vercel_runner_image = "facility-runner:sha"
  }

  assert {
    condition     = one([for entry in local.api_environment : entry.value if entry.name == "FACILITY_SANDBOX_DRIVER"]) == "vercel"
    error_message = "The API must select the Vercel sandbox adapter."
  }

  assert {
    condition     = one([for entry in local.worker_environment : entry.value if entry.name == "FACILITY_RUNNER_IMAGE"]) == "facility-runner:sha"
    error_message = "The worker must use the project-scoped VCR runner image."
  }

  assert {
    condition     = one([for entry in local.worker_environment : entry.value if entry.name == "VERCEL_TEAM_ID"]) == "team_facility" && one([for entry in local.worker_environment : entry.value if entry.name == "VERCEL_PROJECT_ID"]) == "prj_facility"
    error_message = "The worker must receive the exact Vercel team/project binding."
  }

  assert {
    condition     = length([for entry in local.worker_environment : entry if startswith(entry.name, "FACILITY_AWS_")]) == 0
    error_message = "The Vercel path must not inject unused AWS sandbox configuration."
  }

  assert {
    condition     = length([for entry in local.worker_secrets : entry if entry.name == "VERCEL_TOKEN"]) == 1
    error_message = "The Vercel token must come from Secrets Manager rather than Terraform state."
  }

  assert {
    condition     = one([for entry in local.worker_environment : entry.value if entry.name == "SANDBOX_GATEWAY_URL"]) == "http://api.example.com"
    error_message = "Vercel sandboxes must receive the reachable public API origin for authenticated model traffic."
  }

  assert {
    condition     = length(aws_lb_listener_rule.http_vercel_gateway) == 1 && length(aws_lb_listener_rule.https_vercel_gateway) == 0
    error_message = "The certificate-less Vercel path must route only through the HTTP API listener."
  }

  assert {
    condition     = contains(keys(aws_lb_target_group.service), "gateway") && length(aws_vpc_security_group_ingress_rule.gateway_from_alb) == 1
    error_message = "The Vercel path must connect its authenticated gateway target to the public ALB."
  }
}

run "vercel_sandbox_gateway_uses_the_existing_https_api_origin" {
  command = plan

  variables {
    app_hostname        = "app.example.com"
    api_hostname        = "api.example.com"
    mcp_hostname        = "mcp.example.com"
    acm_certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000"
    sandbox_driver      = "vercel"
    vercel_team_id      = "team_facility"
    vercel_project_id   = "prj_facility"
    vercel_runner_image = "facility-runner:sha"
  }

  assert {
    condition     = one([for entry in local.api_environment : entry.value if entry.name == "SANDBOX_GATEWAY_URL"]) == "https://api.example.com"
    error_message = "Production Vercel sandboxes must use the existing TLS API origin."
  }

  assert {
    condition     = length(aws_lb_listener_rule.http_vercel_gateway) == 0 && length(aws_lb_listener_rule.https_vercel_gateway) == 1
    error_message = "Production Vercel model traffic must route only through the HTTPS listener."
  }
}
