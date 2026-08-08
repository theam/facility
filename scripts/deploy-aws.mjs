#!/usr/bin/env node
// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: this operator CLI consumes AWS and Terraform process contracts.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const AWS_SERVICE_NAMES = Object.freeze(["api", "worker", "gateway", "web", "mcp"]);
export const AWS_ARTIFACT_NAMES = Object.freeze(["api", "gateway", "mcp", "web", "runner"]);
export const AWS_IMAGE_NAMES = Object.freeze(["api", "worker", "gateway", "web", "mcp", "runner"]);

const AWS_BAKE_AUXILIARY_TARGETS = new Set(["service-packages"]);

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const FULL_SHA_PATTERN = /^[0-9a-f]{40,64}$/;
const ECR_FIX_AVAILABILITY = new Set(["YES", "NO", "PARTIAL"]);
const ECR_REPOSITORY_PATTERN =
  /^\d{12}\.dkr\.ecr(?:-fips)?\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?\/[a-z0-9]+(?:[._/-][a-z0-9]+)*$/;
const TASK_REGISTRATION_FIELDS = Object.freeze([
  "family",
  "taskRoleArn",
  "executionRoleArn",
  "networkMode",
  "containerDefinitions",
  "volumes",
  "placementConstraints",
  "requiresCompatibilities",
  "cpu",
  "memory",
  "pidMode",
  "ipcMode",
  "proxyConfiguration",
  "inferenceAccelerators",
  "ephemeralStorage",
  "runtimePlatform",
  "enableFaultInjection",
]);

export class AwsDeployError extends Error {
  constructor(code, message, { cause, exitCode = 2 } = {}) {
    super(message, { cause });
    this.name = "AwsDeployError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertObject(value, label) {
  if (!isObject(value))
    throw new AwsDeployError("deploy_config_invalid", `${label} must be an object`);
  return value;
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(assertObject(value, label)).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new AwsDeployError(
      "deploy_config_invalid",
      `${label} contains ${actual.join(",") || "no keys"}; expected ${wanted.join(",")}`,
    );
  }
}

function assertString(value, label) {
  if (typeof value !== "string" || value.trim() !== value || value === "") {
    throw new AwsDeployError(
      "deploy_config_invalid",
      `${label} must be a non-empty trimmed string`,
    );
  }
  return value;
}

function assertDigest(value, label) {
  if (!DIGEST_PATTERN.test(value || "")) {
    throw new AwsDeployError(
      "deploy_manifest_invalid",
      `${label} must be an immutable sha256 digest`,
    );
  }
  return value;
}

function expectedPlatform(cpuArchitecture) {
  if (cpuArchitecture === "X86_64") return "linux/amd64";
  if (cpuArchitecture === "ARM64") return "linux/arm64";
  throw new AwsDeployError(
    "terraform_outputs_invalid",
    `task_cpu_architecture must be X86_64 or ARM64, received ${cpuArchitecture || "missing"}`,
  );
}

function vulnerabilityCounts(findings, repository) {
  const counts = findings?.findingSeverityCounts;
  const critical = Number(counts?.CRITICAL ?? 0);
  const high = Number(counts?.HIGH ?? 0);
  if (!Number.isSafeInteger(critical) || critical < 0 || !Number.isSafeInteger(high) || high < 0) {
    throw new AwsDeployError(
      "ecr_scan_invalid_response",
      `ECR returned invalid vulnerability counts for ${repository}`,
    );
  }
  return { critical, high };
}

export function enforceEcrScanPolicy(findings, { enhanced, repository }) {
  const { critical, high } = vulnerabilityCounts(findings, repository);
  if (!enhanced) {
    // Basic scanning cannot distinguish a patchable vulnerability from one for
    // which the distribution has no update. Preserve the original fail-closed
    // behavior instead of silently guessing.
    if (critical > 0 || high > 0) {
      throw new AwsDeployError(
        "ecr_scan_blocked",
        `ECR blocked ${repository}: ${critical} critical and ${high} high vulnerabilities`,
      );
    }
    return { critical, high, actionableCritical: 0, actionableHigh: 0, enhanced: false };
  }

  if (!Array.isArray(findings?.enhancedFindings)) {
    throw new AwsDeployError(
      "ecr_scan_invalid_response",
      `ECR returned no enhanced findings for ${repository}`,
    );
  }

  let actionableCritical = 0;
  let actionableHigh = 0;
  let observedCritical = 0;
  let observedHigh = 0;
  for (const finding of findings.enhancedFindings) {
    if (finding?.severity !== "CRITICAL" && finding?.severity !== "HIGH") continue;
    if (!ECR_FIX_AVAILABILITY.has(finding.fixAvailable)) {
      throw new AwsDeployError(
        "ecr_scan_invalid_response",
        `ECR returned invalid fix availability for ${repository}`,
      );
    }
    if (finding.severity === "CRITICAL") observedCritical += 1;
    else observedHigh += 1;
    if (finding.fixAvailable === "NO") continue;
    if (finding.severity === "CRITICAL") actionableCritical += 1;
    else actionableHigh += 1;
  }

  if (observedCritical !== critical || observedHigh !== high) {
    throw new AwsDeployError(
      "ecr_scan_invalid_response",
      `ECR enhanced findings did not match vulnerability counts for ${repository}`,
    );
  }
  if (actionableCritical > 0 || actionableHigh > 0) {
    throw new AwsDeployError(
      "ecr_scan_blocked",
      `ECR blocked ${repository}: ${actionableCritical} critical and ${actionableHigh} high vulnerabilities have fixes available`,
    );
  }
  return { critical, high, actionableCritical, actionableHigh, enhanced: true };
}

