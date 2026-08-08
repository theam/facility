import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  AWS_ARTIFACT_NAMES,
  AWS_SERVICE_NAMES,
  createAwsCliAdapter,
  createAwsReleaseManifest,
  deployAws,
  enforceEcrScanPolicy,
  normalizeTerraformOutputs,
  taskDefinitionRegistration,
  validateAwsReleaseManifest,
} from "./deploy-aws.mjs";

test("ECR scan policy keeps basic scanning strict and gates enhanced actionable findings", () => {
  assert.throws(
    () =>
      enforceEcrScanPolicy(
        { findingSeverityCounts: { CRITICAL: 1, HIGH: 2 } },
        { enhanced: false, repository: "repo@digest" },
      ),
    (error) => error.code === "ecr_scan_blocked" && /1 critical and 2 high/.test(error.message),
  );

  assert.deepEqual(
    enforceEcrScanPolicy(
      {
        findingSeverityCounts: { CRITICAL: 1, HIGH: 1 },
        enhancedFindings: [
          { severity: "CRITICAL", fixAvailable: "NO" },
          { severity: "HIGH", fixAvailable: "NO" },
        ],
      },
      { enhanced: true, repository: "repo@digest" },
    ),
    {
      critical: 1,
      high: 1,
      actionableCritical: 0,
      actionableHigh: 0,
      enhanced: true,
    },
  );

  for (const fixAvailable of ["YES", "PARTIAL"]) {
    assert.throws(
      () =>
        enforceEcrScanPolicy(
          {
            findingSeverityCounts: { HIGH: 1 },
            enhancedFindings: [{ severity: "HIGH", fixAvailable }],
          },
          { enhanced: true, repository: "repo@digest" },
        ),
      (error) =>
        error.code === "ecr_scan_blocked" &&
        /0 critical and 1 high vulnerabilities have fixes available/.test(error.message),
    );
  }
});

test("ECR enhanced scan policy fails closed on malformed or incomplete findings", () => {
  for (const findings of [
    { findingSeverityCounts: { HIGH: 1 } },
    { findingSeverityCounts: { HIGH: 1 }, enhancedFindings: [] },
    {
      findingSeverityCounts: { HIGH: 1 },
      enhancedFindings: [{ severity: "HIGH", fixAvailable: undefined }],
    },
    { findingSeverityCounts: { HIGH: -1 }, enhancedFindings: [] },
  ]) {
    assert.throws(
      () =>
        enforceEcrScanPolicy(findings, {
          enhanced: true,
          repository: "repo@digest",
        }),
      (error) => error.code === "ecr_scan_invalid_response",
    );
  }
});

const account = "123456789012";
const region = "eu-west-1";
const prefix = `${account}.dkr.ecr.${region}.amazonaws.com/facility-test`;
const sourceSha = "a".repeat(40);
const digests = Object.fromEntries(
  AWS_ARTIFACT_NAMES.map((name, index) => [name, `sha256:${String(index + 1).repeat(64)}`]),
);

function manifestFixture() {
  return {
    schemaVersion: 1,
    sourceSha,
    platform: "linux/amd64",
    images: {
      api: `${prefix}/api@${digests.api}`,
      worker: `${prefix}/api@${digests.api}`,
      gateway: `${prefix}/gateway@${digests.gateway}`,
      web: `${prefix}/web@${digests.web}`,
      mcp: `${prefix}/mcp@${digests.mcp}`,
      runner: `${prefix}/runner@${digests.runner}`,
    },
  };
}

function outputFixture() {
  return {
    architecture: "X86_64",
    awsRegion: region,
    cluster: "facility-test",
    migrateTaskDefinitionArn:
      "arn:aws:ecs:eu-west-1:123456789012:task-definition/facility-test-migrate:7",
    repositories: Object.fromEntries(AWS_ARTIFACT_NAMES.map((name) => [name, `${prefix}/${name}`])),
    runnerProject: "facility-test-runner",
    sandboxDriver: "aws",
    securityGroup: "sg-123",
    serviceTaskDefinitions: Object.fromEntries(
      AWS_SERVICE_NAMES.map((name) => [
        name,
        `arn:aws:ecs:eu-west-1:123456789012:task-definition/facility-test-${name}:7`,
      ]),
    ),
    subnets: ["subnet-a", "subnet-b"],
  };
}

function rawOutputFixture() {
  const outputs = outputFixture();
  return {
    aws_region: { value: outputs.awsRegion },
    task_cpu_architecture: { value: outputs.architecture },
    sandbox_driver: { value: outputs.sandboxDriver },
    ecs_cluster_name: { value: outputs.cluster },
    codebuild_runner_project_name: { value: outputs.runnerProject },
    migrate_task_definition_arn: { value: outputs.migrateTaskDefinitionArn },
    service_security_group_id: { value: outputs.securityGroup },
    private_subnet_ids: { value: outputs.subnets },
    ecr_repository_urls: { value: outputs.repositories },
    service_task_definition_arns: { value: outputs.serviceTaskDefinitions },
  };
}

