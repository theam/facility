import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const guides = new Map([
  [
    "published AWS runbook",
    readFileSync(resolve(repoRoot, "apps/docs/docs/self-host/aws.md"), "utf8"),
  ],
  [
    "Terraform module README",
    readFileSync(resolve(repoRoot, "infra/terraform/aws/README.md"), "utf8"),
  ],
]);

const dockerfile = readFileSync(resolve(repoRoot, "Dockerfile"), "utf8");
const codeBuildTerraform = readFileSync(
  resolve(repoRoot, "infra/terraform/aws/codebuild.tf"),
  "utf8",
);
const iamTerraform = readFileSync(resolve(repoRoot, "infra/terraform/aws/iam.tf"), "utf8");
const localsTerraform = readFileSync(resolve(repoRoot, "infra/terraform/aws/locals.tf"), "utf8");
const storageTerraform = readFileSync(resolve(repoRoot, "infra/terraform/aws/storage.tf"), "utf8");
const ecsTerraform = readFileSync(resolve(repoRoot, "infra/terraform/aws/ecs.tf"), "utf8");
const outputsTerraform = readFileSync(resolve(repoRoot, "infra/terraform/aws/outputs.tf"), "utf8");
const albTerraform = readFileSync(resolve(repoRoot, "infra/terraform/aws/alb.tf"), "utf8");
const cloudfrontTerraform = readFileSync(
  resolve(repoRoot, "infra/terraform/aws/cloudfront.tf"),
  "utf8",
);

function terraformResource(source, type, name) {
  const start = source.indexOf(`resource "${type}" "${name}" {`);
  assert.notEqual(start, -1, `${type}.${name} must exist`);
  const nextResource = source.indexOf('\nresource "', start + 1);
  return source.slice(start, nextResource === -1 ? undefined : nextResource);
}

function apiStage(image) {
  const start = image.indexOf("FROM base AS api\n");
  assert.notEqual(start, -1, "the root Dockerfile must still build an api stage");
  const end = image.indexOf("\nFROM ", start + 1);
  return image.slice(start, end === -1 ? undefined : end);
}

function bootstrapOverrideCommand(markdown) {
  const override = markdown.match(
    /"containerOverrides":\[\{"name":"migrate","command":\[([\s\S]*?)\]\}\]\}/,
  );
  assert.ok(override, "the runbook must bootstrap the instance through a migrate task override");
  return [...override[1].matchAll(/"([^"]*)"/g)].map(([, token]) => token);
}

test("AWS guides use one truthful ECR-only automated release path", () => {
  for (const [guideName, markdown] of guides) {
    assert.match(
      markdown,
      /automated AWS release path deliberately deploys only from the ECR\s+repositories owned by this module/,
      `${guideName} must make ECR the single automated AWS release source`,
    );
    assert.match(
      markdown,
      /Public GHCR artifacts remain useful for other providers, but\s+they are not a\s+direct input to `deploy:aws`/,
      `${guideName} must distinguish general GHCR publication from AWS deployment`,
    );
    assert.doesNotMatch(
      markdown,
      /ghcr\.io\/theam\/facility\/|skip this step/,
      `${guideName} must not advertise the unsupported direct-GHCR shortcut`,
    );
  }
});