export function createAwsReleaseManifest({ metadata, repositoryPrefix, sourceSha, platform }) {
  const artifactMetadata = Object.fromEntries(
    Object.entries(assertObject(metadata, "Bake metadata")).filter(
      ([name]) => !AWS_BAKE_AUXILIARY_TARGETS.has(name),
    ),
  );
  assertExactKeys(artifactMetadata, AWS_ARTIFACT_NAMES, "Bake metadata");
  const prefix = assertString(repositoryPrefix, "repository prefix").replace(/\/$/, "");
  if (!ECR_REPOSITORY_PATTERN.test(`${prefix}/api`)) {
    throw new AwsDeployError(
      "deploy_manifest_invalid",
      `repository prefix must identify an AWS ECR namespace, received ${prefix}`,
    );
  }
  if (!FULL_SHA_PATTERN.test(sourceSha || "")) {
    throw new AwsDeployError(
      "deploy_manifest_invalid",
      "source SHA must be a full lowercase commit SHA",
    );
  }
  if (platform !== "linux/amd64" && platform !== "linux/arm64") {
    throw new AwsDeployError(
      "deploy_manifest_invalid",
      `platform must be linux/amd64 or linux/arm64, received ${platform || "missing"}`,
    );
  }

  const refs = {};
  for (const name of AWS_ARTIFACT_NAMES) {
    const result = assertObject(artifactMetadata[name], `Bake metadata target ${name}`);
    const digest = assertDigest(result["containerimage.digest"], `${name} digest`);
    const descriptorDigest = result["containerimage.descriptor"]?.digest;
    if (descriptorDigest !== digest) {
      throw new AwsDeployError(
        "deploy_manifest_invalid",
        `Bake descriptor for ${name} does not match ${digest}`,
      );
    }
    refs[name] = `${prefix}/${name}@${digest}`;
  }

  return {
    schemaVersion: 1,
    sourceSha,
    platform,
    images: {
      api: refs.api,
      worker: refs.api,
      gateway: refs.gateway,
      web: refs.web,
      mcp: refs.mcp,
      runner: refs.runner,
    },
  };
}

export async function writeAwsReleaseManifest(path, manifest) {
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
  return destination;
}

function unwrapTerraformOutput(raw, name) {
  const entry = assertObject(raw[name], `Terraform output ${name}`);
  if (!("value" in entry)) {
    throw new AwsDeployError("terraform_outputs_invalid", `Terraform output ${name} has no value`);
  }
  return entry.value;
}

export function normalizeTerraformOutputs(raw) {
  assertObject(raw, "Terraform outputs");
  const outputs = {
    awsRegion: assertString(unwrapTerraformOutput(raw, "aws_region"), "aws_region"),
    architecture: assertString(
      unwrapTerraformOutput(raw, "task_cpu_architecture"),
      "task_cpu_architecture",
    ),
    sandboxDriver: assertString(unwrapTerraformOutput(raw, "sandbox_driver"), "sandbox_driver"),
    cluster: assertString(unwrapTerraformOutput(raw, "ecs_cluster_name"), "ecs_cluster_name"),
    runnerProject: assertString(
      unwrapTerraformOutput(raw, "codebuild_runner_project_name"),
      "codebuild_runner_project_name",
    ),
    migrateTaskDefinitionArn: assertString(
      unwrapTerraformOutput(raw, "migrate_task_definition_arn"),
      "migrate_task_definition_arn",
    ),
    securityGroup: assertString(
      unwrapTerraformOutput(raw, "service_security_group_id"),
      "service_security_group_id",
    ),
    subnets: unwrapTerraformOutput(raw, "private_subnet_ids"),
    repositories: unwrapTerraformOutput(raw, "ecr_repository_urls"),
    serviceTaskDefinitions: unwrapTerraformOutput(raw, "service_task_definition_arns"),
  };

  expectedPlatform(outputs.architecture);
  if (outputs.sandboxDriver !== "aws" && outputs.sandboxDriver !== "vercel") {
    throw new AwsDeployError(
      "terraform_outputs_invalid",
      `sandbox_driver must be aws or vercel, received ${outputs.sandboxDriver}`,
    );
  }
  if (
    !Array.isArray(outputs.subnets) ||
    outputs.subnets.length < 2 ||
    outputs.subnets.some((subnet) => typeof subnet !== "string" || subnet === "")
  ) {
    throw new AwsDeployError(
      "terraform_outputs_invalid",
      "private_subnet_ids must contain at least two subnet IDs",
    );
  }
  assertExactKeys(outputs.repositories, AWS_ARTIFACT_NAMES, "ecr_repository_urls");
  assertExactKeys(
    outputs.serviceTaskDefinitions,
    AWS_SERVICE_NAMES,
    "service_task_definition_arns",
  );
  for (const [name, repository] of Object.entries(outputs.repositories)) {
    assertString(repository, `ECR repository ${name}`);
    if (!ECR_REPOSITORY_PATTERN.test(repository)) {
      throw new AwsDeployError(
        "terraform_outputs_invalid",
        `ECR repository ${name} is not a canonical repository URL`,
      );
    }
  }
  for (const [name, arn] of Object.entries(outputs.serviceTaskDefinitions)) {
    assertString(arn, `service task definition ${name}`);
  }
  return outputs;
}

