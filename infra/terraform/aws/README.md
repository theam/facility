# Facility AWS Terraform

This module provisions the AWS reference deployment from the platform architecture:
VPC, two private AZs, public ALB, RDS Postgres 16, S3 object storage, ECR,
ECS Fargate services for `api`, `worker`, `gateway`, `web`, and `mcp`, optional
CodeBuild jobs/Fargate preview tasks, KMS, Secrets Manager, and CloudWatch logs.
The production control plane can select Vercel Sandboxes and Vercel-hosted
preview routes without moving those long-running services from AWS.

Topology:

- `app_hostname` routes to the `web` ECS service through the public ALB.
- `api_hostname` routes to the `api` ECS service through the public ALB.
- `mcp_hostname` routes to the audience-bound MCP resource server.
- Protected previews use a dedicated AWS-assigned CloudFront HTTPS origin by
  default and still route to the existing API tasks. No preview DNS zone or
  certificate is required. As an advanced override, set `preview_hostname` to
  a separately registered site covered by the ALB certificate, and set
  `preview_route53_zone_id` when Terraform should create its alias record.
- `gateway` is normally reachable only inside the VPC through Cloud Map at the
  `gateway_internal_url` output. The Vercel sandbox mode additionally routes
  only its bearer-authenticated `/anthropic` and `/openai` provider paths
  through the existing API hostname.
- Postgres accepts `5432` only from the ECS service security group.
- With `sandbox_driver = "vercel"`, API and worker receive only the Vercel
  team/project binding and the generated Secrets Manager token reference. The
  default runner profile points at the project-scoped VCR image; CodeBuild and
  preview-task settings are not injected into the application tasks. Vercel
  sandboxes use the public API origin for authenticated model traffic rather
  than the private Cloud Map hostname.
- With `sandbox_driver = "aws"`, CodeBuild sandboxes run in private subnets and can reach the internal gateway.
  Their least-privilege service role has no Secrets Manager access. Runs always
  use the runner image fixed on the CodeBuild project; database-backed sandbox
  profiles cannot override that AWS-trusted image. Each Facility project gets
  an unguessable S3 prefix for its pnpm/npm dependency cache; the CodeBuild
  project's default is `NO_CACHE`, so a missing run override cannot share cache
  content across tenants.
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
- Set `app_hostname`, `api_hostname`, and `mcp_hostname`. Leave
  `preview_hostname = ""` for the module-owned HTTPS preview origin. Set it only
  when you already operate a separately registered preview site.
- Set `acm_certificate_arn` for HTTPS, or leave it empty for HTTP-only testing.
  When set, the ALB redirects every port 80 request to the same host, path, and
  query on HTTPS; only certificate-less deployments forward HTTP to services.
  In certificate-less validation stacks the preview viewer edge remains HTTPS,
  but CloudFront reaches the ALB over plaintext HTTP. Configure the certificate
  for production transport confidentiality.
  Certificate-less stacks intentionally omit Facility's interactive MCP OAuth issuer, signing-key
  injection, public resource URL, and authorization-server advertisement. The MCP listener remains
  available for validation with `fak_` API keys, but this plaintext mode must not carry real
  credentials or workloads. Configure ACM before enabling interactive MCP clients or using MCP
  operationally.
- Set `route53_zone_id` if Terraform should create alias records.
- Set `enable_cloudfront_api_endpoint = true` to get an AWS-managed HTTPS API
  and webhook URL without a public DNS zone. This is intended for validation;
  it requires `acm_certificate_arn = ""`. Use your own hostname and ACM
  certificate for production; Terraform rejects enabling both modes.
- Use the module-owned ECR release path below.
- Select direct `github` authentication for self-hosting or `oidc` for a SaaS
  broker. With ACM configured, MCP OAuth is issued by the dedicated Facility instance.
- Set a stable `facility_instance_id` so API and worker retain one sandbox
  ownership namespace across PostgreSQL endpoint moves. For commercial OIDC it
  must match the instance id registered with the identity broker.