function serviceFixture(name, taskDefinition, desiredCount = 1) {
  return {
    deployments: [{ rolloutState: "COMPLETED", status: "PRIMARY" }],
    desiredCount,
    pendingCount: 0,
    runningCount: desiredCount,
    serviceName: name,
    status: "ACTIVE",
    taskDefinition,
  };
}

function templateFixture(role) {
  return {
    taskDefinition: {
      compatibilities: ["EC2", "FARGATE"],
      containerDefinitions: [
        {
          environment: [{ name: "TEMPLATE_REVISION", value: "terraform-rendered-7" }],
          essential: true,
          image: `${prefix}/${role === "migrate" ? "api" : role}:floating-template-tag`,
          name: role,
        },
      ],
      cpu: "512",
      executionRoleArn: "arn:execution",
      family: `facility-test-${role}`,
      memory: "1024",
      networkMode: "awsvpc",
      registeredAt: "2026-01-01T00:00:00.000Z",
      registeredBy: "arn:operator",
      requiresAttributes: [{ name: "ecs.capability.execution-role-ecr-pull" }],
      requiresCompatibilities: ["FARGATE"],
      revision: 7,
      runtimePlatform: { cpuArchitecture: "X86_64", operatingSystemFamily: "LINUX" },
      status: "ACTIVE",
      taskDefinitionArn: `arn:template:${role}:7`,
      taskRoleArn: "arn:task",
    },
  };
}

function fakeAws({
  assertImageError,
  desiredCount = 1,
  driftBeforeMutation = false,
  failCandidateUpdates = [],
  failRollbackUpdates = [],
  migrationError,
  migrationExitCodes = [0],
  registrationFailureRole,
  rolloutWaitFailure = false,
  pointerMismatchAfterWait = false,
  runnerImage = manifestFixture().images.runner,
  serviceDeploymentOverride,
  serviceRunningCountOverride,
} = {}) {
  const calls = [];
  const prior = Object.fromEntries(AWS_SERVICE_NAMES.map((name) => [name, `arn:prior:${name}:1`]));
  const current = { ...prior };
  const candidateByRole = {};
  const deregistered = [];
  let registrationIndex = 0;
  let migrationIndex = 0;
  let waitCount = 0;
  let describeCount = 0;
  let pointerMismatchInjected = false;

  const adapter = {
    calls,
    candidateByRole,
    current,
    deregistered,
    prior,
    async assertImage(repository, digest) {
      calls.push(["assertImage", repository, digest]);
      if (assertImageError) throw assertImageError;
    },
    async getRunnerImage(project) {
      calls.push(["getRunnerImage", project]);
      return runnerImage;
    },
    async describeServices(cluster, names) {
      calls.push(["describeServices", cluster, ...names]);
      describeCount += 1;
      if (driftBeforeMutation && describeCount === 2) current.api = "arn:foreign:api:9";
      if (pointerMismatchAfterWait && waitCount === 1 && !pointerMismatchInjected) {
        current.api = "arn:foreign:api:10";
        pointerMismatchInjected = true;
      }
      return names.map((name) => {
        const service = serviceFixture(name, current[name], desiredCount);
        if (serviceDeploymentOverride) service.deployments = serviceDeploymentOverride(name);
        if (serviceRunningCountOverride) {
          service.runningCount = serviceRunningCountOverride(name, service.runningCount);
        }
        return service;
      });
    },
    async describeTaskDefinition(arn) {
      calls.push(["describeTaskDefinition", arn]);
      const role = arn.match(/facility-test-([a-z]+):/)?.[1];
      return templateFixture(role);
    },
    async registerTaskDefinition(input) {
      const role = input.family.replace("facility-test-", "");
      calls.push(["registerTaskDefinition", role, structuredClone(input)]);
      if (role === registrationFailureRole) throw new Error(`cannot register ${role}`);
      registrationIndex += 1;
      const arn = `arn:candidate:${role}:${registrationIndex}`;
      candidateByRole[role] = arn;
      return arn;
    },
    async deregisterTaskDefinition(arn) {
      calls.push(["deregisterTaskDefinition", arn]);
      deregistered.push(arn);
    },
    async runMigration(input) {
      calls.push(["runMigration", structuredClone(input)]);
      if (migrationError) throw migrationError;
      const exitCode = migrationExitCodes[Math.min(migrationIndex, migrationExitCodes.length - 1)];
      migrationIndex += 1;
      return { attempt: migrationIndex, exitCode };
    },
    async updateService(cluster, name, taskDefinition) {
      calls.push(["updateService", cluster, name, taskDefinition]);
      if (taskDefinition.startsWith("arn:candidate:") && failCandidateUpdates.includes(name)) {
        throw new Error(`candidate update failed for ${name}`);
      }
      if (taskDefinition.startsWith("arn:prior:") && failRollbackUpdates.includes(name)) {
        throw new Error(`rollback failed for ${name}`);
      }
      current[name] = taskDefinition;
    },
    async waitServicesStable(cluster, names) {
      calls.push(["waitServicesStable", cluster, ...names]);
      waitCount += 1;
      if (rolloutWaitFailure && waitCount === 1) throw new Error("services did not stabilize");
    },
  };
  return adapter;
}