function splitDigestReference(reference, label) {
  const value = assertString(reference, label);
  const separator = value.lastIndexOf("@");
  if (separator <= 0 || value.indexOf("@") !== separator) {
    throw new AwsDeployError(
      "deploy_manifest_invalid",
      `${label} must be a digest-only image reference`,
    );
  }
  const repository = value.slice(0, separator);
  const digest = assertDigest(value.slice(separator + 1), `${label} digest`);
  return { digest, reference: value, repository };
}

export function validateAwsReleaseManifest(manifest, outputs) {
  assertExactKeys(manifest, ["schemaVersion", "sourceSha", "platform", "images"], "manifest");
  if (manifest.schemaVersion !== 1) {
    throw new AwsDeployError(
      "deploy_manifest_invalid",
      `manifest schemaVersion must be 1, received ${String(manifest.schemaVersion)}`,
    );
  }
  if (!FULL_SHA_PATTERN.test(manifest.sourceSha || "")) {
    throw new AwsDeployError(
      "deploy_manifest_invalid",
      "manifest sourceSha must be a full lowercase commit SHA",
    );
  }
  if (manifest.platform !== expectedPlatform(outputs.architecture)) {
    throw new AwsDeployError(
      "deploy_manifest_invalid",
      `manifest platform ${manifest.platform || "missing"} does not match ${outputs.architecture}`,
    );
  }
  assertExactKeys(manifest.images, AWS_IMAGE_NAMES, "manifest images");
  if (manifest.images.worker !== manifest.images.api) {
    throw new AwsDeployError(
      "deploy_manifest_invalid",
      "worker must use the exact API artifact digest",
    );
  }

  const parsedImages = {};
  for (const name of AWS_IMAGE_NAMES) {
    const parsed = splitDigestReference(manifest.images[name], `manifest image ${name}`);
    const repositoryName = name === "worker" ? "api" : name;
    const expectedRepository = outputs.repositories[repositoryName];
    if (parsed.repository !== expectedRepository) {
      throw new AwsDeployError(
        "deploy_manifest_invalid",
        `manifest image ${name} must come from ${expectedRepository}`,
      );
    }
    parsedImages[name] = parsed;
  }
  return { ...manifest, parsedImages };
}

export function taskDefinitionRegistration(template, containerName, image) {
  const taskDefinition = assertObject(template?.taskDefinition ?? template, "task definition");
  const registration = {};
  for (const field of TASK_REGISTRATION_FIELDS) {
    if (taskDefinition[field] !== undefined)
      registration[field] = structuredClone(taskDefinition[field]);
  }
  assertString(registration.family, "task definition family");
  if (!Array.isArray(registration.containerDefinitions)) {
    throw new AwsDeployError(
      "task_definition_invalid",
      `task definition ${registration.family} has no container definitions`,
    );
  }
  const matches = registration.containerDefinitions.filter(
    (container) => container?.name === containerName,
  );
  if (matches.length !== 1) {
    throw new AwsDeployError(
      "task_definition_invalid",
      `task definition ${registration.family} must contain exactly one ${containerName} container`,
    );
  }
  matches[0].image = image;
  return registration;
}

function deployEvent(log, phase, status, details = {}) {
  log({ event: "facility.aws.deploy", phase, status, ...details });
}

function serviceMap(services) {
  if (!Array.isArray(services)) {
    throw new AwsDeployError("ecs_preflight_failed", "ECS describe-services returned no services");
  }
  const byName = new Map();
  for (const service of services) {
    if (
      !service ||
      !AWS_SERVICE_NAMES.includes(service.serviceName) ||
      byName.has(service.serviceName)
    ) {
      throw new AwsDeployError(
        "ecs_preflight_failed",
        "ECS describe-services returned an unexpected or duplicate service",
      );
    }
    byName.set(service.serviceName, service);
  }
  if (byName.size !== AWS_SERVICE_NAMES.length) {
    throw new AwsDeployError(
      "ecs_preflight_failed",
      `ECS returned ${byName.size} Facility services; expected ${AWS_SERVICE_NAMES.length}`,
    );
  }
  return byName;
}

