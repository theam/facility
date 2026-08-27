---
title: AWS (Terraform)
---

# AWS reference deployment

`infra/terraform/aws` provisions the reference production stack:

- VPC (2 AZ), private subnets for services and RDS
- RDS Postgres 16, S3 bucket (envelopes/transcripts), ECR repositories
- ECS Fargate services: `api`, `worker`, `gateway`, `web`, `mcp` behind an ALB
- ephemeral, privileged CodeBuild jobs for the `aws` sandbox driver
- unprivileged, per-image ECS Fargate tasks for private preview services
- KMS-backed secrets into task environments
- CloudWatch log groups per service

CodeBuild privileged mode is required because repository provisioning may start
Docker containers (for example, local Supabase). Each build runs in the private
subnets with the sandbox security group. Its service role can pull the runner
image, write its own logs, and manage its VPC network interface; it cannot read
Facility's Secrets Manager values.

Privileged mode belongs to the outer CodeBuild host, not to repository code.
The runner starts Docker rootless under a dedicated UID and exposes only a
policy proxy to agent commands. The proxy denies privileged/host-namespace
containers, devices, added capabilities, daemon administration, and host binds
outside `/work` (plus its own restricted socket). The lifecycle runner keeps its
run token under a different UID, and link-local metadata egress is blocked.

Set a stable `facility_instance_id` in the Terraform variables for every
long-lived stack. The API and worker use the same value when identifying owned
sandboxes, so a later PostgreSQL endpoint move does not change that boundary.
Commercial OIDC deployments must use the instance id registered with the
identity broker.

Agent dependency downloads use CodeBuild's S3 cache because AWS local caches
are unavailable for VPC builds. Facility derives an unguessable partition from
the organization and project, then supplies a separate S3 prefix for that run.
The CodeBuild project itself defaults to `NO_CACHE`, so an omitted override
cannot fall back to a cache shared across tenants. Only the pnpm
content-addressed store and npm `_cacache` are retained; workspaces, credentials,
browser executables, Supabase state, and Docker data are excluded.

Preview services stay on Fargate because the authenticated Facility proxy needs
to reach their private port. They use a dedicated task role with no permissions
and a narrowly scoped execution role for image pull and CloudWatch logs. The API
registers only the requested immutable preview definition and destroys it with
the task. Failed/lost previews retain their reference until reconciliation has
also deregistered that definition; this path is separate from the privileged
agent runner.

Nothing in the services is AWS-specific — this module is a reference, not a
requirement. The sandbox driver seam (`docker` | `aws`) is where compute
specifics live; a Kubernetes Job driver is the documented extension point.