test("Bake metadata becomes one deterministic six-role ECR digest manifest", () => {
  const metadata = Object.fromEntries(
    AWS_ARTIFACT_NAMES.map((name) => [
      name,
      {
        "containerimage.descriptor": { digest: digests[name] },
        "containerimage.digest": digests[name],
      },
    ]),
  );
  metadata["service-packages"] = {};
  assert.deepEqual(
    createAwsReleaseManifest({
      metadata,
      platform: "linux/amd64",
      repositoryPrefix: prefix,
      sourceSha,
    }),
    manifestFixture(),
  );
  assert.throws(
    () =>
      createAwsReleaseManifest({
        metadata: { ...metadata, api: { ...metadata.api, "containerimage.digest": digests.web } },
        platform: "linux/amd64",
        repositoryPrefix: prefix,
        sourceSha,
      }),
    /descriptor for api does not match/,
  );
  assert.throws(
    () =>
      createAwsReleaseManifest({
        metadata: { ...metadata, unexpected: {} },
        platform: "linux/amd64",
        repositoryPrefix: prefix,
        sourceSha,
      }),
    /Bake metadata contains .*unexpected/,
  );
});

test("Terraform outputs and release manifest bind account, repositories, roles, and platform", () => {
  const outputs = normalizeTerraformOutputs(rawOutputFixture());
  assert.deepEqual(outputs, outputFixture());
  const invalidDriver = rawOutputFixture();
  invalidDriver.sandbox_driver.value = "local";
  assert.throws(
    () => normalizeTerraformOutputs(invalidDriver),
    (error) =>
      error.code === "terraform_outputs_invalid" && /must be aws or vercel/.test(error.message),
  );
  assert.equal(
    validateAwsReleaseManifest(manifestFixture(), outputs).parsedImages.api.digest,
    digests.api,
  );

  const invalid = [
    [
      {
        images: {
          ...manifestFixture().images,
          api: `${prefix}/api:latest`,
          worker: `${prefix}/api:latest`,
        },
      },
      /digest-only image reference/,
    ],
    [
      {
        images: {
          ...manifestFixture().images,
          gateway: `999999999999.dkr.ecr.${region}.amazonaws.com/foreign/gateway@${digests.gateway}`,
        },
      },
      /must come from/,
    ],
    [
      { images: { ...manifestFixture().images, worker: manifestFixture().images.gateway } },
      /worker must use the exact API/,
    ],
    [{ platform: "linux/arm64" }, /does not match X86_64/],
  ];
  for (const [override, message] of invalid) {
    const candidate = { ...manifestFixture(), ...override };
    assert.throws(() => validateAwsReleaseManifest(candidate, outputs), message);
  }
});

test("task registration copies Terraform configuration but strips AWS read-only fields", () => {
  const registration = taskDefinitionRegistration(
    templateFixture("api"),
    "api",
    manifestFixture().images.api,
  );
  assert.equal(registration.containerDefinitions[0].image, manifestFixture().images.api);
  assert.deepEqual(registration.containerDefinitions[0].environment, [
    { name: "TEMPLATE_REVISION", value: "terraform-rendered-7" },
  ]);
  for (const field of [
    "compatibilities",
    "registeredAt",
    "registeredBy",
    "requiresAttributes",
    "revision",
    "status",
    "taskDefinitionArn",
  ]) {
    assert.equal(registration[field], undefined, `${field} must not be registered`);
  }
});

test("successful deployment gates on migration and pins all five services in parallel", async () => {
  const aws = fakeAws();
  const events = [];
  const result = await deployAws({
    aws,
    log: (event) => events.push(event),
    manifest: manifestFixture(),
    outputs: outputFixture(),
  });
  assert.equal(result.outcome, "deployed");
  assert.deepEqual(
    aws.current,
    Object.fromEntries(AWS_SERVICE_NAMES.map((name) => [name, aws.candidateByRole[name]])),
  );
  assert.equal(aws.calls.filter(([name]) => name === "registerTaskDefinition").length, 6);
  assert.equal(aws.calls.filter(([name]) => name === "assertImage").length, 5);
  assert.deepEqual(aws.deregistered, [aws.candidateByRole.migrate]);
  const migrationCall = aws.calls.findIndex(([name]) => name === "runMigration");
  const firstUpdate = aws.calls.findIndex(([name]) => name === "updateService");
  assert.ok(migrationCall > -1 && migrationCall < firstUpdate);
  assert.equal(events.at(-1).status, "completed");
});

test("Vercel deployments exclude the inactive CodeBuild runner from release preflight", async () => {
  const aws = fakeAws({ runnerImage: "runner:must-not-be-read" });
  const outputs = { ...outputFixture(), sandboxDriver: "vercel" };
  await deployAws({ aws, manifest: manifestFixture(), outputs });

  assert.equal(
    aws.calls.some(([name]) => name === "getRunnerImage"),
    false,
  );
  const assertedRepositories = aws.calls
    .filter(([name]) => name === "assertImage")
    .map(([, repository]) => repository);
  assert.equal(assertedRepositories.length, 4);
  assert.equal(
    assertedRepositories.some((repository) => repository.endsWith("/runner")),
    false,
  );
});