function inspectStableServices(services, { allowZeroDesired = false } = {}) {
  const byName = serviceMap(services);
  const zero = [];
  const prior = {};
  for (const name of AWS_SERVICE_NAMES) {
    const service = byName.get(name);
    if (service.status && service.status !== "ACTIVE") {
      throw new AwsDeployError("ecs_preflight_failed", `ECS service ${name} is ${service.status}`);
    }
    if (!Number.isSafeInteger(service.desiredCount) || service.desiredCount < 0) {
      throw new AwsDeployError(
        "ecs_preflight_failed",
        `ECS service ${name} has an invalid desired count`,
      );
    }
    if (service.desiredCount === 0) zero.push(name);
    if (
      !Array.isArray(service.deployments) ||
      service.deployments.length !== 1 ||
      (service.deployments[0]?.rolloutState !== undefined &&
        service.deployments[0].rolloutState !== "COMPLETED") ||
      (service.pendingCount ?? 0) !== 0
    ) {
      throw new AwsDeployError(
        "ecs_deployment_in_progress",
        `ECS service ${name} is not in a completed single-deployment state`,
      );
    }
    if (service.desiredCount > 0 && service.runningCount !== service.desiredCount) {
      throw new AwsDeployError(
        "ecs_preflight_failed",
        `ECS service ${name} is running ${service.runningCount ?? "an unknown count"} of ${service.desiredCount} desired tasks`,
      );
    }
    prior[name] = assertString(service.taskDefinition, `ECS service ${name} task definition`);
  }
  if (zero.length > 0 && !allowZeroDesired) {
    throw new AwsDeployError(
      "ecs_zero_desired",
      `refusing to certify zero-desired services: ${zero.join(", ")}; use --allow-zero-desired only for first bootstrap`,
    );
  }
  if (zero.length > 0 && zero.length !== AWS_SERVICE_NAMES.length) {
    throw new AwsDeployError(
      "ecs_mixed_desired",
      "bootstrap requires either all five services at zero or all five services running",
    );
  }
  return { bootstrap: zero.length === AWS_SERVICE_NAMES.length, prior };
}

function verifyServicePointers(services, expected, { requireRunning }) {
  const byName = serviceMap(services);
  for (const name of AWS_SERVICE_NAMES) {
    const service = byName.get(name);
    if (service.taskDefinition !== expected[name]) {
      throw new AwsDeployError(
        "ecs_rollout_verification_failed",
        `ECS service ${name} points at ${service.taskDefinition || "nothing"}, expected ${expected[name]}`,
      );
    }
    if (
      requireRunning &&
      (service.desiredCount < 1 || service.runningCount !== service.desiredCount)
    ) {
      throw new AwsDeployError(
        "ecs_rollout_verification_failed",
        `ECS service ${name} is not running its full desired count`,
      );
    }
  }
}

async function cleanupTaskDefinitions(aws, arns, log) {
  const unique = [...new Set(arns.filter(Boolean))];
  if (unique.length === 0) return [];
  const results = await Promise.allSettled(unique.map((arn) => aws.deregisterTaskDefinition(arn)));
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    deployEvent(log, "cleanup", "failed", { failed: failures.length, requested: unique.length });
  } else {
    deployEvent(log, "cleanup", "completed", { deregistered: unique.length });
  }
  return failures;
}

async function rollbackServices({
  aws,
  bootstrap,
  cluster,
  prior,
  candidates,
  log,
  originalError,
}) {
  deployEvent(log, "rollback", "started", { reason: originalError.code || "rollout_failed" });
  const updates = await Promise.allSettled(
    AWS_SERVICE_NAMES.map((name) => aws.updateService(cluster, name, prior[name])),
  );
  const updateFailures = updates.filter((result) => result.status === "rejected");
  let waitFailure;
  if (updateFailures.length === 0) {
    try {
      if (!bootstrap) await aws.waitServicesStable(cluster, AWS_SERVICE_NAMES);
      const restored = await aws.describeServices(cluster, AWS_SERVICE_NAMES);
      verifyServicePointers(restored, prior, { requireRunning: !bootstrap });
    } catch (error) {
      waitFailure = error;
    }
  }
  if (updateFailures.length > 0 || waitFailure) {
    deployEvent(log, "rollback", "failed", {
      failedUpdates: updateFailures.length,
      waitFailed: Boolean(waitFailure),
    });
    throw new AwsDeployError(
      "ecs_rollback_failed",
      "AWS service rollout failed and the prior service revision could not be fully restored",
      { cause: waitFailure || updateFailures[0]?.reason || originalError, exitCode: 22 },
    );
  }
  deployEvent(log, "rollback", "completed", { restored: AWS_SERVICE_NAMES.length });
  await cleanupTaskDefinitions(
    aws,
    AWS_SERVICE_NAMES.map((name) => candidates[name]),
    log,
  );
  throw new AwsDeployError(
    "ecs_rollout_rolled_back",
    "AWS service rollout failed; all services were restored to their prior task definitions",
    { cause: originalError, exitCode: 21 },
  );
}

