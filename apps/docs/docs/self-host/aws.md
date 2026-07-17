---
title: AWS (Terraform)
---

# AWS reference deployment

`infra/terraform/aws` provisions the reference production stack — the same
one the platform's own validation deployment runs on:

- VPC (2 AZ), private subnets for services and RDS
- RDS Postgres 16, S3 bucket (envelopes/transcripts), ECR repositories
- ECS Fargate services: `api`, `worker`, `gateway`, `web` behind an ALB
- Fargate runner tasks for the `aws` sandbox driver
- KMS-backed secrets (`SECRET_MASTER_KEY` and friends) into task env
- CloudWatch log groups per service

```bash
cd infra/terraform/aws
terraform init
terraform apply -var-file=yourorg.tfvars
```

The variables file names the domain, the WorkOS and GitHub App credentials
(by secret ARN, not value), instance sizes, and the container image tags —
build and push images with the repo's `infra/build-images.sh`.

Any-cloud note: nothing in the services is AWS-specific — this module is a
reference, not a requirement. The sandbox driver seam (`docker` | `aws`) is
where compute specifics live; a Kubernetes Job driver is the documented
extension point.

Once images and the `database_url` secret are populated, run the one-shot
migrate + seed task (it applies migrations **and** seeds the bundled roles,
action types, and default sandbox profile that first bootstrap and `facility
doctor` require — it is idempotent). See the module
[README](https://github.com/theam/facility/tree/main/infra/terraform/aws#5-run-the-migrate--seed-task-once)
for the exact `aws ecs run-task` invocation.

After the ECS services roll and the migrate+seed task has completed, run:

```bash
node packages/cli/bin/facility.mjs doctor --url https://<api-host> --key fak_...
```

Do not send production traffic until the doctor reports no `FAIL` checks — it
verifies DB migrations, object storage, seed essentials, the `sandbox_runner`
profile (driver + runner), production `auth_config`, and the audit hash chain.