for (const exitCode of [11, 12]) {
  test(`migration exit ${exitCode} aborts before every service mutation`, async () => {
    const aws = fakeAws({ migrationExitCodes: [exitCode] });
    await assert.rejects(
      deployAws({
        aws,
        manifest: manifestFixture(),
        outputs: outputFixture(),
        log: () => undefined,
      }),
      (error) => error.exitCode === exitCode && /no ECS service was changed/.test(error.message),
    );
    assert.equal(
      aws.calls.some(([name]) => name === "updateService"),
      false,
    );
    assert.equal(aws.deregistered.length, 6);
  });
}

test("migration lock timeout retries once before rollout", async () => {
  const aws = fakeAws({ migrationExitCodes: [10, 0] });
  await deployAws({
    aws,
    manifest: manifestFixture(),
    outputs: outputFixture(),
    log: () => undefined,
  });
  assert.equal(aws.calls.filter(([name]) => name === "runMigration").length, 2);
});

test("migration task infrastructure failure cleans inert revisions before aborting", async () => {
  const aws = fakeAws({ migrationError: new Error("waiter failed") });
  await assert.rejects(
    deployAws({ aws, manifest: manifestFixture(), outputs: outputFixture(), log: () => undefined }),
    /did not complete; no ECS service was changed/,
  );
  assert.equal(aws.deregistered.length, 6);
  assert.equal(
    aws.calls.some(([name]) => name === "updateService"),
    false,
  );
});

test("runner drift and an existing ECS rollout both fail before registration", async () => {
  for (const aws of [
    fakeAws({ runnerImage: `${prefix}/runner@sha256:${"f".repeat(64)}` }),
    fakeAws({ serviceDeploymentOverride: () => [{ rolloutState: "IN_PROGRESS" }] }),
    fakeAws({ serviceDeploymentOverride: () => [{ rolloutState: "FAILED" }] }),
    fakeAws({ serviceRunningCountOverride: (name, count) => (name === "api" ? 0 : count) }),
  ]) {
    await assert.rejects(
      deployAws({
        aws,
        manifest: manifestFixture(),
        outputs: outputFixture(),
        log: () => undefined,
      }),
      /CodeBuild runner|completed single-deployment state|running 0 of 1/,
    );
    assert.equal(
      aws.calls.some(([name]) => name === "registerTaskDefinition"),
      false,
    );
    assert.equal(
      aws.calls.some(([name]) => name === "updateService"),
      false,
    );
  }
});

test("a missing ECR digest aborts before task registration or service mutation", async () => {
  const aws = fakeAws({ assertImageError: new Error("image not found") });
  await assert.rejects(
    deployAws({ aws, manifest: manifestFixture(), outputs: outputFixture(), log: () => undefined }),
    /image not found/,
  );
  assert.equal(
    aws.calls.some(([name]) => name === "registerTaskDefinition"),
    false,
  );
  assert.equal(
    aws.calls.some(([name]) => name === "updateService"),
    false,
  );
});

test("service drift during migration aborts after the gate without overwriting the new pointer", async () => {
  const aws = fakeAws({ driftBeforeMutation: true });
  await assert.rejects(
    deployAws({ aws, manifest: manifestFixture(), outputs: outputFixture(), log: () => undefined }),
    /service state changed while the database gate ran/,
  );
  assert.equal(aws.current.api, "arn:foreign:api:9");
  assert.equal(
    aws.calls.some(([name]) => name === "updateService"),
    false,
  );
  assert.equal(aws.deregistered.length, 6);
});

test("zero desired count is explicit bootstrap staging, never a healthy certification", async () => {
  const denied = fakeAws({ desiredCount: 0 });
  await assert.rejects(
    deployAws({
      aws: denied,
      manifest: manifestFixture(),
      outputs: outputFixture(),
      log: () => undefined,
    }),
    /refusing to certify zero-desired services/,
  );
  const allowed = fakeAws({ desiredCount: 0 });
  const events = [];
  const result = await deployAws({
    allowZeroDesired: true,
    aws: allowed,
    log: (event) => events.push(event),
    manifest: manifestFixture(),
    outputs: outputFixture(),
  });
  assert.equal(result.outcome, "staged");
  assert.equal(
    allowed.calls.some(([name]) => name === "waitServicesStable"),
    false,
  );
  assert.equal(events.at(-1).status, "staged");
});

test("failed bootstrap staging restores zero-desired pointers without false running checks", async () => {
  const aws = fakeAws({ desiredCount: 0, failCandidateUpdates: ["api"] });
  await assert.rejects(
    deployAws({
      allowZeroDesired: true,
      aws,
      manifest: manifestFixture(),
      outputs: outputFixture(),
      log: () => undefined,
    }),
    (error) => error.exitCode === 21,
  );
  assert.deepEqual(aws.current, aws.prior);
  assert.equal(
    aws.calls.some(([name]) => name === "waitServicesStable"),
    false,
  );
});