export async function deployAws({
  manifest,
  outputs,
  aws,
  allowZeroDesired = false,
  migrationAttempts = 2,
  log = (event) => console.log(JSON.stringify(event)),
}) {
  if (!Number.isSafeInteger(migrationAttempts) || migrationAttempts < 1 || migrationAttempts > 5) {
    throw new AwsDeployError(
      "deploy_config_invalid",
      "migrationAttempts must be an integer between 1 and 5",
    );
  }
  const deployStartedAt = performance.now();
  deployEvent(log, "deploy", "started", { sourceSha: manifest?.sourceSha });
  const release = validateAwsReleaseManifest(manifest, outputs);
  deployEvent(log, "resolve", "completed", {
    architecture: outputs.architecture,
    sourceSha: release.sourceSha,
  });

  deployEvent(log, "preflight", "started");
  const usesAwsSandbox = outputs.sandboxDriver === "aws";
  const uniqueImages = AWS_ARTIFACT_NAMES.filter((name) => usesAwsSandbox || name !== "runner").map(
    (name) => release.parsedImages[name],
  );
  const [runnerImage, services] = await Promise.all([
    usesAwsSandbox ? aws.getRunnerImage(outputs.runnerProject) : Promise.resolve(null),
    aws.describeServices(outputs.cluster, AWS_SERVICE_NAMES),
    ...uniqueImages.map(({ repository, digest }) => aws.assertImage(repository, digest)),
  ]);
  if (usesAwsSandbox && runnerImage !== release.images.runner) {
    throw new AwsDeployError(
      "runner_image_mismatch",
      `CodeBuild runner is ${runnerImage || "unset"}; apply Terraform with ${release.images.runner} before deploying this manifest`,
    );
  }
  const { bootstrap, prior } = inspectStableServices(services, { allowZeroDesired });
  deployEvent(log, "preflight", "completed", {
    bootstrap,
    sandboxDriver: outputs.sandboxDriver,
    services: AWS_SERVICE_NAMES.length,
    validatedImages: uniqueImages.length,
  });

  deployEvent(log, "register", "started");
  const roles = [...AWS_SERVICE_NAMES, "migrate"];
  const templateArns = {
    ...outputs.serviceTaskDefinitions,
    migrate: outputs.migrateTaskDefinitionArn,
  };
  const templates = await Promise.all(
    roles.map((role) => aws.describeTaskDefinition(templateArns[role])),
  );
  const registrations = roles.map((role, index) =>
    taskDefinitionRegistration(
      templates[index],
      role,
      role === "migrate" ? release.images.api : release.images[role],
    ),
  );
  const registered = await Promise.allSettled(
    registrations.map((registration) => aws.registerTaskDefinition(registration)),
  );
  const registrationFailures = registered.filter((result) => result.status === "rejected");
  const candidateArns = registered
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value);
  if (registrationFailures.length > 0) {
    await cleanupTaskDefinitions(aws, candidateArns, log);
    throw new AwsDeployError(
      "task_registration_failed",
      `failed to register ${registrationFailures.length} AWS task definition(s)`,
      { cause: registrationFailures[0].reason },
    );
  }
  const candidates = Object.fromEntries(
    roles.map((role, index) => [role, registered[index].value]),
  );
  deployEvent(log, "register", "completed", { registered: roles.length });

  deployEvent(log, "migrate", "started", { attempts: migrationAttempts });
  let migration;
  let attemptsUsed = 0;
  try {
    for (let attempt = 1; attempt <= migrationAttempts; attempt += 1) {
      attemptsUsed = attempt;
      migration = await aws.runMigration({
        cluster: outputs.cluster,
        securityGroup: outputs.securityGroup,
        sourceSha: release.sourceSha,
        subnets: outputs.subnets,
        taskDefinition: candidates.migrate,
      });
      if (migration.exitCode === 0) break;
      if (migration.exitCode !== 10 || attempt === migrationAttempts) break;
      deployEvent(log, "migrate", "retrying", { attempt, exitCode: migration.exitCode });
    }
  } catch (error) {
    await cleanupTaskDefinitions(aws, Object.values(candidates), log);
    throw new AwsDeployError(
      "database_deploy_failed",
      "database release task did not complete; no ECS service was changed",
      { cause: error },
    );
  }
  if (migration?.exitCode !== 0) {
    await cleanupTaskDefinitions(aws, Object.values(candidates), log);
    const exitCode = [10, 11, 12].includes(migration?.exitCode) ? migration.exitCode : 1;
    const stoppedReason =
      typeof migration?.stoppedReason === "string" && migration.stoppedReason !== ""
        ? ` (${migration.stoppedReason.slice(0, 500)})`
        : "";
    throw new AwsDeployError(
      "database_deploy_failed",
      `database release task exited ${migration?.exitCode ?? "without an exit code"}${stoppedReason}; no ECS service was changed`,
      { exitCode },
    );
  }
  deployEvent(log, "migrate", "completed", { attemptsUsed });
  await cleanupTaskDefinitions(aws, [candidates.migrate], log);

  // Re-read as close to the first mutation as possible. This does not pretend
  // to be a distributed lock, but it closes the long migration-window race and
  // refuses to overwrite a service pointer that changed since preflight.
  try {
    const beforeMutation = await aws.describeServices(outputs.cluster, AWS_SERVICE_NAMES);
    const current = inspectStableServices(beforeMutation, { allowZeroDesired: bootstrap });
    if (current.bootstrap !== bootstrap) {
      throw new AwsDeployError(
        "ecs_concurrent_deploy",
        "ECS desired counts changed after deploy preflight",
      );
    }
    verifyServicePointers(beforeMutation, prior, { requireRunning: !bootstrap });
  } catch (error) {
    await cleanupTaskDefinitions(
      aws,
      AWS_SERVICE_NAMES.map((name) => candidates[name]),
      log,
    );
    throw new AwsDeployError(
      "ecs_concurrent_deploy",
      "ECS service state changed while the database gate ran; no service was updated",
      { cause: error },
    );
  }

  deployEvent(log, "rollout", "started", { bootstrap });
  const updates = await Promise.allSettled(
    AWS_SERVICE_NAMES.map((name) => aws.updateService(outputs.cluster, name, candidates[name])),
  );
  const updateFailure = updates.find((result) => result.status === "rejected");
  if (updateFailure) {
    await rollbackServices({
      aws,
      bootstrap,
      cluster: outputs.cluster,
      prior,
      candidates,
      log,
      originalError: updateFailure.reason,
    });
  }

  if (bootstrap) {
    const staged = await aws.describeServices(outputs.cluster, AWS_SERVICE_NAMES);
    try {
      verifyServicePointers(staged, candidates, { requireRunning: false });
    } catch (error) {
      await rollbackServices({
        aws,
        bootstrap,
        cluster: outputs.cluster,
        prior,
        candidates,
        log,
        originalError: error,
      });
    }
    const durationMs = Math.round(performance.now() - deployStartedAt);
    deployEvent(log, "deploy", "staged", {
      durationMs,
      sourceSha: release.sourceSha,
      message: "digest revisions and migration are ready; raise all five Terraform desired counts",
    });
    return { candidates, durationMs, outcome: "staged", sourceSha: release.sourceSha };
  }

  try {
    deployEvent(log, "wait", "started");
    await aws.waitServicesStable(outputs.cluster, AWS_SERVICE_NAMES);
    const deployed = await aws.describeServices(outputs.cluster, AWS_SERVICE_NAMES);
    verifyServicePointers(deployed, candidates, { requireRunning: true });
    deployEvent(log, "wait", "completed", { services: AWS_SERVICE_NAMES.length });
  } catch (error) {
    await rollbackServices({
      aws,
      bootstrap,
      cluster: outputs.cluster,
      prior,
      candidates,
      log,
      originalError: error,
    });
  }

  const durationMs = Math.round(performance.now() - deployStartedAt);
  deployEvent(log, "deploy", "completed", {
    durationMs,
    sourceSha: release.sourceSha,
    taskDefinitions: Object.fromEntries(AWS_SERVICE_NAMES.map((name) => [name, candidates[name]])),
  });
  return { candidates, durationMs, outcome: "deployed", sourceSha: release.sourceSha };
}