test("the public ALB forwards HTTP only when no ACM certificate exists", () => {
  const listener = terraformResource(albTerraform, "aws_lb_listener", "http");
  assert.match(
    listener,
    /type\s*=\s*var\.acm_certificate_arn == "" \? \(var\.enable_cloudfront_api_endpoint \? "forward" : "fixed-response"\) : "redirect"/,
  );
  assert.match(
    listener,
    /dynamic "redirect" \{[\s\S]*?for_each = var\.acm_certificate_arn == "" \? \[\] : \[1\]/,
  );
  assert.match(listener, /host\s*= "#\{host\}"/);
  assert.match(listener, /path\s*= "\/#\{path\}"/);
  assert.match(listener, /query\s*= "#\{query\}"/);
  assert.match(listener, /status_code = "HTTP_301"/);
  assert.match(
    cloudfrontTerraform,
    /precondition \{[\s\S]*?condition\s*= var\.acm_certificate_arn == ""/,
    "CloudFront's HTTP-only ALB origin must reject certificate-backed mode",
  );

  for (const route of ["api", "web", "mcp", "preview"]) {
    const rule = terraformResource(albTerraform, "aws_lb_listener_rule", `http_${route}`);
    assert.match(
      rule,
      /count\s*=\s*var\.acm_certificate_arn == "" \? 1 : 0/,
      `the ${route} HTTP forwarding rule must not exist when HTTPS is configured`,
    );
    assert.match(rule, /type\s*=\s*"forward"/);
  }

  for (const [guideName, markdown] of guides) {
    assert.match(
      markdown,
      /(?:redirects|redirecting)[\s\S]{0,140}HTTPS/,
      `${guideName} must document the HTTPS redirect boundary`,
    );
    assert.match(markdown, /port 80/, `${guideName} must identify the plaintext listener`);
    assert.match(
      markdown,
      /(?:never forwards plaintext|only certificate-less deployments forward HTTP)/,
      `${guideName} must restrict plaintext forwarding to certificate-less deployments`,
    );
  }
});

// The bootstrap step binds the first organization, owner, and installation, so a
// command the image cannot resolve fails it — and every later sign-in with
// `not_invited`. Nothing else fails when the two halves drift apart: the runbook is
// prose to CI, and the image builds happily without the name the runbook spells.
test("the runbook bootstraps by the name the api image puts on the PATH", () => {
  const [[, runbook]] = guides;
  const stage = apiStage(dockerfile);

  assert.deepEqual(
    bootstrapOverrideCommand(runbook).slice(0, 3),
    ["facility", "instance", "bootstrap"],
    "the runbook must invoke the CLI by name, not as a path into the image",
  );
  assert.match(
    stage,
    /chmod \+x \/usr\/local\/bin\/facility/,
    "the api stage must install an executable `facility` on the PATH",
  );
  // Exec form, so the guard resolves the name without a shell — the way the
  // container runtime does for an ECS command override, and unlike `RUN cmd`.
  assert.match(
    stage,
    /RUN\s*\[\s*"facility",\s*"instance",\s*"bootstrap"/,
    "the api stage must fail the build when that name stops resolving without a shell",
  );
});

test("AWS guides require the build manifest and reserve overrides for the runner", () => {
  for (const [guideName, markdown] of guides) {
    assert.match(
      markdown,
      /## 3\. Build and push release images[\s\S]*?required because it creates the exact ECR manifest/,
      `${guideName} must require the manifest-producing build step`,
    );
    assert.match(
      markdown,
      /image_overrides[\s\S]*?pin the privileged runner to the exact ECR digest/,
      `${guideName} must scope the documented override to the Terraform-owned runner`,
    );
    assert.match(
      markdown,
      /ECR basic or enhanced[\s\S]{0,120}HIGH or CRITICAL/,
      `${guideName} must document the deployment vulnerability gate`,
    );
    assert.match(
      markdown,
      /ecr:DescribeImages[\s\S]{0,80}ecr:DescribeImageScanFindings/,
      `${guideName} must document the operator's scan-read permissions`,
    );
  }
});

test("AWS stores the shared API and worker artifact once without collapsing their services", () => {
  assert.match(
    localsTerraform,
    /ecr_repositories = toset\(\["api", "gateway", "web", "mcp", "runner"\]\)/,
  );
  assert.doesNotMatch(localsTerraform, /ecr_repositories[^\n]+"worker"/);
  assert.match(
    localsTerraform,
    /worker = coalesce\(lookup\(var\.image_overrides, "worker", null\), local\.artifact_images\.api\)/,
  );
  assert.match(localsTerraform, /worker = \{[\s\S]*image\s+= local\.images\.worker/);

  for (const [guideName, markdown] of guides) {
    assert.match(
      markdown,
      /state rm[\s\\\n]+\s*'aws_ecr_lifecycle_policy\.service\["worker"\]'/,
      `${guideName} must preserve the legacy lifecycle policy through the transition`,
    );
    assert.match(
      markdown,
      /state rm[\s\\\n]+\s*'aws_ecr_repository\.service\["worker"\]'/,
      `${guideName} must preserve the non-empty legacy worker repository`,
    );
    assert.match(
      markdown,
      /API and worker (?:run|use) the same API digest|API and worker run the same API digest/,
      `${guideName} must explain the shared artifact`,
    );
  }
});

test("AWS release ownership stays narrow and the guides use the digest deploy gate", () => {
  const service = ecsTerraform.slice(ecsTerraform.indexOf('resource "aws_ecs_service" "service"'));
  assert.match(service, /lifecycle \{\s+ignore_changes = \[task_definition\]\s+\}/);
  assert.doesNotMatch(service, /ignore_changes\s*=\s*\[[^\]]*desired_count/);
  assert.doesNotMatch(codeBuildTerraform, /ignore_changes/);
  assert.match(
    outputsTerraform,
    /output "service_task_definition_arns"[\s\S]*aws_ecs_task_definition\.service/,
  );
  assert.match(outputsTerraform, /output "task_cpu_architecture"/);

  for (const [guideName, markdown] of guides) {
    assert.match(
      markdown,
      /deploy:aws[\s\S]*--manifest[\s\S]*--allow-zero-desired/,
      `${guideName} must stage the initial digest release without certifying zero tasks`,
    );
    assert.match(
      markdown,
      /CodeBuild runner remains Terraform-owned|CodeBuild runner is intentionally not changed/,
      `${guideName} must keep the privileged runner outside the fast mutation path`,
    );
    assert.match(
      markdown,
      /restores all five prior task definitions|restored; `22` requires intervention/,
      `${guideName} must document service-only rollback`,
    );
  }
});

test("AWS agent caches fail closed and contain only isolated package stores", () => {
  const buildspec = codeBuildTerraform.match(/buildspec = <<-YAML\n([\s\S]*?)\n\s+YAML/)?.[1];
  assert.ok(buildspec, "the runner project must have an inline buildspec");
  assert.match(codeBuildTerraform, /cache \{\s+type = "NO_CACHE"\s+\}/);
  assert.match(
    codeBuildTerraform,
    /encryption_key = aws_kms_key\.facility\.arn/,
    "cache objects must use the deployment CMK",
  );
  assert.match(buildspec, /- "\/work\/\.local\/share\/pnpm\/store\/\*\*\/\*"/);
  assert.match(buildspec, /- "\/work\/\.npm\/_cacache\/\*\*\/\*"/);
  assert.doesNotMatch(buildspec, /(?:^|\s)key:/, "a buildspec key would make the cache immutable");
  for (const forbidden of ["/work/**/*", "ms-playwright", "supabase", "docker"]) {
    assert.doesNotMatch(
      buildspec,
      new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `the cache must exclude ${forbidden}`,
    );
  }
  assert.match(localsTerraform, /FACILITY_AWS_CODEBUILD_CACHE_BASE_LOCATION[^\n]+codebuild-cache/);
});

test("the CodeBuild role and lifecycle cannot escape the cache prefix", () => {
  const policyStart = iamTerraform.indexOf('resource "aws_iam_role_policy" "codebuild_runner"');
  const policy = policyStart === -1 ? undefined : iamTerraform.slice(policyStart);
  assert.ok(policy, "the CodeBuild role policy must exist");
  assert.match(policy, /s3:GetObject/);
  assert.match(policy, /s3:GetObjectVersion/);
  assert.match(policy, /s3:PutObject/);
  assert.match(policy, /codebuild-cache\/\*/);
  assert.doesNotMatch(policy, /s3:ListBucket/);
  assert.match(policy, /kms:GenerateDataKey/);
  assert.match(policy, /kms:Decrypt/);
  assert.match(policy, /kms:ViaService/);

  const lifecycleStart = storageTerraform.indexOf('id     = "expire-codebuild-caches"');
  const lifecycleEnd = storageTerraform.indexOf('resource "aws_ecr_repository"', lifecycleStart);
  const lifecycle =
    lifecycleStart === -1
      ? undefined
      : storageTerraform.slice(lifecycleStart, lifecycleEnd === -1 ? undefined : lifecycleEnd);
  assert.ok(lifecycle, "cache retention must be bounded");
  assert.match(lifecycle, /prefix = "codebuild-cache\/"/);
  assert.match(lifecycle, /days = 30/);
  assert.match(lifecycle, /noncurrent_days = 7/);
});

test("the API can discover preview tasks without widening task mutation permissions", () => {
  const discoveryStart = iamTerraform.indexOf('Sid      = "DiscoverPreviewTasks"');
  assert.notEqual(discoveryStart, -1, "preview orphan recovery must be able to list ECS tasks");
  const discovery = iamTerraform.slice(
    discoveryStart,
    iamTerraform.indexOf("\n      {", discoveryStart),
  );
  assert.match(discovery, /Action\s*=\s*"ecs:ListTasks"/);
  assert.match(discovery, /Resource\s*=\s*"\*"/);
  assert.match(discovery, /"ecs:cluster"\s*=\s*aws_ecs_cluster\.facility\.arn/);

  const management = iamTerraform.match(
    /Sid\s*=\s*"ManagePreviewTasks"[\s\S]*?Resource\s*=\s*"([^"]+)"/,
  );
  assert.ok(management, "preview task management policy must exist");
  assert.doesNotMatch(
    management[1],
    /^\*$/,
    "DescribeTasks and StopTask must remain scoped to this deployment's task ARNs",
  );
});