test("failed rollout restores all five prior pointers and never rolls back the database", async () => {
  const aws = fakeAws({ rolloutWaitFailure: true });
  await assert.rejects(
    deployAws({ aws, manifest: manifestFixture(), outputs: outputFixture(), log: () => undefined }),
    (error) => error.exitCode === 21,
  );
  assert.deepEqual(aws.current, aws.prior);
  const rollbackUpdates = aws.calls.filter(
    ([name, , , taskDefinition]) =>
      name === "updateService" && taskDefinition?.startsWith("arn:prior:"),
  );
  assert.equal(rollbackUpdates.length, 5);
  assert.equal(aws.calls.filter(([name]) => name === "runMigration").length, 1);
  assert.equal(aws.deregistered.length, 6);
});

test("a final service pointer mismatch triggers complete service-only rollback", async () => {
  const aws = fakeAws({ pointerMismatchAfterWait: true });
  await assert.rejects(
    deployAws({ aws, manifest: manifestFixture(), outputs: outputFixture(), log: () => undefined }),
    (error) => error.exitCode === 21,
  );
  assert.deepEqual(aws.current, aws.prior);
  assert.equal(
    aws.calls.filter(
      ([name, , , taskDefinition]) =>
        name === "updateService" && taskDefinition?.startsWith("arn:prior:"),
    ).length,
    5,
  );
});

test("rollback attempts every service and preserves candidates when restoration is incomplete", async () => {
  const aws = fakeAws({ failCandidateUpdates: ["api"], failRollbackUpdates: ["web", "mcp"] });
  await assert.rejects(
    deployAws({ aws, manifest: manifestFixture(), outputs: outputFixture(), log: () => undefined }),
    (error) => error.exitCode === 22,
  );
  const rollbackUpdates = aws.calls.filter(
    ([name, , , taskDefinition]) =>
      name === "updateService" && taskDefinition?.startsWith("arn:prior:"),
  );
  assert.equal(rollbackUpdates.length, 5);
  assert.deepEqual(aws.deregistered, [aws.candidateByRole.migrate]);
});

test("partial registration failure removes every inert candidate and mutates no service", async () => {
  const aws = fakeAws({ registrationFailureRole: "gateway" });
  await assert.rejects(
    deployAws({ aws, manifest: manifestFixture(), outputs: outputFixture(), log: () => undefined }),
    /failed to register 1 AWS task definition/,
  );
  assert.equal(aws.deregistered.length, 5);
  assert.equal(
    aws.calls.some(([name]) => name === "runMigration"),
    false,
  );
  assert.equal(
    aws.calls.some(([name]) => name === "updateService"),
    false,
  );
});

test("CLI integration fails closed through deterministic Terraform and AWS process fakes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "facility-deploy-cli-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const terraformLog = join(directory, "terraform.log");
  const awsLog = join(directory, "aws.log");
  const manifestPath = join(directory, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifestFixture()));
  await writeFile(
    join(directory, "terraform"),
    `#!/usr/bin/env node
require("node:fs").appendFileSync(process.env.FAKE_TERRAFORM_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write(process.env.FAKE_TERRAFORM_OUTPUTS);
`,
  );
  await writeFile(
    join(directory, "aws"),
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_AWS_LOG, JSON.stringify(args) + "\\n");
const service = args[3];
const operation = args[4];
if (service === "ecr" && operation === "describe-images") {
  const digest = args[args.findIndex((arg) => arg.startsWith("imageDigest="))].slice("imageDigest=".length);
  process.stdout.write(JSON.stringify({ imageDetails: [{ imageDigest: digest }] }));
} else if (service === "ecr" && operation === "describe-image-scan-findings") {
  process.stdout.write(JSON.stringify({ imageScanStatus: { status: "COMPLETE" }, imageScanFindings: { findingSeverityCounts: {} } }));
} else if (service === "codebuild" && operation === "batch-get-projects") {
  process.stdout.write(JSON.stringify({ projects: [{ name: "facility-test-runner", environment: { image: "runner:wrong" } }] }));
} else if (service === "ecs" && operation === "describe-services") {
  const names = ${JSON.stringify(AWS_SERVICE_NAMES)};
  process.stdout.write(JSON.stringify({ services: names.map((name) => ({
    serviceName: name, status: "ACTIVE", desiredCount: 1, runningCount: 1, pendingCount: 0,
    taskDefinition: "arn:prior:" + name + ":1", deployments: [{ rolloutState: "COMPLETED" }]
  })), failures: [] }));
} else {
  process.stderr.write("unexpected mutating command " + service + " " + operation);
  process.exit(19);
}
`,
  );
  await chmod(join(directory, "terraform"), 0o755);
  await chmod(join(directory, "aws"), 0o755);

  const result = spawnSync(
    process.execPath,
    [
      resolve("scripts/deploy-aws.mjs"),
      "deploy",
      "--manifest",
      manifestPath,
      "--terraform-dir",
      directory,
    ],
    {
      cwd: resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        FAKE_AWS_LOG: awsLog,
        FAKE_TERRAFORM_LOG: terraformLog,
        FAKE_TERRAFORM_OUTPUTS: JSON.stringify(rawOutputFixture()),
      },
    },
  );
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /runner_image_mismatch/);
  const awsCalls = (await readFile(awsLog, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(
    awsCalls.some((args) => args.includes("register-task-definition")),
    false,
  );
  assert.equal(
    awsCalls.some((args) => args.includes("update-service")),
    false,
  );
  assert.match(await readFile(terraformLog, "utf8"), /output.*-json/);
});

test("CLI integration deploys Vercel mode without reading inactive CodeBuild or runner ECR", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "facility-deploy-cli-success-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const terraformLog = join(directory, "terraform.log");
  const awsLog = join(directory, "aws.log");
  const manifestPath = join(directory, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifestFixture()));
  await writeFile(
    join(directory, "terraform"),
    `#!/usr/bin/env node