function commandFailure(command, args, error, stderr) {
  const detail = String(stderr || error?.stderr || error?.message || "unknown command failure")
    .trim()
    .slice(-2_000);
  return new AwsDeployError(
    "operator_command_failed",
    `${command} ${args.slice(0, 3).join(" ")} failed: ${detail}`,
    { cause: error },
  );
}

function execute(command, args, { timeoutMs }) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command,
      args,
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(commandFailure(command, args, error, stderr));
          return;
        }
        resolvePromise({ stderr, stdout });
      },
    );
  });
}

function parseJsonOutput(command, args, stdout) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new AwsDeployError(
      "operator_command_invalid_output",
      `${command} ${args.slice(0, 3).join(" ")} returned malformed JSON`,
      { cause: error },
    );
  }
}

export function createAwsCliAdapter({
  region,
  awsCommand = "aws",
  commandTimeoutMs = 12 * 60_000,
  pollIntervalMs = 5_000,
}) {
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new AwsDeployError("deploy_config_invalid", "pollIntervalMs must be a positive integer");
  }

  async function awsJson(service, operation, args = []) {
    const commandArgs = [
      "--region",
      region,
      "--no-cli-pager",
      service,
      operation,
      ...args,
      "--output",
      "json",
    ];
    const { stdout } = await execute(awsCommand, commandArgs, { timeoutMs: commandTimeoutMs });
    return parseJsonOutput(awsCommand, commandArgs, stdout);
  }

  async function describeServices(cluster, services) {
    const response = await awsJson("ecs", "describe-services", [
      "--cluster",
      cluster,
      "--services",
      ...services,
    ]);
    if (Array.isArray(response.failures) && response.failures.length > 0) {
      throw new AwsDeployError(
        "ecs_preflight_failed",
        `ECS could not describe ${response.failures.length} service(s)`,
      );
    }
    return response.services;
  }

  async function describeTasks(cluster, tasks, { allowMissing = false } = {}) {
    const response = await awsJson("ecs", "describe-tasks", [
      "--cluster",
      cluster,
      "--tasks",
      ...tasks,
    ]);
    const failures = Array.isArray(response.failures) ? response.failures : [];
    const onlyRequestedTasksMissing =
      allowMissing &&
      failures.length > 0 &&
      failures.every(
        (failure) => failure?.reason === "MISSING" && (!failure.arn || tasks.includes(failure.arn)),
      );
    if (failures.length > 0 && !onlyRequestedTasksMissing) {
      throw new AwsDeployError(
        "ecs_task_describe_failed",
        `ECS could not describe ${failures.length} task(s)`,
      );
    }
    return response.tasks;
  }

  async function pollUntil(label, inspect) {
    const deadline = Date.now() + commandTimeoutMs;
    while (true) {
      const result = await inspect();
      if (result.done) return result.value;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new AwsDeployError(
          "operator_wait_timeout",
          `${label} did not complete within ${commandTimeoutMs}ms`,
        );
      }
      await new Promise((resolvePromise) =>
        setTimeout(resolvePromise, Math.min(pollIntervalMs, remainingMs)),
      );
    }
  }

  return {
    async assertImage(repository, digest) {
      const repositoryName = repository.slice(repository.indexOf("/") + 1);
      const response = await awsJson("ecr", "describe-images", [
        "--repository-name",
        repositoryName,
        "--image-ids",
        `imageDigest=${digest}`,
      ]);
      if (
        !Array.isArray(response.imageDetails) ||
        !response.imageDetails.some((detail) => detail?.imageDigest === digest)
      ) {
        throw new AwsDeployError(
          "ecr_image_missing",
          `${repository}@${digest} does not exist in ECR`,
        );
      }

      await pollUntil(`ECR vulnerability scan for ${repository}@${digest}`, async () => {
        let scan;
        try {
          scan = await awsJson("ecr", "describe-image-scan-findings", [
            "--repository-name",
            repositoryName,
            "--image-id",
            `imageDigest=${digest}`,
          ]);
        } catch (error) {
          // ECR can briefly return ScanNotFoundException after the image itself is visible.
          if (String(error?.message).includes("ScanNotFoundException")) return { done: false };
          throw error;
        }

        const status = scan.imageScanStatus?.status;
        if (status === "IN_PROGRESS" || status === "PENDING") return { done: false };
        const findings = scan.imageScanFindings;
        // Registry-wide enhanced scanning reports ACTIVE after its initial scan.
        // Require a completed-scan timestamp so ACTIVE cannot admit an image
        // before Inspector has produced its first result.
        if (status === "ACTIVE" && !findings?.imageScanCompletedAt) return { done: false };
        if (status !== "COMPLETE" && status !== "ACTIVE") {
          throw new AwsDeployError(
            "ecr_scan_unavailable",
            `ECR vulnerability scan for ${repository}@${digest} is ${status || "missing"}`,
          );
        }

        // ECR used to expose enhanced scans as ACTIVE, but now also returns
        // COMPLETE. The enhancedFindings collection is the stable response
        // discriminator; status alone would misclassify the same Inspector
        // result as a basic scan and block non-fixable distribution CVEs.
        enforceEcrScanPolicy(findings, {
          enhanced: Array.isArray(findings?.enhancedFindings),
          repository: `${repository}@${digest}`,
        });
        return { done: true };
      });
    },

    async getRunnerImage(projectName) {
      const response = await awsJson("codebuild", "batch-get-projects", ["--names", projectName]);
      if (response.projects?.length !== 1 || response.projects[0]?.name !== projectName) {
        throw new AwsDeployError(
          "codebuild_project_missing",
          `CodeBuild project ${projectName} was not returned`,
        );
      }
      return response.projects[0].environment?.image;
    },

    describeServices,

    async describeTaskDefinition(taskDefinition) {
      return awsJson("ecs", "describe-task-definition", ["--task-definition", taskDefinition]);
    },

    async registerTaskDefinition(input) {
      const directory = await mkdtemp(join(tmpdir(), "facility-task-definition-"));
      const path = join(directory, "input.json");
      try {
        await writeFile(path, JSON.stringify(input), { mode: 0o600 });
        const response = await awsJson("ecs", "register-task-definition", [
          "--cli-input-json",
          `file://${path}`,
        ]);
        return assertString(
          response.taskDefinition?.taskDefinitionArn,
          "registered task definition ARN",
        );
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    },

    async deregisterTaskDefinition(taskDefinition) {
      await awsJson("ecs", "deregister-task-definition", ["--task-definition", taskDefinition]);
    },

    async runMigration({ cluster, securityGroup, sourceSha, subnets, taskDefinition }) {
      const response = await awsJson("ecs", "run-task", [
        "--cluster",
        cluster,
        "--launch-type",
        "FARGATE",
        "--count",
        "1",
        "--started-by",
        `facility-${sourceSha.slice(0, 24)}`,
        "--task-definition",
        taskDefinition,
        "--network-configuration",
        JSON.stringify({
          awsvpcConfiguration: {
            assignPublicIp: "DISABLED",
            securityGroups: [securityGroup],
            subnets,
          },
        }),
      ]);
      if (response.failures?.length || response.tasks?.length !== 1) {
        throw new AwsDeployError(
          "database_task_start_failed",
          "ECS did not start exactly one database release task",
        );
      }
      const taskArn = assertString(response.tasks[0].taskArn, "database release task ARN");
      const { container, task } = await pollUntil("database release task", async () => {
        // A just-started task may briefly appear either as an empty result or a
        // MISSING failure. Both are safe to retry within the operator's bound.
        const tasks = await describeTasks(cluster, [taskArn], { allowMissing: true });
        const task = tasks?.find((candidate) => candidate.taskArn === taskArn);
        if (!task) return { done: false };
        const container = task.containers?.find((candidate) => candidate.name === "migrate");
        return { done: task.lastStatus === "STOPPED", value: { container, task } };
      });
      return {
        attempt: 1,
        exitCode: Number.isSafeInteger(container?.exitCode) ? container.exitCode : 1,
        stoppedReason: task?.stoppedReason,
        taskArn,
      };
    },

    async updateService(cluster, service, taskDefinition) {
      await awsJson("ecs", "update-service", [
        "--cluster",
        cluster,
        "--service",
        service,
        "--task-definition",
        taskDefinition,
      ]);
    },

    async waitServicesStable(cluster, services) {
      await pollUntil("ECS service rollout", async () => {
        const described = await describeServices(cluster, services);
        const byName = serviceMap(described);
        for (const name of services) {
          const service = byName.get(name);
          if (service.deployments?.some((deployment) => deployment.rolloutState === "FAILED")) {
            throw new AwsDeployError(
              "ecs_rollout_failed",
              `ECS service ${name} reported a failed deployment`,
            );
          }
        }
        const stable = services.every((name) => {
          const service = byName.get(name);
          return (
            service.deployments?.length === 1 &&
            (service.deployments[0].rolloutState === undefined ||
              service.deployments[0].rolloutState === "COMPLETED") &&
            service.pendingCount === 0 &&
            service.runningCount === service.desiredCount
          );
        });
        return { done: stable };
      });
    },
  };
}

