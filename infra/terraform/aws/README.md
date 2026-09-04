# Facility AWS control plane

This module runs Facility's durable control plane on AWS while every story workspace runs on
Vercel Sandbox. It provisions one ALB, ECS services for API/MCP/webhooks, worker, and web, an RDS
PostgreSQL database, ECR repositories, Secrets Manager, and CloudWatch logs.

It does not provision a model gateway, CodeBuild sandboxes, preview tasks, or a separate metering
service. Cost controls, audit events, observability, GitHub mirroring, and the delivery pipeline are
handled by the API, worker, and PostgreSQL.

See the [AWS deployment guide](../../../apps/docs/docs/self-host/aws.md) for the complete bootstrap
and release sequence.

## Module contract

The first apply must keep `api_desired_count`, `worker_desired_count`, and
`web_desired_count` at zero. It creates ECR repositories, RDS, task definitions,
the load balancer, logging, and an empty runtime secret. Operators then:

1. build and push API and web images under the immutable `image_tag`;
2. publish the runner image for Vercel and set `workspace_image`;
3. populate the runtime secret and project secret ARN mappings;
4. run the migration task in private subnets and require exit code zero; and
5. raise service desired counts and apply again.

Copy `terraform.tfvars.example` outside committed source and review
`variables.tf` before applying. Required values include app and preview
hostnames, an ACM certificate, workspace image, Vercel team/project, and stable
Facility instance id. The preview hostname must use a different registered site
from the application hostname.

## Secrets and state

Terraform creates the encrypted runtime secret but never receives its value.
Store database, master key, Vercel, OAuth, GitHub App, and private MCP signing
values directly in Secrets Manager. Map project values through
`project_secret_arns` using exact
`FACILITY_PROJECT_<PROJECT_ID>_<NAME>` environment names.

Protect Terraform state as sensitive infrastructure metadata. Use encrypted
remote state, locking, restricted access, and backups. Never add production
tfvars or generated secret JSON to the repository.

## Validation

Run formatting, validation, and module tests before a plan:

```bash
terraform fmt -check -recursive
terraform init
terraform validate
terraform test
terraform plan -var-file=production.tfvars
```

Review replacements and deletions in the plan. Deletion protection is enabled
by default; do not disable it to make an unexpected plan pass.

After deployment, wait for ECS stability, check `application_url/readyz`,
inspect worker logs, configure the GitHub webhook from the output, connect MCP
at `mcp_url`, and run the disposable workspace acceptance guide.

## Recovery

RDS backup and Vercel workspace snapshots are separate recovery layers. Preserve
the database mapping from stories to Vercel provider references. Roll back all
API, worker, and web services together to one immutable version; when a schema
is incompatible, restore the matching pre-deployment database instead of
running old code against it.

An environment teardown is destructive across organizations, stories, and
control state. Snapshot RDS, inventory Vercel workspaces, preserve required Git
and artifact state, and revoke credentials before an intentional destroy.