require("node:fs").appendFileSync(process.env.FAKE_TERRAFORM_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write(process.env.FAKE_TERRAFORM_OUTPUTS);
`,
  );
  await writeFile(
    join(directory, "aws"),
    `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_AWS_LOG, JSON.stringify(args) + "\\n");
const service = args[3];
const operation = args[4];
const value = (flag) => args[args.indexOf(flag) + 1];
if (service === "ecr" && operation === "describe-images") {
  const digest = args[args.findIndex((arg) => arg.startsWith("imageDigest="))].slice("imageDigest=".length);
  process.stdout.write(JSON.stringify({ imageDetails: [{ imageDigest: digest }] }));
} else if (service === "ecr" && operation === "describe-image-scan-findings") {
  process.stdout.write(JSON.stringify({ imageScanStatus: { status: "COMPLETE" }, imageScanFindings: { findingSeverityCounts: {} } }));
} else if (service === "codebuild" && operation === "batch-get-projects") {
  process.stdout.write(JSON.stringify({ projects: [{ name: "facility-test-runner", environment: { image: process.env.FAKE_RUNNER_IMAGE } }] }));
} else if (service === "ecs" && operation === "describe-services") {
  const calls = readFileSync(process.env.FAKE_AWS_LOG, "utf8").trim().split("\\n").map(JSON.parse);
  const names = ${JSON.stringify(AWS_SERVICE_NAMES)};
  const updates = calls.filter((call) => call[3] === "ecs" && call[4] === "update-service");
  process.stdout.write(JSON.stringify({ services: names.map((name) => {
    const update = updates.filter((call) => call[call.indexOf("--service") + 1] === name).at(-1);
    const taskDefinition = update ? update[update.indexOf("--task-definition") + 1] : "arn:prior:" + name + ":1";
    return { serviceName: name, status: "ACTIVE", desiredCount: 1, runningCount: 1, pendingCount: 0, taskDefinition, deployments: [{ rolloutState: "COMPLETED" }] };
  }), failures: [] }));
} else if (service === "ecs" && operation === "describe-task-definition") {
  const arn = value("--task-definition");
  const role = arn.match(/facility-test-([a-z]+):/)?.[1];
  process.stdout.write(JSON.stringify({ taskDefinition: {
    taskDefinitionArn: arn, revision: 7, status: "ACTIVE", registeredAt: "2026-01-01", registeredBy: "operator",
    compatibilities: ["FARGATE"], requiresAttributes: [], family: "facility-test-" + role,
    networkMode: "awsvpc", requiresCompatibilities: ["FARGATE"], cpu: "512", memory: "1024",
    executionRoleArn: "arn:execution", taskRoleArn: "arn:task",
    runtimePlatform: { cpuArchitecture: "X86_64", operatingSystemFamily: "LINUX" },
    containerDefinitions: [{ name: role, image: "template:tag", essential: true, environment: [{ name: "FROM_TERRAFORM", value: "yes" }] }]
  } }));
} else if (service === "ecs" && operation === "register-task-definition") {
  const input = JSON.parse(readFileSync(value("--cli-input-json").slice("file://".length), "utf8"));
  process.stdout.write(JSON.stringify({ taskDefinition: { taskDefinitionArn: "arn:candidate:" + input.family.replace("facility-test-", "") + ":8" } }));
} else if (service === "ecs" && operation === "run-task") {
  process.stdout.write(JSON.stringify({ tasks: [{ taskArn: "arn:task:migrate:1" }], failures: [] }));
} else if (service === "ecs" && operation === "describe-tasks") {
  process.stdout.write(JSON.stringify({ tasks: [{ taskArn: "arn:task:migrate:1", lastStatus: "STOPPED", containers: [{ name: "migrate", exitCode: 0 }] }], failures: [] }));
} else if (service === "ecs" && operation === "update-service") {
  process.stdout.write(JSON.stringify({ service: { serviceName: value("--service"), taskDefinition: value("--task-definition") } }));
} else if (service === "ecs" && operation === "deregister-task-definition") {
  process.stdout.write(JSON.stringify({ taskDefinition: { taskDefinitionArn: value("--task-definition"), status: "INACTIVE" } }));
} else if (service === "ecs" && operation === "wait") {
  // AWS waiters deliberately have no JSON output.
} else {
  process.stderr.write("unexpected command " + service + " " + operation);
  process.exit(19);
}
`,
  );
  await chmod(join(directory, "terraform"), 0o755);
  await chmod(join(directory, "aws"), 0o755);

  const rawOutputs = rawOutputFixture();
  rawOutputs.sandbox_driver.value = "vercel";
  const result = spawnSync(
    process.execPath,
    [
      resolve("scripts/deploy-aws.mjs"),
      "deploy",
      "--manifest",
      manifestPath,
      "--terraform-dir",
      directory,
    ],
    {
      cwd: resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        FAKE_AWS_LOG: awsLog,
        FAKE_TERRAFORM_LOG: terraformLog,
        FAKE_TERRAFORM_OUTPUTS: JSON.stringify(rawOutputs),
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const events = result.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(events.at(-1).status, "completed");
  const awsCalls = (await readFile(awsLog, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(awsCalls.filter((args) => args.includes("register-task-definition")).length, 6);
  assert.equal(awsCalls.filter((args) => args.includes("update-service")).length, 5);
  assert.equal(
    awsCalls.filter((args) => args.includes("describe-images")).length,
    4,
    "only the four control-plane image digests execute in Vercel mode",
  );
  assert.equal(
    awsCalls.some((args) => args.includes("batch-get-projects")),
    false,
    "inactive CodeBuild must not gate a Vercel release",
  );
  assert.equal(
    awsCalls.some((args) => args.includes("facility-test/runner")),
    false,
    "inactive runner ECR findings must not gate a Vercel release",
  );
  assert.ok(
    awsCalls.findIndex((args) => args.includes("run-task")) <
      awsCalls.findIndex((args) => args.includes("update-service")),
  );
  assert.equal(
    awsCalls.some((args) => args.includes("wait")),
    false,
    "deployment must use the operator timeout, not AWS's fixed-budget waiters",
  );
  assert.equal(awsCalls.filter((args) => args.includes("deregister-task-definition")).length, 1);
});

test("AWS CLI adapter maps missing images, projects, services, and task starts to stable denials", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "facility-aws-adapter-denials-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const command = join(directory, "aws");
  await writeFile(
    command,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const service = args[3];
const operation = args[4];
if (service === "ecr" && operation === "describe-images") {
  process.stdout.write(JSON.stringify({ imageDetails: [] }));
} else if (service === "codebuild" && operation === "batch-get-projects") {
  process.stdout.write(JSON.stringify({ projects: [], projectsNotFound: ["missing"] }));
} else if (service === "ecs" && operation === "describe-services") {
  process.stdout.write(JSON.stringify({ services: [], failures: [{ reason: "MISSING" }] }));
} else if (service === "ecs" && operation === "run-task") {
  process.stdout.write(JSON.stringify({ tasks: [], failures: [{ reason: "RESOURCE" }] }));
} else {
  process.stderr.write("unexpected adapter command " + service + " " + operation);
  process.exit(19);
}
`,
  );
  await chmod(command, 0o755);
  const aws = createAwsCliAdapter({
    awsCommand: command,
    commandTimeoutMs: 1_000,
    pollIntervalMs: 1,
    region,
  });
  await assert.rejects(aws.assertImage(`${prefix}/api`, digests.api), /does not exist in ECR/);
  await assert.rejects(aws.getRunnerImage("missing"), /was not returned/);
  await assert.rejects(aws.describeServices("cluster", AWS_SERVICE_NAMES), /could not describe/);
  await assert.rejects(
    aws.runMigration({
      cluster: "cluster",
      securityGroup: "sg-123",
      sourceSha,
      subnets: ["subnet-a", "subnet-b"],
      taskDefinition: "arn:migrate",
    }),
    /did not start exactly one/,
  );
});