- Set `github_oauth_allowed_organization` to a GitHub organization login when
  direct login must require active membership; leave it empty for no additional
  organization restriction.
- Set `enable_package_registry_token = true` only after populating the optional
  private package token; leave it false for public-package repositories.
- Select `sandbox_driver = "vercel"`, set its team/project ids and VCR runner
  image, then populate the generated `vercel_token` secret. Select `aws` only
  when validating the optional CodeBuild/Fargate provider.
- Tune `envelope_retention_days` for your data-retention policy.

The automated AWS release path deliberately deploys only from the ECR
repositories owned by this module. Leave service `image_overrides` empty and set
every `container_image_tags` entry to the commit tag that Step 3 will push before
the first apply. Public GHCR artifacts remain useful for other providers, but
they are not a direct input to `deploy:aws`: an AWS release must first exist in
this stack's ECR and have the exact manifest produced in Step 3. This preserves
an in-account digest existence check and one supported AWS release path.

`image_overrides` remains an advanced task-template escape hatch. The documented
flow uses it only to pin the privileged runner to the exact ECR digest after the
first build.

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
- `aws_region`
- `task_cpu_architecture`
- `secret_arns`
- `rds_endpoint`
- `rds_master_user_secret_arn`
- `preview_url`
- `ecs_cluster_name`
- `codebuild_runner_project_name`
- `migrate_task_definition_arn`
- `service_task_definition_arns`
- `private_subnet_ids`
- `service_security_group_id`

## 3. Build and push release images

This step is required because it creates the exact ECR manifest consumed by the
release gate. The web image reads `FACILITY_API_URL` when it runs, so one artifact
works for every deployment. Set it to a bare HTTP(S) origin with no credentials,
path, query, or fragment. From the module directory used above, build from the
repository root and return afterward:

```bash
cd ../../..
AWS_REGION=us-east-1 \
ECR_PREFIX="$(terraform -chdir=infra/terraform/aws output -raw ecs_cluster_name)" \
IMAGE_TAG=$(git rev-parse --short HEAD) \
./infra/build-images.sh
cd infra/terraform/aws
```

The script requires the Docker Buildx plugin and runs one Bake graph. The five
artifacts build concurrently. API and worker run the same API digest with
different commands, so the AWS fallback stores and scans those bytes once in the
`api` repository. API, gateway, and MCP also share the root Dockerfile dependency
graph. No registry-cache artifact is created: repeated builds reuse the operator's
local BuildKit cache, while ECR continues to scan only deployable image pushes.
The repository Docker context excludes Terraform providers and state created by
the preceding apply.

The graph builds `linux/amd64` by default, matching Terraform's default
`task_cpu_architecture = "X86_64"`. To deploy on Graviton, set
`CPU_ARCHITECTURE=ARM64` while building and set `task_cpu_architecture = "ARM64"`
in Terraform. The build exits before registry login if Buildx is unavailable or
an explicit `PLATFORM` conflicts with `CPU_ARCHITECTURE`.

The last output line is `manifest=<absolute path>`. That mode-`0600` JSON file
maps all six runtime roles to exact ECR digests and records the full source SHA
and platform. Keep the path for the deploy command; tags are build handles, not
the deployment identity.

The script rejects a dirty Git worktree so that this SHA identifies the bytes it
labels. Commit or stash release inputs first; reserve
`FACILITY_ALLOW_DIRTY_BUILD=1` for explicitly non-production experiments.

The privileged CodeBuild runner remains Terraform-owned. Copy the manifest's
exact `images.runner` digest reference into `image_overrides.runner` and apply
the same tfvars before deploying. Most application releases reproduce the same
runner digest and need no runner apply. When runner bytes change, the explicit
apply is a deliberate security boundary; the deploy command verifies the
CodeBuild project but never mutates it.

When `api_url` changes, update the web task's runtime `FACILITY_API_URL` and
redeploy the existing image; it does not need to be rebuilt.

