---
title: AWS control plane with Vercel workspaces
---

# AWS control plane with Vercel workspaces

The reference deployment keeps durable control-plane services in AWS and runs story workspaces in
Vercel Sandbox. AWS runs the web UI, API with embedded MCP and webhooks, one worker, PostgreSQL,
container storage, secrets, and logs. Vercel runs the complete development environment for each
story and retains its snapshots between compute sessions.

This deployment does not need CodeBuild, an internal model gateway, a separate scheduler, a
metering service, or preview containers. Scheduling, cost accounting, budgets, GitHub mirroring,
pipeline state, and operational analytics share the API, worker, and PostgreSQL.

## Prerequisites

- Terraform 1.8 or newer
- AWS credentials allowed to manage VPC, ECS, RDS, ECR, IAM, KMS, Secrets Manager, Route53, ACM,
  and CloudWatch resources
- an ACM certificate covering the app and preview hostnames
- a runner image in a registry that Vercel Sandbox can access
- a Vercel token, team id, and project id
- a GitHub App and GitHub OAuth application

The preview hostname must use a different registered site from the app hostname. This keeps
untrusted application JavaScript outside the control-plane cookie boundary.
If Route53 manages both names, set `route53_zone_id` for the app hostname and
`preview_route53_zone_id` for the preview hostname; they will normally identify different hosted
zones.

## 1. Create the infrastructure shell

```bash
cd infra/terraform/aws
cp terraform.tfvars.example production.tfvars
terraform init
terraform apply -var-file=production.tfvars
```

Leave `api_desired_count`, `worker_desired_count`, and `web_desired_count` at zero on this first
apply. Terraform creates the ECR repositories and runtime secret before any service tries to pull
an image.

## 2. Build the control-plane images

Use an immutable tag such as the full Git commit. Replace the two repository values with
`terraform output -json ecr_repository_urls`:

```bash
TAG="$(git rev-parse HEAD)"
API_REPOSITORY="123456789012.dkr.ecr.us-east-1.amazonaws.com/facility-production/api"
WEB_REPOSITORY="123456789012.dkr.ecr.us-east-1.amazonaws.com/facility-production/web"

aws ecr get-login-password --region us-east-1 |
  docker login --username AWS --password-stdin "${API_REPOSITORY%%/*}"
docker buildx build --platform linux/amd64 --target api --tag "$API_REPOSITORY:$TAG" --push ../../..
docker buildx build --platform linux/amd64 --file ../../../apps/web/Dockerfile \
  --target web --tag "$WEB_REPOSITORY:$TAG" --push ../../..
```

Set `image_tag` to the same value in `production.tfvars`. If the ECS tasks use ARM64, build both
images for `linux/arm64` and set `task_cpu_architecture = "ARM64"`.

The runner image is separate because Vercel, not ECS, pulls it. Build `runner/Dockerfile`, publish
it to the registry used by your Vercel project, and put that exact image reference in
`workspace_image`.

## 3. Populate the runtime secret

Terraform creates one encrypted JSON secret and does not write secret values. Obtain its ARN with
`terraform output -raw runtime_secret_arn`. Store these keys in it:

```json
{
  "DATABASE_URL": "postgres://facility:encoded-password@database-endpoint:5432/facility?sslmode=verify-full",
  "SECRET_MASTER_KEY": "32-byte-base64-value",
  "VERCEL_TOKEN": "vercel-token",
  "GITHUB_OAUTH_CLIENT_ID": "github-oauth-client-id",
  "GITHUB_OAUTH_CLIENT_SECRET": "github-oauth-client-secret",
  "GITHUB_APP_ID": "github-app-id",
  "GITHUB_APP_PRIVATE_KEY": "pem-private-key",
  "GITHUB_APP_WEBHOOK_SECRET": "webhook-secret",
  "GITHUB_APP_SLUG": "github-app-slug",
  "FACILITY_OAUTH_JWKS": "private-es256-jwk-set"
}
```

Use the password in `database_master_secret_arn` when building `DATABASE_URL`. URL-encode that
password and keep `sslmode=verify-full`. Write the JSON to a mode-0600 temporary file, upload it
with `aws secretsmanager put-secret-value --secret-string file://...`, then remove the local file.
Do not place secret values in Terraform variables or state.

Engine and repository secrets remain project-scoped. Create one Secrets Manager secret per value
and add its ARN to `project_secret_arns` under the environment name generated from the project id,
for example `FACILITY_PROJECT_PROJ_EXAMPLE_ANTHROPIC_API_KEY`.

## 4. Run the database migration

Run the migration task inside the private subnets after the API image exists. The required values
are available from `ecs_cluster_name`, `migrate_task_definition_arn`, `private_subnet_ids`, and
`service_security_group_id`:

```bash
aws ecs run-task \
  --cluster facility-production \
  --launch-type FARGATE \
  --task-definition "<migrate-task-definition-arn>" \
  --network-configuration 'awsvpcConfiguration={subnets=[<private-subnet-1>,<private-subnet-2>],securityGroups=[<service-security-group>],assignPublicIp=DISABLED}'
```

Wait for the task to stop and require exit code zero before starting the services. A 0.11 database
is rejected without modification; 0.12 needs a new database.

## 5. Start and verify the services

Set the desired counts and apply again:

```hcl
api_desired_count    = 2
worker_desired_count = 1
web_desired_count    = 2
```

```bash
terraform apply -var-file=production.tfvars
curl --fail "https://facility.example.com/readyz"
```

Configure the GitHub App webhook with the `github_webhook_url` output and connect MCP clients to
the `mcp_url` output. Then run the [workspace validation](../guides/validate-workspace-loop.md)
against a disposable repository or mirror.

## Operations

ECS Container Insights and the four CloudWatch log groups cover infrastructure health and logs.
Facility's Insights page covers turn outcomes, token use, cost, budget state, workspace state,
GitHub delivery health, open attention, and audit activity. The Pipeline page is backed by webhook
updates plus ten-minute reconciliation.

Back up RDS and retain Vercel workspace snapshots according to your policy. Facility never deletes
a workspace because of age, merge, or budget state. Only an explicit workspace deletion removes
the worktree and native engine sessions.
