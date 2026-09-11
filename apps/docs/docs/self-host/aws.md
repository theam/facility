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

## Provisioned architecture

The Terraform module creates:

- a VPC with public load-balancer subnets and private ECS/RDS subnets;
- an Application Load Balancer with TLS routing for app and preview hostnames;
- ECS/Fargate task definitions and services for API, worker, and web;
- a one-shot ECS migration task definition;
- an encrypted RDS PostgreSQL instance with managed master credentials and backups;
- ECR repositories for API and web images;
- KMS-backed Secrets Manager runtime configuration;
- IAM roles limited to each service's AWS responsibilities; and
- CloudWatch log groups and ECS Container Insights.

The API serves MCP, webhooks, HTTP, and preview proxy traffic. The worker has no public listener.
Vercel hosts workspace compute, the configured runner image, and values injected for that story. It
does not host Facility's organization, budget, mirror, or audit database.

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

## Terraform inputs

Copy `terraform.tfvars.example` and set at least `app_hostname`, `preview_hostname`,
`acm_certificate_arn`, `workspace_image`, `vercel_team_id`, `vercel_project_id`, and
`facility_instance_id`. Use an immutable `image_tag` for each deployment.

Operational inputs include database class and storage, backup and log retention, CPU architecture,
allowed load-balancer CIDRs, project secret ARNs, and service desired counts. Deletion protection
is enabled by default. Review the module's `variables.tf` before every environment apply; do not
copy production values into a committed tfvars file.

## 1. Create the infrastructure shell

```bash
cd infra/terraform/aws
cp terraform.tfvars.example production.tfvars
terraform init
terraform apply -var-file=production.tfvars
```

Review the plan before apply. Keep Terraform state encrypted, access-controlled, locked, and backed
up. The module keeps secret values out of variables, but state still contains infrastructure
identifiers and policy-sensitive configuration.

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

The runner image is separate because Vercel, not ECS, pulls it. Build `runner/Dockerfile` with
`--target vercel-runner --platform linux/amd64`, publish it to the registry used by your Vercel
project, and put that exact image reference in `workspace_image`. This target starts as root for
trusted initialization and includes the SDK's `sudo` user-switch dependency. The default `runner`
target is for Docker workspaces.

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

Add or remove project secret ARN mappings through a reviewed Terraform plan. ECS task definitions
must be refreshed before API and worker receive a changed mapping. Removing an operator value makes
the next environment preparation fail without deleting the retained workspace.

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
is rejected without modification. Follow the [versioned upgrade
guide](../reference/upgrade-012.md) when the existing database is incompatible.

Inspect the stopped task's container exit code and CloudWatch migration log, not only the
`run-task` API response. A task accepted by ECS can still fail to pull the image, read the secret,
connect to RDS, or apply a migration.

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

Wait for each ECS service deployment to stabilize. Verify the load balancer target health for API
and web, and inspect worker startup logs even though it has no HTTP target group.

Configure the GitHub App webhook with the `github_webhook_url` output and connect MCP clients to
the `mcp_url` output. Then run the [workspace validation](../guides/validate-workspace-loop.md)
against a disposable repository or mirror.

Terraform outputs also provide the application, preview, MCP, and webhook URLs; ECR repository
URLs; runtime and database secret identifiers; cluster and migration task identifiers; private
subnets; and the service security group. Read sensitive outputs through an authorized operator
session and do not paste them into issues or CI logs.

## Deploy an update

1. Read the release notes and database compatibility boundary.
2. Confirm the latest RDS backup and Vercel workspace retention state.
3. Build API and web images from one Git commit for the configured CPU architecture.
4. Publish the runner image if its contents changed and update `workspace_image` by immutable tag or
   digest.
5. Apply Terraform with service counts unchanged so task definitions reference the new images and
   secret mappings.
6. Run the new migration task and require container exit code zero.
7. Apply or force new ECS deployments, then wait for API, worker, and web stability.
8. Run health, login, MCP, webhook, preview, and disposable-story checks.

Do not run mixed API and worker releases longer than the deployment transition. They share queue
and schema contracts.

## Rollback and recovery

If the database remains compatible, set `image_tag` and `workspace_image` back to the last known
good immutable references and redeploy all services. If migrations are incompatible, restore the
pre-deployment RDS backup to a controlled target and deploy the matching images; do not point an
old worker at a newer schema speculatively.

RDS backup does not contain Vercel workspaces. Retain and test Vercel snapshots separately. During
recovery, preserve the database mapping from story/workspace ids to Vercel provider references so
the restored control plane can locate the correct state.

For a failed ECS task, use the task stop reason, container reason and exit code, CloudWatch logs,
security-group reachability, secret permissions, and image architecture as primary evidence. For a
failed workspace, inspect Facility environment events and the Vercel provider reference before
changing the AWS services.

## Operations

ECS Container Insights and the four CloudWatch log groups cover infrastructure health and logs.
Facility's Insights page covers turn outcomes, token use, cost, budget state, workspace state,
GitHub delivery health, open attention, and audit activity. The Pipeline page is backed by webhook
updates plus ten-minute reconciliation.

Back up RDS and retain Vercel workspace snapshots according to your policy. Facility never deletes
a workspace because of age, merge, or budget state. Only an explicit workspace deletion removes
the worktree and native engine sessions.

Alert on unhealthy ALB targets, ECS deployment failure, worker queue age, RDS capacity and backup
failure, Secrets Manager access denial, Vercel quota or snapshot errors, GitHub reconciliation lag,
and missing cost data. Facility budget and analytics views complement AWS and Vercel billing; they
do not replace provider billing alarms.

## Teardown

Terraform deletion is an environment-wide destructive action. With deletion protection enabled,
the module refuses accidental removal of protected resources. Before an intentional teardown,
export or snapshot RDS, inventory Vercel workspaces, preserve required repository branches and
artifacts, revoke GitHub and OAuth credentials, and document how retained data will be recovered or
destroyed. Do not disable protection merely to make a failed apply pass.