This page is the deployment sequence. The module
[README](https://github.com/theam/facility/tree/main/infra/terraform/aws) is
the variable-by-variable reference.

## Before you start

Locally: Node.js 22 or newer, pnpm 11, Docker with `buildx`, Terraform, the AWS
CLI, `jq`, and OpenSSL. Fresh AWS credentials — an old `.env` may carry an
expired session token, so confirm with `aws sts get-caller-identity` before
applying anything.

On GitHub: the App configured for both human OAuth and repository automation,
then installed on the repositories you will automate, with its webhook
**inactive**. Installation gives you the id bootstrap needs; bootstrap records
that binding directly, so the initial `installation` event is not required. The
webhook is activated and tested only after the API is reachable. See the
[GitHub App guide](github-app).

Somewhere safe: Terraform state. Local state is acceptable only for a
short-lived stack, and only if you keep it until teardown.

Never reuse a destroyed environment's name, state, VPC CIDR, bucket, ECR
repositories, or webhook URL.

```bash
git switch main && git pull --ff-only
corepack enable && pnpm install --frozen-lockfile

export FACILITY_AWS_REGION=us-east-1
export FACILITY_ENV="prod"
export FACILITY_IMAGE_TAG="$(git rev-parse --short HEAD)"
export FACILITY_TF_DIR=infra/terraform/aws
export FACILITY_RELEASE_MANIFEST="$PWD/.tmp/facility-aws-release-$(git rev-parse HEAD).json"
```

## 1. Write the variables file, with services at zero

```bash
cp $FACILITY_TF_DIR/terraform.tfvars.example $FACILITY_TF_DIR/${FACILITY_ENV}.tfvars
```

Set `aws_region` and `environment` to the values exported above, set the
hostnames, and select `auth_identity_provider = "github"` for self-hosting. A
tfvars filename does not set Terraform's `environment` variable, so do not
leave the copied `playground` value behind.

Set `enable_ecr_enhanced_scanning = true` only when this stack owns the ECR
scanning policy for the AWS account and Region. This is a paid Amazon Inspector
integration and changes the registry-wide scan type, although its on-push filter
is limited to this stack's `${project}-${environment}/*` repositories. Leave it
false in a shared account whose registry scanning policy is managed centrally.
Applying the opt-in requires `ecr:PutRegistryScanningConfiguration` and may
require `inspector2:Enable` when Inspector has not already been activated.

To limit direct GitHub login to active members of one organization, set
`github_oauth_allowed_organization` to its login. Leave it empty to preserve
Facility's invitation and App-installation checks without an additional
organization restriction.

The automated AWS release path deliberately deploys only from the ECR
repositories owned by this module. Leave service `image_overrides` empty and set
every `container_image_tags` entry to `FACILITY_IMAGE_TAG` before applying.
Public GHCR artifacts remain useful for other providers, but they are not a
direct input to `deploy:aws`: an AWS release must first exist in this stack's ECR
and have the exact manifest produced in Step 3. This preserves an in-account
digest existence check and one supported AWS release path.

`image_overrides` remains an advanced task-template escape hatch. This runbook
uses it only to pin the privileged runner to the exact ECR digest after the first
build.

Start with — deliberately — no running services:

```hcl
aws_region  = "us-east-1" # same value as FACILITY_AWS_REGION
environment = "prod"      # same value as FACILITY_ENV

api_desired_count     = 0
worker_desired_count  = 0
gateway_desired_count = 0
web_desired_count     = 0
mcp_desired_count     = 0
```

The first apply creates repositories, the database, secret containers, the
network, task definitions and the load balancer **without** starting containers
before their secrets exist. On the build path it also creates the repositories
that Step 3 populates. Starting services early produces a crash-loop that is
slower to diagnose than it is to avoid.

If this state predates API/worker image deduplication, preserve its non-empty
`worker` ECR repository through a rollback window rather than letting Terraform
try to destroy it during the upgrade. Before the first apply of this version:

```bash
terraform -chdir="$FACILITY_TF_DIR" state rm \
  'aws_ecr_lifecycle_policy.service["worker"]'
terraform -chdir="$FACILITY_TF_DIR" state rm \
  'aws_ecr_repository.service["worker"]'
```

This removes only Terraform ownership; it does not delete the legacy repository
or its images. Apply and verify worker on the API digest, then delete that orphaned
repository manually after the rollback window. New stacks create five unique
artifact repositories. The legacy `container_image_tags.worker` tfvars field stays
accepted; only an explicit `image_overrides.worker` keeps worker on separate bytes.

Without a public DNS zone, clear the example's fake certificate and hosted-zone
values as well as enabling the AWS-managed HTTPS origin:

```hcl
acm_certificate_arn           = ""
route53_zone_id               = ""
enable_cloudfront_api_endpoint = true
```

The CloudFront validation endpoint and an ALB certificate are mutually
exclusive because CloudFront uses the certificate-less HTTP listener as its
origin. Terraform rejects enabling both.

For production, leave the CloudFront validation endpoint disabled, point
`api_hostname` at the ALB with a real certificate, and set `route53_zone_id`
only when Terraform should create the alias record. With an ACM certificate,
the port 80 listener preserves the host, path, and query while redirecting every
request to HTTPS; it never forwards plaintext traffic to a Facility service.
Certificate-less testing retains direct HTTP forwarding.
In that validation-only mode, the browser-to-CloudFront hop is HTTPS but the
CloudFront-to-ALB hop is plaintext HTTP. Configure the ALB certificate for
production transport confidentiality. The module disables interactive MCP OAuth in this mode:
the MCP listener remains available for validation with scoped `fak_` API keys, but neither the API
nor MCP service receives `MCP_PUBLIC_URL`, and Facility injects no `FACILITY_OAUTH_ISSUER`,
`FACILITY_OAUTH_JWKS`, or authorization-server advertisement. Do not send real credentials or
workloads over this plaintext validation mode. Add ACM and apply the Terraform configuration before
deploying OAuth-capable images; then reconnect every interactive client because the web-origin
issuer and canonical `/mcp` audience invalidate legacy OAuth sessions.

Protected previews use a dedicated AWS-assigned CloudFront HTTPS origin by
default. Keep `preview_hostname = ""`; Terraform creates the distribution,
restricts its ALB ingress to CloudFront, and prints `preview_url`. This needs no
additional domain, DNS zone, or certificate. The distribution forwards only
browser-safe methods and marks requests with an unguessable value checked by
the API, so direct control-plane requests cannot select the preview surface.

If you already operate a custom preview site, set `preview_hostname` to that
separately registered site and cover it with the ALB certificate. Set
`preview_route53_zone_id` when Terraform should create its alias; otherwise
create the DNS record externally. Do not use a sibling of the app/API site.
Production tasks reject a missing, HTTP, or control-plane-hosted preview URL.

No secret values belong in tfvars. The file is gitignored; keep it that way.

## 2. First apply

```bash
terraform -chdir="$FACILITY_TF_DIR" init
terraform -chdir="$FACILITY_TF_DIR" apply -var-file="${FACILITY_ENV}.tfvars"
```

## 3. Build and push release images

This step is required because it creates the exact ECR manifest consumed by the
release gate. The web image reads `FACILITY_API_URL` at runtime, so the same
artifact works for every deployment. Set it to the deployment's bare HTTP(S)
`api_url` origin, with no credentials, path, query, or fragment.

The build script defaults to a playground prefix, so `ECR_PREFIX` is mandatory:

```bash
AWS_REGION="$FACILITY_AWS_REGION" \
ECR_PREFIX="$(terraform -chdir="$FACILITY_TF_DIR" output -raw ecs_cluster_name)" \
IMAGE_TAG="$FACILITY_IMAGE_TAG" \
CPU_ARCHITECTURE=X86_64 \
MANIFEST_PATH="$FACILITY_RELEASE_MANIFEST" \
./infra/build-images.sh
```

Never `latest`: the tag in tfvars must match `FACILITY_IMAGE_TAG` exactly, so
that what is deployed is identifiable from a commit. Deriving `ECR_PREFIX` from
Terraform keeps the pushed repositories aligned with the selected project and
environment.

The script requires the Docker Buildx plugin and builds all five artifacts in one
parallel Bake graph. API and worker use the same API digest from one ECR repository;
the ECS services still keep separate commands, roles, scaling, and deployment
lifecycles. Repeated runs reuse the local BuildKit cache and do not create an extra
registry-cache artifact. Terraform provider and state files from the preceding
apply are excluded from the Docker context.

The script writes a mode-`0600` release manifest at
`FACILITY_RELEASE_MANIFEST`. It contains the full source SHA, platform, and exact
ECR digest for all six runtime roles. Deployment never resolves the build tags.

The script rejects a dirty Git worktree so that this SHA identifies the bytes it
labels. Commit or stash release inputs first; reserve
`FACILITY_ALLOW_DIRTY_BUILD=1` for explicitly non-production experiments.

The privileged CodeBuild runner is intentionally not changed by the fast deploy
command. Copy this exact value into `image_overrides.runner` in the tfvars file,
then apply again with all service counts still at zero:

```bash
jq -r '.images.runner' "$FACILITY_RELEASE_MANIFEST"
terraform -chdir="$FACILITY_TF_DIR" apply -var-file="${FACILITY_ENV}.tfvars"
```

That apply is needed only when runner bytes change. It keeps the sandbox host a
reviewed Terraform change while ordinary API/web releases remain on the fast
path. The deploy command fails closed if the CodeBuild project and manifest
runner digests differ.

When `api_url` changes, update the web task's runtime `FACILITY_API_URL` and
redeploy the existing image; it does not need to be rebuilt.

## 4. Populate the secret containers

Terraform creates encrypted containers and never writes values into them.

| Secret | Value |
|---|---|
| `database_url` | `postgres://facility:<url-encoded-password>@<rds_endpoint>:5432/facility?sslmode=verify-full` |
| `secret_master_key` | `openssl rand -base64 32` |
| `github_oauth_client_id`, `github_oauth_client_secret` | the App's OAuth credentials (`oidc_client_id` / `oidc_client_secret` in broker mode) |
| `facility_oauth_jwks` | a persistent private ES256 JWK set |
| `github_app_id`, `github_app_slug`, `github_app_private_key`, `github_app_webhook_secret` | from the App |
| `package_registry_token` | optional classic PAT with only `read:packages`, for private GitHub npm packages |

`dev_anthropic_api_key` and `dev_openai_api_key` are a local fallback only —
add provider credentials through Facility after boot instead.

The trusted API releases `package_registry_token` through the runner's one-shot
authenticated handshake only when a run declares `.facility.json`'s
`packageInstall` phase. The CodeBuild role cannot read the secret from AWS. The
runner writes a temporary user-level npm config for that install child, deletes
it afterward, and does not pass the token to provisioning scripts, acceptance
checks, Claude, or Codex. Set `enable_package_registry_token = true` only after
populating the secret; leave it false for repositories that use public packages.

Keep `sslmode=verify-full`. The production image carries Amazon's global RDS CA
bundle so the API and worker verify the database certificate and hostname; a
non-verifying mode is a downgrade, not a shortcut.

```bash
facility_secret_arn() {
  terraform -chdir="$FACILITY_TF_DIR" output -json secret_arns | jq -r --arg n "$1" '.[$n]'
}
facility_put_secret_from_stdin() {
  aws secretsmanager put-secret-value --region "$FACILITY_AWS_REGION" \
    --secret-id "$(facility_secret_arn "$1")" \
    --secret-string file:///dev/stdin >/dev/null
}
facility_prompt_secret() {
  local facility_secret_name="$1" facility_secret_value
  printf 'Value for %s: ' "$facility_secret_name" >&2
  IFS= read -r -s facility_secret_value
  printf '\n' >&2
  printf '%s' "$facility_secret_value" | facility_put_secret_from_stdin "$facility_secret_name"
  unset facility_secret_value
}
```

The helpers read secret material from standard input, keeping it out of the AWS
CLI process arguments. Populate every required value; creating an empty secret
container is not enough for an ECS task to start.

The RDS master password lives in its own managed secret. Build and store the URL
without printing the password:

```bash
FACILITY_RDS_PASSWORD="$(
  aws secretsmanager get-secret-value \
    --region "$FACILITY_AWS_REGION" \
    --secret-id "$(terraform -chdir="$FACILITY_TF_DIR" output -raw rds_master_user_secret_arn)" \
    --query SecretString --output text | jq -r .password
)"
FACILITY_RDS_ENDPOINT="$(terraform -chdir="$FACILITY_TF_DIR" output -raw rds_endpoint)"
FACILITY_DATABASE_URL="postgres://facility:$(printf '%s' "$FACILITY_RDS_PASSWORD" | jq -sRr @uri)@${FACILITY_RDS_ENDPOINT}:5432/facility?sslmode=verify-full"
printf '%s' "$FACILITY_DATABASE_URL" | facility_put_secret_from_stdin database_url
unset FACILITY_RDS_PASSWORD FACILITY_DATABASE_URL
```

For a new instance, generate the encryption key and the private ES256 signing
set directly into Secrets Manager:

```bash
openssl rand -base64 32 | tr -d '\n' | facility_put_secret_from_stdin secret_master_key

node --input-type=module <<'NODE' | facility_put_secret_from_stdin facility_oauth_jwks
import { randomUUID, webcrypto } from "node:crypto";
const pair = await webcrypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);
const key = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
Object.assign(key, { alg: "ES256", kid: randomUUID(), use: "sig" });
process.stdout.write(JSON.stringify({ keys: [key] }));
NODE
```

Enter the remaining one-line values without echoing them, then load the App's
multiline private key from its protected file:

```bash
for FACILITY_SECRET_NAME in \
  github_oauth_client_id github_oauth_client_secret \
  github_app_id github_app_slug github_app_webhook_secret; do
  facility_prompt_secret "$FACILITY_SECRET_NAME"
done
unset FACILITY_SECRET_NAME

facility_put_secret_from_stdin github_app_private_key < /secure/path/to/github-app.private-key.pem
```

On later deployments, reuse `secret_master_key` and `facility_oauth_jwks`;
regenerating them breaks stored ciphertext and outstanding OAuth tokens. Never
print secret values or commit `.env`, tfvars, state, or private-key files.

## 5. Stage the digest-pinned release and database gate

One command now replaces the manual register/run/wait/update sequence. It checks
that every digest exists in this stack's ECR and waits for its cached scan-on-push
result. Basic scanning rejects any HIGH or CRITICAL finding because it cannot
report whether an update exists. Inspector-backed enhanced scanning rejects every
HIGH or CRITICAL finding whose `fixAvailable` value is `YES` or `PARTIAL`; a
missing or inconsistent enhanced result also fails closed. It then verifies
architecture and the Terraform-owned runner, registers task revisions from the
exact Terraform templates, and runs the database deploy task. The deploying AWS
principal therefore needs `ecr:DescribeImages` and
`ecr:DescribeImageScanFindings`; only an exit-`0` database gate can advance to the
five parallel service pointer updates.

The wait budget is 12 minutes by default. Pass `--command-timeout-ms <milliseconds>`
(up to 3600000) when this stack's measured rollout time needs a larger bound.

For first bootstrap, the pointers are staged while all desired counts are zero.
The command reports `status=staged`, never a false healthy deployment:

```bash
FACILITY_CLUSTER="$(terraform -chdir="$FACILITY_TF_DIR" output -raw ecs_cluster_name)"
FACILITY_MIGRATE_DEF="$(terraform -chdir="$FACILITY_TF_DIR" output -raw migrate_task_definition_arn)"
FACILITY_SUBNETS="$(terraform -chdir="$FACILITY_TF_DIR" output -json private_subnet_ids | jq -r 'join(",")')"
FACILITY_SERVICE_SG="$(terraform -chdir="$FACILITY_TF_DIR" output -raw service_security_group_id)"
FACILITY_NETWORK="awsvpcConfiguration={subnets=[${FACILITY_SUBNETS}],securityGroups=[${FACILITY_SERVICE_SG}],assignPublicIp=DISABLED}"

facility_wait_for_task() {
  local facility_task_arn="$1" facility_exit_code
  aws ecs wait tasks-stopped --region "$FACILITY_AWS_REGION" \
    --cluster "$FACILITY_CLUSTER" --tasks "$facility_task_arn"
  facility_exit_code="$(aws ecs describe-tasks --region "$FACILITY_AWS_REGION" \
    --cluster "$FACILITY_CLUSTER" --tasks "$facility_task_arn" \
    --query 'tasks[0].containers[?name==`migrate`].exitCode | [0]' --output text)"
  if [ "$facility_exit_code" != "0" ]; then
    printf 'ECS task failed with exit code %s; inspect /facility/%s/migrate in CloudWatch.\n' \
      "$facility_exit_code" "$FACILITY_ENV" >&2
    return 1
  fi
}

pnpm deploy:aws \
  --manifest "$FACILITY_RELEASE_MANIFEST" \
  --terraform-dir "$FACILITY_TF_DIR" \
  --allow-zero-desired
```

If the command returns nonzero, do not continue. Exit `10` is a lock timeout and
is retried once automatically; `11` identifies a changed applied migration;
`12` identifies migration SQL that rolled back. No service is changed for any
database failure. Exit `21` means an unhealthy application rollout was fully
restored; `22` requires intervention because restoration was incomplete.
Successful stdout is newline-delimited `facility.aws.deploy` timing and revision
evidence. Database phase detail remains in `/facility/<environment>/migrate`.

## 6. Bind the instance to your GitHub organization

Every instance is dedicated to one Facility organization, one GitHub account and
one App installation, and sign-in admits only explicitly provisioned members.
Until that binding exists, every login fails with `not_invited` or
`installation_access_required` — correctly, but confusingly.

The database accepts connections only from the service security group, so the
binding is created from inside the VPC. The API image carries the CLI for
exactly this, and the `migrate` task definition already has `DATABASE_URL`:

```bash
gh api /user --jq .id                  # your GitHub user id
gh api /orgs/<org> --jq .id            # the account id (/users/<login> for a personal account)
# the installation id is the last path segment of
# https://github.com/organizations/<org>/settings/installations/<id>

FACILITY_TASK="$(aws ecs run-task --region "$FACILITY_AWS_REGION" \
  --cluster "$FACILITY_CLUSTER" --launch-type FARGATE \
  --task-definition "$FACILITY_MIGRATE_DEF" \
  --network-configuration "$FACILITY_NETWORK" \
  --overrides '{"containerOverrides":[{"name":"migrate","command":[
    "facility","instance","bootstrap",
    "--org-name","My Org","--org-slug","my-org",
    "--owner-email","you@example.com","--owner-name","Your Name",
    "--github-user-id","<user id>","--github-login","<login>",
    "--github-account-id","<account id>","--github-account-login","<org login>",
    "--github-installation-id","<installation id>",
    "--github-account-type","organization","--json"]}]}' \
  --query 'tasks[0].taskArn' --output text)"

facility_wait_for_task "$FACILITY_TASK"
```

For a personal-account installation, use the `/users/<login>` lookup, the
account login, and `--github-account-type user`. Then read the log stream:
`{"ok":true,"created":true,...}` on the first run and `"created":false` on
any later one. The command takes an advisory lock, is idempotent for the same
binding, and refuses to modify a database already bound to a different instance.
In the API image, the `facility` wrapper then reruns the same idempotent database
deployment entry point before the task exits. That second reconciliation is
intentional: the first migration task ran before the organization existed, while
sandbox profiles, action types, and bundled contracts are organization-scoped.

That refusal is also the one failure worth recognising in advance:
`bootstrap_failed: Database already contains a different Facility instance`
means something already created an organization — most often a seed run with
demo data. The reference `migrate` task sets `FACILITY_SEED_DEMO=0` precisely so
that this step owns the first organization; keep it that way.

Unlike earlier revisions of this runbook, no operator API key is injected by
hand. You sign in through the browser as the bound owner and issue the first key
under **Settings → API keys**. The CLI and REST endpoint require an existing
credential, so they cannot issue that first key.

## 7. Start the services

Raise all five desired counts in the same tfvars file, apply, and wait:

```bash
terraform -chdir="$FACILITY_TF_DIR" apply -var-file="${FACILITY_ENV}.tfvars"

aws ecs wait services-stable --region "$FACILITY_AWS_REGION" \
  --cluster "$FACILITY_CLUSTER" --services api worker gateway web mcp

FACILITY_API_URL="$(terraform -chdir="$FACILITY_TF_DIR" output -raw api_url)"
curl --fail --silent --show-error "$FACILITY_API_URL/health"
```

Then sign in at the `app_hostname` with GitHub, issue the first API key under
**Settings → API keys**, and save it through the CLI's hidden prompt. Let the
doctor judge the deployment rather than judging it yourself:

```bash
node packages/cli/bin/facility.mjs login --url "$FACILITY_API_URL"
node packages/cli/bin/facility.mjs doctor --platform
```

Do not send traffic until it reports no `FAIL`. It verifies migrations, object
storage, seed essentials, the `sandbox_runner` profile, the production
`auth_config`, the GitHub App private key, and the audit hash chain. On AWS it
also makes one read-only CodeBuild call to verify that the configured project is
reachable through the task role, has a runner image, and keeps its shared cache
disabled. Transient AWS service errors are warnings; missing configuration,
credentials, permission, project, image, isolated cache location, or fail-closed
cache setting fail readiness.

Add provider credentials under **Settings → Providers** rather than enabling
the gateway's development fallback or placing a provider secret in command-line
arguments.

## 8. Activate the webhook last

Only once health and doctor pass. GitHub does not invent the webhook URL — it
comes from the public API origin:

```bash
terraform -chdir="$FACILITY_TF_DIR" output -raw github_webhook_url
```

In the App's settings: replace the URL with that exact value, keep
`GITHUB_APP_WEBHOOK_SECRET` identical on both sides, enable **Active**, and keep
SSL verification on. Confirm the subscriptions — `check_run`,
`deployment_status`, `issue_comment`, `issues`, `pull_request`,
`pull_request_review`, `push`, `workflow_run` — then use **Advanced → Recent
deliveries** to create or redeliver a test event and require a `2xx` before
invoking an agent.

If you are replacing an old environment, its URL is gone. Never reactivate the
App against it.

## Repeated deployments and teardown

Build the new manifest, apply Terraform first when configuration or the runner
digest changed, then run the same deploy command without the bootstrap flag:

```bash
AWS_REGION="$FACILITY_AWS_REGION" \
ECR_PREFIX="$(terraform -chdir="$FACILITY_TF_DIR" output -raw ecs_cluster_name)" \
IMAGE_TAG="$(git rev-parse --short HEAD)" \
MANIFEST_PATH="$FACILITY_RELEASE_MANIFEST" \
./infra/build-images.sh

pnpm deploy:aws \
  --manifest "$FACILITY_RELEASE_MANIFEST" \
  --terraform-dir "$FACILITY_TF_DIR"
```

Terraform owns task templates, desired counts, and durable infrastructure. The
deploy command owns only the live digest-pinned task revisions and service
pointers. It rejects a concurrent ECS rollout, runs the migration/reconciliation
gate, updates all five services in parallel, waits for stability, and verifies
the final task-definition images. New migrations are CI-gated to additive
expand changes so the prior application remains valid during automatic service
rollback; destructive contract migrations require a later, explicitly designed
release procedure.

Run only one deploy command per Facility environment at a time. The command
rechecks all five pointers after migration and rejects observed drift, but it is
not a distributed lock across ECS services. Configure any CI wrapper with one
non-cancelling concurrency group per environment, and never race it from a
laptop. A Terraform template change also becomes live only after this deploy
command copies the newly applied template into a digest-pinned revision.

For validation stacks, `target_deregistration_delay_seconds = 15` avoids waiting
the production default of five minutes for every replaced API target. Keep the
default `300` in production unless in-flight requests are safely bounded below
the shorter drain window.

A full apply provisions roughly 89 billed resources. For an ephemeral stack,
set `enable_deletion_protection = false` and `force_destroy_bucket = true` in
the same tfvars file, apply those settings, and destroy from the module with the
same variables:

```bash
terraform -chdir="$FACILITY_TF_DIR" apply -var-file="${FACILITY_ENV}.tfvars"

# Terraform protects non-empty ECR repositories. Remove all five repositories
# and their images explicitly; destroy will reconcile them out of state.
while IFS= read -r FACILITY_ECR_URL; do
  FACILITY_ECR_REPOSITORY="${FACILITY_ECR_URL#*/}"
  aws ecr delete-repository --region "$FACILITY_AWS_REGION" \
    --repository-name "$FACILITY_ECR_REPOSITORY" --force >/dev/null
done < <(terraform -chdir="$FACILITY_TF_DIR" output -json ecr_repository_urls | jq -r '.[]')
unset FACILITY_ECR_URL FACILITY_ECR_REPOSITORY

terraform -chdir="$FACILITY_TF_DIR" destroy -var-file="${FACILITY_ENV}.tfvars"
```

Keep the state until destroy completes. Verify against the service APIs and an
empty Terraform state rather than the Resource Groups Tagging API, which keeps
listing deleted ARNs for a while and converges later. Secrets enter an
asynchronous force-deletion queue, and the KMS key stays in `PendingDeletion`
for its minimum window — neither is live, and neither blocks a fresh
environment.