test("AWS CLI adapter waits for usable ECR findings and blocks vulnerable digests", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "facility-aws-image-scan-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const awsLog = join(directory, "aws.log");
  const command = join(directory, "aws");
  await writeFile(
    command,
    `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
const service = args[3];
const operation = args[4];
appendFileSync(${JSON.stringify(awsLog)}, JSON.stringify(args) + "\\n");
if (service === "ecr" && operation === "describe-images") {
  const digest = args[args.findIndex((arg) => arg.startsWith("imageDigest="))].slice("imageDigest=".length);
  process.stdout.write(JSON.stringify({ imageDetails: [{ imageDigest: digest }] }));
} else if (service === "ecr" && operation === "describe-image-scan-findings") {
  const calls = readFileSync(${JSON.stringify(awsLog)}, "utf8").trim().split("\\n").map(JSON.parse);
  const scanCalls = calls.filter((call) => call[3] === "ecr" && call[4] === "describe-image-scan-findings");
  const status = scanCalls.length === 1 ? "IN_PROGRESS" : "ACTIVE";
  const completed = scanCalls.length >= 3 ? { imageScanCompletedAt: "2026-08-07T00:00:00Z" } : {};
  process.stdout.write(JSON.stringify({ imageScanStatus: { status }, imageScanFindings: { ...completed, findingSeverityCounts: {}, enhancedFindings: [] } }));
} else {
  process.stderr.write("unexpected adapter command " + service + " " + operation);
  process.exit(19);
}
`,
  );
  await chmod(command, 0o755);
  const aws = createAwsCliAdapter({
    awsCommand: command,
    commandTimeoutMs: 1_000,
    pollIntervalMs: 1,
    region,
  });
  await aws.assertImage(`${prefix}/api`, digests.api);
  const calls = (await readFile(awsLog, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(calls.filter((args) => args.includes("describe-image-scan-findings")).length, 3);

  await writeFile(
    command,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const service = args[3];
const operation = args[4];
if (service === "ecr" && operation === "describe-images") {
  const digest = args[args.findIndex((arg) => arg.startsWith("imageDigest="))].slice("imageDigest=".length);
  process.stdout.write(JSON.stringify({ imageDetails: [{ imageDigest: digest }] }));
} else if (service === "ecr" && operation === "describe-image-scan-findings") {
  process.stdout.write(JSON.stringify({ imageScanStatus: { status: "COMPLETE" }, imageScanFindings: { findingSeverityCounts: { CRITICAL: 1, HIGH: 2 } } }));
} else {
  process.stderr.write("unexpected adapter command " + service + " " + operation);
  process.exit(19);
}
`,
  );
  await chmod(command, 0o755);
  await assert.rejects(
    aws.assertImage(`${prefix}/api`, digests.api),
    (error) => error.code === "ecr_scan_blocked" && /1 critical and 2 high/.test(error.message),
  );
});

test("AWS CLI adapter detects COMPLETE enhanced scans and admits only non-fixable findings", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "facility-aws-enhanced-image-scan-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const command = join(directory, "aws");
  await writeFile(
    command,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const service = args[3];
const operation = args[4];
const repository = args[args.indexOf("--repository-name") + 1];
if (service === "ecr" && operation === "describe-images") {
  const digest = args[args.findIndex((arg) => arg.startsWith("imageDigest="))].slice("imageDigest=".length);
  process.stdout.write(JSON.stringify({ imageDetails: [{ imageDigest: digest }] }));
} else if (service === "ecr" && operation === "describe-image-scan-findings") {
  const fixAvailable = repository.endsWith("/api") ? "NO" : repository.endsWith("/gateway") ? "YES" : undefined;
  process.stdout.write(JSON.stringify({
    imageScanStatus: { status: "COMPLETE" },
    imageScanFindings: {
      imageScanCompletedAt: "2026-08-07T00:00:00Z",
      findingSeverityCounts: { HIGH: 1 },
      enhancedFindings: [{ severity: "HIGH", ...(fixAvailable ? { fixAvailable } : {}) }]
    }
  }));
} else {
  process.stderr.write("unexpected adapter command " + service + " " + operation);
  process.exit(19);
}
`,
  );
  await chmod(command, 0o755);
  const aws = createAwsCliAdapter({
    awsCommand: command,
    commandTimeoutMs: 1_000,
    pollIntervalMs: 1,
    region,
  });

  await aws.assertImage(`${prefix}/api`, digests.api);
  await assert.rejects(
    aws.assertImage(`${prefix}/gateway`, digests.gateway),
    (error) =>
      error.code === "ecr_scan_blocked" && /1 high vulnerabilities have fixes/.test(error.message),
  );
  await assert.rejects(
    aws.assertImage(`${prefix}/mcp`, digests.mcp),
    (error) => error.code === "ecr_scan_invalid_response",
  );
});

test("AWS CLI adapter retries until a just-started migration task becomes visible", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "facility-aws-task-visibility-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const awsLog = join(directory, "aws.log");
  const command = join(directory, "aws");
  await writeFile(
    command,
    `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
const logPath = ${JSON.stringify(awsLog)};
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const service = args[3];
const operation = args[4];
if (service === "ecs" && operation === "run-task") {
  process.stdout.write(JSON.stringify({ tasks: [{ taskArn: "arn:task:migrate:visible" }], failures: [] }));
} else if (service === "ecs" && operation === "describe-tasks") {
  const calls = readFileSync(logPath, "utf8").trim().split("\\n").map(JSON.parse);
  const descriptions = calls.filter((call) => call[3] === "ecs" && call[4] === "describe-tasks");
  const task = { taskArn: "arn:task:migrate:visible", lastStatus: "STOPPED", containers: [{ name: "migrate", exitCode: 0 }] };
  const response = descriptions.length === 1
    ? { tasks: [], failures: [{ arn: task.taskArn, reason: "MISSING" }] }
    : descriptions.length === 2
      ? { tasks: [], failures: [] }
      : { tasks: [task], failures: [] };
  process.stdout.write(JSON.stringify(response));
} else {
  process.stderr.write("unexpected adapter command " + service + " " + operation);
  process.exit(19);
}
`,
  );
  await chmod(command, 0o755);
  const aws = createAwsCliAdapter({
    awsCommand: command,
    commandTimeoutMs: 1_000,
    pollIntervalMs: 1,
    region,
  });

  const result = await aws.runMigration({
    cluster: "cluster",
    securityGroup: "sg-123",
    sourceSha,
    subnets: ["subnet-a", "subnet-b"],
    taskDefinition: "arn:migrate",
  });
  assert.equal(result.exitCode, 0);
  const calls = (await readFile(awsLog, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(calls.filter((args) => args.includes("describe-tasks")).length, 3);
});
