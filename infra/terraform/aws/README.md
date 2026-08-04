# Facility AWS Terraform

This module provisions the AWS reference deployment from the platform architecture:
VPC, two private AZs, public ALB, RDS Postgres 16, S3 object storage, ECR,
ECS Fargate services for `api`, `worker`, `gateway`, `web`, and `mcp`, privileged
CodeBuild jobs for agent runs, unprivileged Fargate preview tasks, KMS, Secrets
Manager, and CloudWatch logs.

Topology:

- `app_hostname` routes to the `web` ECS service through the public ALB.
- `api_hostname` routes to the `api` ECS service through the public ALB.
- `mcp_hostname` routes to the audience-bound MCP resource server.
- `gateway` has no public ALB route. It is reachable only inside the VPC through
  Cloud Map at the `gateway_internal_url` output.
- Postgres accepts `5432` only from the ECS service security group.
- CodeBuild sandboxes run in private subnets and can reach the internal gateway.
  Their least-privilege service role has no Secrets Manager access. Runs always
  use the runner image fixed on the CodeBuild project; database-backed sandbox
  profiles cannot override that AWS-trusted image.
- Private preview services use per-image Fargate task definitions, a no-permission
  task role, and a dedicated execution role. Only Facility services can reach
  their private ports through the sandbox security group.
- Migrations are a one-shot ECS task definition. Terraform does not run them.

## 1. Prepare variables

```bash
cd infra/terraform/aws
cp terraform.tfvars.example playground.tfvars
```

Edit `playground.tfvars`:

- Set `aws_region` and change the copied `environment = "playground"` value if
  this is not a playground deployment; a filename does not set the variable.
- Set `app_hostname`, `api_hostname`, and `mcp_hostname`.
- Set `acm_certificate_arn` for HTTPS, or leave it empty for HTTP-only testing.
- Set `route53_zone_id` if Terraform should create alias records.
- Set `enable_cloudfront_api_endpoint = true` to get an AWS-managed HTTPS API
  and webhook URL without a public DNS zone. This is intended for validation;
  use your own hostname and ACM certificate for production.
- Choose the image source below before the first apply.
- Select direct `github` authentication for self-hosting or `oidc` for a SaaS
  broker. MCP OAuth is always issued by the dedicated Facility instance.
- Set `github_oauth_allowed_organization` to a GitHub organization login when
  direct login must require active membership; leave it empty for no additional
  organization restriction.
- Set `enable_package_registry_token = true` only after populating the optional
  private package token; leave it false for public-package repositories.
- Tune `envelope_retention_days` for your data-retention policy.

Release tags publish images as `:<version>` (for example, `v0.3.0` publishes
`:0.3.0`). GitHub creates each GHCR package private; repository visibility does
not make it public. Use the release path only after a maintainer has made all
six packages public and you have verified that each chosen image tag is
anonymously pullable. Then add the overrides before the first apply, replacing
`<version>` with the release version without its leading `v`:

```hcl
image_overrides = {
  api     = "ghcr.io/theam/facility/api:<version>"
  worker  = "ghcr.io/theam/facility/worker:<version>"
  gateway = "ghcr.io/theam/facility/gateway:<version>"
  web     = "ghcr.io/theam/facility/web:<version>"
  mcp     = "ghcr.io/theam/facility/mcp:<version>"
  runner  = "ghcr.io/theam/facility/runner:<version>"
}
```

Release images are `linux/amd64`, matching the module's default
`task_cpu_architecture`. If any package or tag is absent or private, or if you
are deploying on Graviton, from a non-release commit, or from a private fork,
leave `image_overrides` empty and use the build fallback in Step 3. On that
path, set every `container_image_tags` entry to the commit tag you will push
before the first apply.

For the first apply, set every service count to zero. Secret values do not exist
yet, and on the build path neither do the images. `mcp_desired_count` otherwise
defaults to `2`:

```hcl
api_desired_count     = 0
worker_desired_count  = 0
gateway_desired_count = 0
web_desired_count     = 0
mcp_desired_count     = 0
```

For the AWS-managed CloudFront validation endpoint, also clear the copied
placeholder `acm_certificate_arn` and `route53_zone_id`; placeholder values are
not disabled merely by setting `enable_cloudfront_api_endpoint = true`.

No secret values belong in tfvars.

## 2. Create AWS resources

```bash
terraform init
terraform apply -var-file=playground.tfvars
```

Record these outputs:

- `ecr_repository_urls`
- `secret_arns`
- `rds_endpoint`
- `rds_master_user_secret_arn`
- `ecs_cluster_name`
- `codebuild_runner_project_name`
- `migrate_task_definition_arn`
- `private_subnet_ids`
- `service_security_group_id`

## 3. Build and push images when needed

If you configured and verified public `image_overrides` before the first apply,
skip this step. The overridden `web` image must have been built with
`FACILITY_API_URL` set to this deployment's `api_url`; unlike the other images,
its same-origin proxy destination is compiled into the Next.js build. Otherwise,
from the module directory used above, build from the repository root and return
afterward:

```bash
cd ../../..
AWS_REGION=us-east-1 \
ECR_PREFIX="$(terraform -chdir=infra/terraform/aws output -raw ecs_cluster_name)" \
IMAGE_TAG=$(git rev-parse --short HEAD) \
FACILITY_API_URL="$(terraform -chdir=infra/terraform/aws output -raw api_url)" \
./infra/build-images.sh
cd infra/terraform/aws
```

The script expects Dockerfiles for `api`, `worker`, `gateway`, `web`, `mcp`, and
`runner`. Override paths or image URIs with environment variables documented in
the script when a service image is built elsewhere. It builds `linux/amd64` by
default, matching Terraform's default `task_cpu_architecture = "X86_64"`. To
deploy on Graviton, set `CPU_ARCHITECTURE=ARM64` while building and set
`task_cpu_architecture = "ARM64"` in Terraform. The build exits early if an
explicit `PLATFORM` conflicts with `CPU_ARCHITECTURE`.

