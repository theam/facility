mock_provider "aws" {}

override_data {
  target = data.aws_availability_zones.available
  values = { names = ["us-east-1a", "us-east-1b"] }
}

run "vercel_workspace_control_plane" {
  command = plan

  variables {
    app_hostname               = "facility.example.com"
    preview_hostname           = "preview.example.net"
    acm_certificate_arn        = "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000"
    image_tag                  = "test"
    workspace_image            = "registry.example.com/facility/runner:test"
    vercel_team_id             = "team_test"
    vercel_project_id          = "prj_test"
    facility_instance_id       = "facility-test"
    api_desired_count          = 0
    worker_desired_count       = 0
    web_desired_count          = 0
    enable_deletion_protection = false
  }

  assert {
    condition     = toset(keys(local.services)) == toset(["api", "worker", "web"])
    error_message = "The AWS control plane must stay limited to API, worker, and web services."
  }

  assert {
    condition = contains(
      local.common_environment,
      { name = "FACILITY_WORKSPACE_DRIVER", value = "vercel" },
    )
    error_message = "The AWS API task must run workspaces through Vercel."
  }

  assert {
    condition     = local.services.worker.command == ["node", "dist/worker.js"] && local.services.worker.port == 0
    error_message = "The worker must use the control-plane worker entrypoint without a public listener."
  }

  assert {
    condition     = length(aws_ecr_repository.service) == 2
    error_message = "The control plane should build only API and web images in AWS."
  }

  assert {
    condition     = aws_db_instance.facility.skip_final_snapshot && aws_db_instance.facility.final_snapshot_identifier == null
    error_message = "Disposable deployments must skip the final snapshot without setting an incompatible identifier."
  }
}