Apply Terraform before the release command whenever a task template, service
configuration, or runner digest changed. Ordinary application-image changes do
not put Terraform on the hot path.

### Upgrade note: retire the duplicate worker repository

Stacks created before the API/worker deduplication have a non-empty `worker` ECR
repository in Terraform state. Preserve it through one rollback window instead
of asking Terraform to destroy stored images during an application upgrade. Before
the first apply of this version, remove only these legacy addresses from state:

```bash
terraform state rm 'aws_ecr_lifecycle_policy.service["worker"]'
terraform state rm 'aws_ecr_repository.service["worker"]'
```

This deliberately leaves the old AWS repository intact but unmanaged. Apply the
new configuration, deploy and verify worker on the API digest, then delete the
legacy repository manually after the rollback window. New stacks create only the
five unique artifact repositories. The `container_image_tags.worker` input remains
accepted for existing tfvars but is unused unless `image_overrides.worker` explicitly
selects a separate image.

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

## 5. Stage or deploy the release

The release command validates every image against this stack's ECR repositories
and architecture and waits for its cached ECR scan-on-push result. Basic scanning
remains fail-closed and rejects any HIGH or CRITICAL finding because it cannot
report whether an update exists. When `enable_ecr_enhanced_scanning = true`, the
module opts this account and region into paid Amazon Inspector scanning for only
`${project}-${environment}/*`. With enhanced scanning enabled, deployment rejects
every HIGH or CRITICAL finding whose `fixAvailable` value is `YES` or `PARTIAL`.
This matches the pinned Grype
`--only-fixed` promotion policy without maintaining a drifting CVE allowlist.
The preflight derives the active sandbox provider from Terraform. In `vercel`
mode it scans the four control-plane images but deliberately does not inspect or
compare the inactive CodeBuild runner: that image cannot execute in the release.
In `aws` mode, the runner digest and its scan remain mandatory.

The enhanced setting is registry-wide even though its repository filter is narrow.
Leave it disabled in a shared AWS account unless this stack owns the central ECR
scanning policy. Applying the opt-in requires
`ecr:PutRegistryScanningConfiguration` and may require `inspector2:Enable` when
Inspector has not already been activated. The deploying AWS principal needs
`ecr:DescribeImages` and `ecr:DescribeImageScanFindings`. It then verifies the
Terraform-owned CodeBuild runner digest, copies the freshly rendered Terraform
task templates, and replaces only their main container images. It runs the
one-shot database deploy task and waits for exit `0` before changing any service.
The five service updates run in parallel; a failed rollout restores all five prior task definitions
but never rolls back the database.

The wait budget is 12 minutes by default. Pass `--command-timeout-ms <milliseconds>`
(up to 3600000) when this stack's measured rollout time needs a larger bound.

For the first deployment, while all desired counts are deliberately zero:

```bash
pnpm --dir ../../.. deploy:aws \
  --manifest /absolute/path/from-build-images.json \
  --terraform-dir . \
  --allow-zero-desired
```

This produces a `status=staged` event: migration and digest pointers are ready,
but zero running tasks are not reported as healthy. Raise all five desired
counts in the next step. On later deployments, omit `--allow-zero-desired`; the
command waits for and verifies five healthy services. Exit `10` is a retryable
database-lock timeout, `11` is a changed applied migration, `12` is rolled-back
migration SQL, `21` means service rollback succeeded, and `22` means operator
intervention is required because service rollback was incomplete.

Treat this command as a single-writer operation: do not run it concurrently
from CI and an operator laptop. It rechecks all five service pointers after the
database gate and refuses observed drift, but ECS has no atomic compare-and-swap
across services. A CI wrapper must use one concurrency group per Facility
environment.

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

After the first staged deployment, raise all five desired counts in
`playground.tfvars`, apply the same file, and wait for every service, including
MCP. Terraform continues to own desired counts and service configuration while
preserving the digest-pinned live task pointers:

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