Rebuild and redeploy the `web` image whenever `api_url` changes. Supplying only
the runtime ECS environment variable does not update Next.js rewrite rules that
were compiled into an existing image.

If you changed `container_image_tags` after the first apply, apply again before
running the migrate task. Keeping the tag stable avoids that extra apply.

## 4. Populate Secrets Manager

Terraform creates encrypted secret containers but never writes secret values.
Populate them with `aws secretsmanager put-secret-value`, loading plaintext from
standard input or a protected file rather than a process argument. The
[deployment runbook](https://github.com/theam/facility/blob/main/apps/docs/docs/self-host/aws.md#4-populate-the-secret-containers)
has commands that populate every required value without printing it.

Required runtime values:

- `database_url`: `postgres://facility:<password>@<rds_endpoint>:5432/facility?sslmode=verify-full`
- `secret_master_key`: 32-byte base64 value from `openssl rand -base64 32`
- `github_oauth_client_id` and `github_oauth_client_secret` in direct mode, or
  `oidc_client_id` and `oidc_client_secret` in broker mode
- `facility_oauth_jwks`: persistent private ES256 JWK set
- `github_app_id`
- `github_app_private_key`
- `github_app_webhook_secret`
- `github_app_slug`
- `package_registry_token`: optional classic PAT restricted to `read:packages`;
  the API releases it through the authenticated runner handshake only for the
  dedicated dependency-install phase; the CodeBuild role has no IAM access to
  it, and the runner deletes its temporary npm config before provisioning. Set
  `enable_package_registry_token = true` only after populating it.

The privileged CodeBuild host does not give repository commands an unrestricted
Docker socket. The runner uses a separate root lifecycle process, a rootless
daemon UID, and an allowlisted socket proxy; its production smoke test rejects
privileged containers, host PID mode, `/proc` mounts, raw-socket access, and
runner-environment reads before the project is considered ready.

The `dev_anthropic_api_key` and `dev_openai_api_key` secrets exist only for
local/bootstrap fallback compatibility. Prefer provider credentials stored
through the Facility API after boot.

The production service image loads Amazon's published global RDS CA bundle so
`sslmode=verify-full` encrypts the connection and verifies the database
hostname. Do not downgrade this to a non-verifying TLS mode.

The RDS master password is in `rds_master_user_secret_arn`; use the runbook's
captured pipeline to URL-encode it into `database_url` without writing the
plaintext to the terminal.

## 5. Run the migrate + seed task once

The `migrate` task runs database migrations **and** seeds the bundled essentials
(roles, action types, default sandbox profile) that administrative bootstrap and
`facility doctor` require — seeding is idempotent. Run it only after the
`database_url` secret and images are populated:

```bash
aws ecs run-task \
  --cluster "$(terraform output -raw ecs_cluster_name)" \
  --launch-type FARGATE \
  --task-definition "$(terraform output -raw migrate_task_definition_arn)" \
  --network-configuration "awsvpcConfiguration={subnets=$(terraform output -json private_subnet_ids),securityGroups=[$(terraform output -raw service_security_group_id)],assignPublicIp=DISABLED}"
```

Watch `/facility/<environment>/migrate` in CloudWatch Logs for
`applied 0001_control_plane.sql` (or `already applied`) followed by the seed
summary. `facility doctor` will flag `seed_essentials` if this task did not run.

## 6. Bind the instance

`facility instance bootstrap` creates the organization, its owner, and the
GitHub account/installation binding that sign-in checks. The database is
reachable only from the service security group, so run it as a one-shot task
using this module's `migrate` task definition — the API image carries the CLI —
with a container override. The
[AWS deployment runbook](https://github.com/theam/facility/blob/main/apps/docs/docs/self-host/aws.md#6-bind-the-instance-to-your-github-organization)
has the exact invocation and the ids it needs.

Until this runs, every sign-in fails with `not_invited` or
`installation_access_required`.

## 7. Start and verify the services

Raise all five desired counts in `playground.tfvars`, apply the same file, and
wait for every service, including MCP:

```bash
terraform apply -var-file=playground.tfvars
aws ecs wait services-stable \
  --cluster "$(terraform output -raw ecs_cluster_name)" \
  --services api worker gateway web mcp
```

```bash
curl -fsS "https://${api_hostname}/health"
curl -fsS "https://${app_hostname}/"
```

For HTTP-only test deployments, use `http://` and the ALB DNS name with `Host`
headers until DNS is configured.

Repeated validation deployments can set
`target_deregistration_delay_seconds = 15` to avoid waiting the production
default of five minutes for every replaced API target. Keep the default `300`
for production unless all in-flight requests are safely bounded below the
shorter drain window.

## Validation status

The reference module has been checked with:

- `terraform init` / `validate` / `fmt -check` — pass.
- `terraform plan` using the example variables in HTTP-only mode without a
  domain.
- The `api` container image builds from the root `Dockerfile` and health-checks
  green in a container against Postgres; the same images back this stack.

A full `terraform apply` provisions ~89 billed resources (RDS, NAT gateway,
ALB, ECS services) — run it when you want a live environment, then
`build-images.sh` + the one-shot migrate task per the steps above. For an
ephemeral playground, set `enable_deletion_protection=false` and
`force_destroy_bucket=true`, apply `playground.tfvars`, remove the non-empty ECR
repositories, then destroy with that same variable file. The published
[deployment runbook](https://github.com/theam/facility/blob/main/apps/docs/docs/self-host/aws.md#repeated-deployments-and-teardown)
contains the exact, state-safe teardown commands.