export async function readTerraformOutputs({
  terraformDir,
  terraformCommand = "terraform",
  commandTimeoutMs = 12 * 60_000,
}) {
  const directory = resolve(terraformDir);
  const args = [`-chdir=${directory}`, "output", "-json"];
  const { stdout } = await execute(terraformCommand, args, { timeoutMs: commandTimeoutMs });
  return normalizeTerraformOutputs(parseJsonOutput(terraformCommand, args, stdout));
}

function parseOptions(args, { allowedNames, booleanNames = [] }) {
  const allowed = new Set(allowedNames);
  const booleans = new Set(booleanNames);
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!name.startsWith("--") || name === "--") {
      throw new AwsDeployError("deploy_usage_invalid", `unexpected argument ${name}`);
    }
    if (!allowed.has(name)) {
      throw new AwsDeployError("deploy_usage_invalid", `unknown option ${name}`);
    }
    if (name in options) {
      throw new AwsDeployError("deploy_usage_invalid", `duplicate option ${name}`);
    }
    if (booleans.has(name)) {
      options[name] = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new AwsDeployError("deploy_usage_invalid", `${name} requires a value`);
    }
    options[name] = value;
    index += 1;
  }
  return options;
}

function positiveInteger(value, fallback, label, maximum) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new AwsDeployError(
      "deploy_usage_invalid",
      `${label} must be an integer between 1 and ${maximum}`,
    );
  }
  return parsed;
}

