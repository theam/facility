data "aws_cloudfront_cache_policy" "caching_disabled" {
  count = var.enable_cloudfront_api_endpoint ? 1 : 0

  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  count = var.enable_cloudfront_api_endpoint ? 1 : 0

  name = "Managed-AllViewerExceptHostHeader"
}

resource "aws_cloudfront_distribution" "api" {
  count = var.enable_cloudfront_api_endpoint ? 1 : 0

  enabled         = true
  is_ipv6_enabled = true
  comment         = "${local.name_prefix} API validation endpoint"
  price_class     = "PriceClass_100"
  http_version    = "http2and3"

  origin {
    domain_name = aws_lb.public.dns_name
    origin_id   = "${local.name_prefix}-api-alb"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = "${local.name_prefix}-api-alb"
    viewer_protocol_policy = "redirect-to-https"

    allowed_methods = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods  = ["GET", "HEAD"]

    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled[0].id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host[0].id
    compress                 = false
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
    # AWS fixes the default *.cloudfront.net certificate policy to TLSv1. A
    # custom domain and ACM certificate are required to enforce TLSv1.2_2021.
    minimum_protocol_version = "TLSv1"
  }

  lifecycle {
    precondition {
      condition     = var.acm_certificate_arn == ""
      error_message = "enable_cloudfront_api_endpoint requires acm_certificate_arn to be empty because its ALB origin uses certificate-less HTTP forwarding."
    }
  }

  depends_on = [aws_lb_listener.http]
}