async function loadJson(path, label) {
  try {
    return JSON.parse(await readFile(resolve(path), "utf8"));
  } catch (error) {
    throw new AwsDeployError("deploy_config_invalid", `cannot read ${label}: ${error.message}`, {
      cause: error,
    });
  }
}

async function main([command, ...args]) {
  if (command === "manifest") {
    const names = ["--metadata", "--repository-prefix", "--source-sha", "--platform", "--output"];
    const options = parseOptions(args, { allowedNames: names });
    for (const name of names) {
      if (!options[name]) throw new AwsDeployError("deploy_usage_invalid", `${name} is required`);
    }
    const manifest = createAwsReleaseManifest({
      metadata: await loadJson(options["--metadata"], "Bake metadata"),
      platform: options["--platform"],
      repositoryPrefix: options["--repository-prefix"],
      sourceSha: options["--source-sha"],
    });
    const path = await writeAwsReleaseManifest(options["--output"], manifest);
    console.log(path);
    return;
  }

  if (command === "deploy") {
    const options = parseOptions(args, {
      allowedNames: [
        "--allow-zero-desired",
        "--command-timeout-ms",
        "--manifest",
        "--migration-attempts",
        "--terraform-dir",
      ],
      booleanNames: ["--allow-zero-desired"],
    });
    if (!options["--manifest"]) {
      throw new AwsDeployError("deploy_usage_invalid", "--manifest is required");
    }
    const commandTimeoutMs = positiveInteger(
      options["--command-timeout-ms"],
      12 * 60_000,
      "--command-timeout-ms",
      60 * 60_000,
    );
    const migrationAttempts = positiveInteger(
      options["--migration-attempts"],
      2,
      "--migration-attempts",
      5,
    );
    const outputs = await readTerraformOutputs({
      commandTimeoutMs,
      terraformDir: options["--terraform-dir"] || "infra/terraform/aws",
    });
    const aws = createAwsCliAdapter({ commandTimeoutMs, region: outputs.awsRegion });
    await deployAws({
      allowZeroDesired: Boolean(options["--allow-zero-desired"]),
      aws,
      manifest: await loadJson(options["--manifest"], "release manifest"),
      migrationAttempts,
      outputs,
    });
    return;
  }

  throw new AwsDeployError(
    "deploy_usage_invalid",
    `usage: deploy-aws.mjs <manifest|deploy>; received ${command || "no command"}`,
  );
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(
      JSON.stringify({
        event: "facility.aws.deploy.exit",
        errorCode: error?.code || "aws_deploy_failed",
        exitCode: Number.isSafeInteger(error?.exitCode) ? error.exitCode : 1,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = Number.isSafeInteger(error?.exitCode) ? error.exitCode : 1;
  });
}
