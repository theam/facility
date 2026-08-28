import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "infra", "build-images.sh");

async function fakeCommands(t) {
  const directory = await mkdtemp(join(tmpdir(), "facility-build-images-"));
  const dockerLog = join(directory, "docker.jsonl");
  const awsLog = join(directory, "aws.jsonl");
  await writeFile(
    join(directory, "docker"),
    `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const stdin = args[0] === "login" ? readFileSync(0, "utf8") : null;
appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify({
  args,
  cwd: process.cwd(),
  env: Object.fromEntries(["ECR_REGISTRY", "ECR_PREFIX", "IMAGE_TAG", "PLATFORM"].map((name) => [name, process.env[name] ?? null])),
  stdin,
}) + "\\n");
if (args[0] === "buildx" && args[1] === "version" && process.env.FAKE_BUILDX_UNAVAILABLE === "1") process.exit(17);
if (args[0] === "buildx" && args[1] === "bake") {
  const metadataPath = args[args.indexOf("--metadata-file") + 1];
  const metadata = Object.fromEntries(["api", "gateway", "mcp", "web", "runner"].map((name, index) => {
    const digest = "sha256:" + String(index + 1).repeat(64);
    return [name, { "containerimage.digest": digest, "containerimage.descriptor": { digest } }];
  }));
  metadata["service-packages"] = {};
  writeFileSync(metadataPath, JSON.stringify(metadata));
}
`,
  );
  await writeFile(
    join(directory, "aws"),
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_AWS_LOG, JSON.stringify({ args }) + "\\n");
if (args[0] === "ecr" && args[1] === "get-login-password") process.stdout.write("registry-password\\n");
`,
  );
  await writeFile(
    join(directory, "git"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("status")) {
  if (process.env.FAKE_GIT_DIRTY === "1") process.stdout.write(" M services/api/src/index.ts\\n");
} else if (args.includes("rev-parse")) {
  process.stdout.write(args.includes("--short") ? "abc123def456\\n" : "${"a".repeat(40)}\\n");
} else {
  process.stderr.write("unexpected git command " + args.join(" "));
  process.exit(19);
}
`,
  );
  await chmod(join(directory, "docker"), 0o755);
  await chmod(join(directory, "aws"), 0o755);
  await chmod(join(directory, "git"), 0o755);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, dockerLog, awsLog };
}

function environment(fake, overrides = {}) {
  return {
    ...process.env,
    PATH: `${fake.directory}:${process.env.PATH}`,
    FAKE_DOCKER_LOG: fake.dockerLog,
    FAKE_AWS_LOG: fake.awsLog,
    AWS_ACCOUNT_ID: "123456789012",
    AWS_REGION: "eu-west-1",
    ECR_REGISTRY: "123456789012.dkr.ecr.eu-west-1.amazonaws.com",
    ECR_PREFIX: "facility-test",
    IMAGE_TAG: "abc123def456",
    CPU_ARCHITECTURE: "X86_64",
    PLATFORM: "linux/amd64",
    SOURCE_SHA: "a".repeat(40),
    MANIFEST_PATH: join(fake.directory, "release-manifest.json"),
    ...overrides,
  };
}

function run(fake, overrides = {}) {
  return spawnSync("bash", [script], {
    cwd: root,
    encoding: "utf8",
    env: environment(fake, overrides),
  });
}

async function invocations(path) {
  try {
    return (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

test("AWS fallback builds the complete image set through one Bake graph", async (t) => {
  const fake = await fakeCommands(t);
  const result = run(fake);
  assert.equal(result.status, 0, result.stderr);

  const docker = await invocations(fake.dockerLog);
  assert.deepEqual(
    docker.map(({ args }) => args.slice(0, 2)),
    [
      ["buildx", "version"],
      ["login", "--username"],
      ["buildx", "bake"],
    ],
  );
  const bake = docker[2];
  assert.deepEqual(bake.args, [
    "buildx",
    "bake",
    "--allow=fs.read=..",
    "--file",
    join(root, "infra", "docker-bake.hcl"),
    "--metadata-file",
    bake.args[6],
    "--push",
  ]);
  assert.match(bake.args[6], /^.*\/\.tmp\/facility-bake-metadata\.[A-Za-z0-9]+$/);
  assert.equal(bake.cwd, join(root, "infra"));
  assert.deepEqual(bake.env, {
    ECR_REGISTRY: "123456789012.dkr.ecr.eu-west-1.amazonaws.com",
    ECR_PREFIX: "facility-test",
    IMAGE_TAG: "abc123def456",
    PLATFORM: "linux/amd64",
  });
  assert.equal(docker[1].stdin, "registry-password\n");
  assert.deepEqual(await invocations(fake.awsLog), [
    { args: ["ecr", "get-login-password", "--region", "eu-west-1"] },
  ]);
  assert.deepEqual(result.stdout.trim().split("\n"), [
    "api=123456789012.dkr.ecr.eu-west-1.amazonaws.com/facility-test/api:abc123def456",
    "worker=123456789012.dkr.ecr.eu-west-1.amazonaws.com/facility-test/api:abc123def456",
    "gateway=123456789012.dkr.ecr.eu-west-1.amazonaws.com/facility-test/gateway:abc123def456",
    "mcp=123456789012.dkr.ecr.eu-west-1.amazonaws.com/facility-test/mcp:abc123def456",
    "web=123456789012.dkr.ecr.eu-west-1.amazonaws.com/facility-test/web:abc123def456",
    "runner=123456789012.dkr.ecr.eu-west-1.amazonaws.com/facility-test/runner:abc123def456",
    `manifest=${join(fake.directory, "release-manifest.json")}`,
  ]);
  const manifest = JSON.parse(
    await readFile(join(fake.directory, "release-manifest.json"), "utf8"),
  );
  assert.deepEqual(manifest, {
    schemaVersion: 1,
    sourceSha: "a".repeat(40),
    platform: "linux/amd64",
    images: {
      api: `123456789012.dkr.ecr.eu-west-1.amazonaws.com/facility-test/api@sha256:${"1".repeat(64)}`,
      worker: `123456789012.dkr.ecr.eu-west-1.amazonaws.com/facility-test/api@sha256:${"1".repeat(64)}`,
      gateway: `123456789012.dkr.ecr.eu-west-1.amazonaws.com/facility-test/gateway@sha256:${"2".repeat(64)}`,
      mcp: `123456789012.dkr.ecr.eu-west-1.amazonaws.com/facility-test/mcp@sha256:${"3".repeat(64)}`,
      web: `123456789012.dkr.ecr.eu-west-1.amazonaws.com/facility-test/web@sha256:${"4".repeat(64)}`,
      runner: `123456789012.dkr.ecr.eu-west-1.amazonaws.com/facility-test/runner@sha256:${"5".repeat(64)}`,
    },
  });
  assert.equal((await stat(join(fake.directory, "release-manifest.json"))).mode & 0o777, 0o600);
});

test("Bake keeps thin target boundaries and publishes every target through one graph", async () => {
  const bake = await readFile(join(root, "infra", "docker-bake.hcl"), "utf8");
  const publish = await readFile(join(root, "infra", "docker-bake.publish.hcl"), "utf8");
  assert.match(
    bake,
    /group "default" \{[\s\S]*targets = \["api", "gateway", "mcp", "web", "runner"\]/,
  );
  assert.match(bake, /target "api" \{[\s\S]*\/api:\$\{IMAGE_TAG\}/);
  assert.doesNotMatch(bake, /\/worker:\$\{IMAGE_TAG\}/);
  assert.doesNotMatch(bake, /target "worker"/);
  assert.match(bake, /target "gateway" \{[\s\S]*target\s+= "gateway"/);
  assert.match(bake, /target "mcp" \{[\s\S]*target\s+= "mcp"/);
  assert.match(bake, /target "service-packages" \{[\s\S]*target\s+= "build-service-packages"/);
  for (const image of ["api", "gateway", "mcp"]) {
    assert.match(
      bake,
      new RegExp(
        `target "${image}" \\{[\\s\\S]*?contexts = \\{ build-service-packages = "target:service-packages" \\}`,
      ),
    );
  }
  assert.match(bake, /target "web" \{[\s\S]*dockerfile = "apps\/web\/Dockerfile"/);
  assert.match(bake, /target "runner" \{[\s\S]*dockerfile = "runner\/Dockerfile"/);
  assert.match(bake, /target "service" \{[\s\S]*?attest\s+= \["type=provenance,disabled=true"\]/);
  for (const image of ["web", "runner"]) {
    assert.match(
      bake,
      new RegExp(
        `target "${image}" \\{[\\s\\S]*?attest\\s+= \\["type=provenance,disabled=true"\\]`,
      ),
    );
  }
  for (const image of ["api", "gateway", "mcp", "web", "runner"]) {
    assert.match(publish, new RegExp(`target "${image}" \\{`));
    assert.match(publish, new RegExp(`/${image},push-by-digest=true`));
    assert.match(publish, new RegExp(`scope=facility-${image}`));
  }
  assert.doesNotMatch(publish, /attest\s+=/);
  assert.doesNotMatch(publish, /target "control"|\/control,/);

  const dockerignore = await readFile(join(root, ".dockerignore"), "utf8");
  assert.match(dockerignore, /^\*\*\/\.terraform$/m);
  assert.match(dockerignore, /^\*\*\/\*\.tfstate\.\*$/m);

  const controlDockerfile = await readFile(join(root, "Dockerfile"), "utf8");
  const webDockerfile = await readFile(join(root, "apps/web/Dockerfile"), "utf8");
  const runnerDockerfile = await readFile(join(root, "runner/Dockerfile"), "utf8");
  const runnerGrypePolicy = await readFile(join(root, "runner/grype.yaml"), "utf8");
  const pnpmWorkspace = await readFile(join(root, "pnpm-workspace.yaml"), "utf8");
  const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const agentCliPackage = JSON.parse(
    await readFile(join(root, "runner", "agent-clis", "package.json"), "utf8"),
  );
  const agentCliLock = JSON.parse(
    await readFile(join(root, "runner", "agent-clis", "package-lock.json"), "utf8"),
  );
  const runtimeBuildPackages = await Promise.all(
    [
      "packages/core/package.json",
      "packages/db/package.json",
      "packages/harness/package.json",
      "packages/sdk/package.json",
      "packages/mcp/package.json",
      "services/api/package.json",
      "services/gateway/package.json",
    ].map(async (path) => JSON.parse(await readFile(join(root, path), "utf8"))),
  );
  for (const [name, dockerfile] of [
    ["service", controlDockerfile],
    ["web", webDockerfile],
    ["runner", runnerDockerfile],
  ]) {
    assert.match(
      dockerfile,
      /ARG DEBIAN_SECURITY_REFRESH=20260828\s+RUN test -n "\$DEBIAN_SECURITY_REFRESH" \\\s+&& apt-get update \\\s+&& DEBIAN_FRONTEND=noninteractive apt-get upgrade -y/,
      `${name} image must invalidate its cached Debian upgrade at the reviewed security epoch`,
    );
  }
  assert.doesNotMatch(webDockerfile, /^COPY \. \.$/m);
  assert.match(pnpmWorkspace, /^allowUnusedPatches: \$\{FACILITY_ALLOW_UNUSED_PATCHES-false\}$/m);
  for (const dockerfile of [controlDockerfile, webDockerfile]) {
    const installPosition = dockerfile.indexOf(" install --frozen-lockfile");
    assert.ok(
      dockerfile.indexOf("COPY pnpm-lock.yaml") < dockerfile.indexOf("COPY patches ./patches"),
    );
    assert.ok(dockerfile.indexOf("COPY patches ./patches") < installPosition);
    assert.ok(
      dockerfile.indexOf("ENV FACILITY_ALLOW_UNUSED_PATCHES=true") < installPosition,
      "filtered image commands must explicitly allow the omitted docs-only patch",
    );
  }
  assert.ok(
    webDockerfile.indexOf(" install --frozen-lockfile") <
      webDockerfile.indexOf("COPY apps/web apps/web"),
  );
  assert.equal(rootPackage.packageManager, "pnpm@11.20.0");
  const sharedServiceBuild = controlDockerfile.match(
    /FROM deps AS build-service-packages\n([\s\S]*?)(?=\nFROM )/,
  )?.[1];
  assert.ok(sharedServiceBuild, "service images must share one workspace-package build stage");
  for (const packageName of ["core", "db", "harness", "sdk"]) {
    assert.match(sharedServiceBuild, new RegExp(`@facility/${packageName}`));
  }
  for (const [stage, packageName] of [
    ["build-api", "api"],
    ["build-gateway", "gateway"],
    ["build-mcp", "mcp"],
  ]) {
    const serviceBuild = controlDockerfile.match(
      new RegExp(`FROM build-service-packages AS ${stage}\\n([\\s\\S]*?)(?=\\nFROM )`),
    )?.[1];
    assert.ok(serviceBuild, `${stage} must inherit the shared workspace build`);
    assert.match(
      serviceBuild,
      new RegExp(`pnpm --filter '@facility/${packageName}' run build:runtime(?:\\s|$)`),
    );
    for (const sharedPackage of ["core", "db", "harness", "sdk"]) {
      assert.doesNotMatch(serviceBuild, new RegExp(`--filter '@facility/${sharedPackage}'`));
    }
    assert.match(serviceBuild, /--config\.inject-workspace-packages=true/);
    assert.match(serviceBuild, new RegExp(`deploy --prod /prod/${packageName}`));
    assert.doesNotMatch(serviceBuild, /deploy --prod --legacy/);
  }
  assert.ok(
    controlDockerfile.indexOf("COPY --from=build-api /prod/api /app") <
      controlDockerfile.indexOf('await import("@facility/db/deploy")'),
    "the final API stage must import the deployed DB package after build workspaces are gone",
  );
  assert.equal(
    controlDockerfile.match(/run build:runtime/g)?.length,
    4,
    "the shared stage and three service stages must omit declaration-only work",
  );
  assert.match(
    webDockerfile,
    /pnpm --filter '@facility\/sdk\.\.\.' run build:runtime && pnpm --filter '@facility\/web' build/,
  );
  for (const packageJson of runtimeBuildPackages) {
    assert.match(packageJson.scripts.build, / --dts(?: |$)/);
    assert.equal(
      packageJson.scripts["build:runtime"],
      packageJson.scripts.build.replace(" --dts", ""),
      `${packageJson.name} runtime build must differ only by declaration emission`,
    );
  }
  for (const [dockerfile, targets] of [
    [controlDockerfile, ["api", "gateway", "mcp"]],
    [webDockerfile, ["web"]],
  ]) {
    assert.match(dockerfile, /FROM base AS runtime[\s\S]*runtime package manager remains/);
    assert.match(dockerfile, /rm -rf \/usr\/local\/include\/node/);
    assert.match(dockerfile, /\/usr\/local\/lib\/node_modules\/npm/);
    for (const target of targets) {
      assert.match(dockerfile, new RegExp(`FROM runtime AS ${target}`));
    }
  }
  assert.match(runnerDockerfile, /ARG NPM_VERSION=12\.0\.2/);
  assert.match(
    runnerDockerfile,
    /^FROM node:24-trixie-slim@sha256:[0-9a-f]{64} AS runner-base$/m,
    "the runner must use the digest-pinned official slim Node base",
  );
  assert.doesNotMatch(runnerDockerfile, /^FROM node:24-trixie@sha256:/m);
  for (const runtimePackage of ["build-essential", "pkg-config", "procps", "python3"]) {
    assert.match(
      runnerDockerfile,
      new RegExp(`^    ${runtimePackage.replace("-", "\\-")} \\\\?$`, "m"),
      `the slim runner must explicitly install ${runtimePackage}`,
    );
  }
  for (const patchedPackage of [
    "brace-expansion@5.0.9",
    "ip-address@10.3.1",
    "tar@7.5.21",
    "undici@6.28.0",
  ]) {
    assert.match(runnerDockerfile, new RegExp(patchedPackage.replace(".", "\\.")));
  }
  assert.match(
    runnerDockerfile,
    /COPY runner\/agent-clis\/package\.json runner\/agent-clis\/package-lock\.json/,
  );
  assert.match(runnerDockerfile, /npm ci --omit=dev/);
  assert.match(
    runnerDockerfile,
    /^FROM docker:29-dind-rootless@sha256:[0-9a-f]{64} AS docker-tools$/m,
  );
  assert.match(
    runnerDockerfile,
    /^FROM golang:1\.26\.6-trixie@sha256:[0-9a-f]{64} AS go-tools-base$/m,
  );
  for (const [parent, stage] of [
    ["go-tools-base", "moby-build"],
    ["moby-build", "docker-cli-build"],
    ["docker-cli-build", "containerd-build"],
    ["containerd-build", "rootlesskit-build"],
    ["rootlesskit-build", "buildx-build"],
    ["buildx-build", "compose-build"],
    ["compose-build", "runc-build"],
    ["runc-build", "gh-build"],
  ]) {
    assert.match(runnerDockerfile, new RegExp(`^FROM ${parent} AS ${stage}$`, "m"));
  }
  assert.match(runnerDockerfile, /^FROM gh-build AS go-tools-audit$/m);
  assert.equal((runnerDockerfile.match(/rm -rf \/src "\$archive"/g) ?? []).length, 8);
  assert.match(runnerDockerfile, /go version -m "\$binary"[\s\S]*go1\.26\.6/);
  assert.match(runnerDockerfile, /golang\.org\/x\/net[\s\S]*v0\.56\.0/);
  assert.equal(
    runnerDockerfile.match(/golang\.org\/x\/mod=golang\.org\/x\/mod@v0\.40\.0/g)?.length,
    5,
    "every copied Go tool with the vulnerable x/mod dependency must use the reviewed replacement",
  );
  assert.match(
    runnerDockerfile,
    /github\.com\/moby\/go-archive=github\.com\/moby\/go-archive@v0\.3\.0/,
  );
  assert.match(
    runnerDockerfile,
    /go version -m \/out\/docker-buildx[\s\S]*github\.com\/moby\/go-archive[\s\S]*v0\.3\.0/,
  );
  assert.match(runnerDockerfile, /COPY --from=go-tools-audit[\s\S]*\/usr\/local\/bin\//);
  assert.match(runnerDockerfile, /COPY --from=docker-tools \/usr\/local\/bin\//);
  assert.doesNotMatch(runnerDockerfile, /^\s+docker\.io\s+\\$/m);
  assert.doesNotMatch(runnerDockerfile, /^\s+rootlesskit\s+\\$/m);
  assert.match(runnerDockerfile, /GH_VERSION=2\.97\.0/);
  assert.match(
    runnerDockerfile,
    /GH_SOURCE_SHA256=c4ee0ab20406291616de45ad771c8b8a927bc8f3fd00ca61a50d0e8ffa582130/,
  );
  const riskRules = [
    ...runnerGrypePolicy.matchAll(
      /- vulnerability: ([^\n]+)\n\s+package:\n\s+name: ([^\n]+)\n\s+version: ([^\n]+)\n\s+type: ([^\n]+)\n\s+location: ([^\n]+)/g,
    ),
  ].map((match) => ({
    vulnerability: match[1],
    name: match[2],
    version: match[3],
    type: match[4],
    location: match[5],
  }));
  assert.equal([...runnerGrypePolicy.matchAll(/^\s+- vulnerability:/gm)].length, 14);
  assert.equal(riskRules.length, 14);
  const allowedLocations = new Set([
    "/usr/local/bin/containerd",
    "/usr/local/bin/containerd-shim-runc-v2",
    "/usr/local/bin/ctr",
    "/usr/local/bin/rootlesskit",
    "/usr/local/bin/runc",
    "/usr/local/libexec/docker/cli-plugins/docker-buildx",
    "/usr/local/libexec/docker/cli-plugins/docker-compose",
  ]);
  for (const rule of riskRules) {
    assert.match(rule.vulnerability, /^(?:GHSA-[a-z0-9-]+|GO-\d{4}-\d+)$/);
    assert.match(
      rule.name,
      /^(?:github\.com\/docker\/docker|golang\.org\/x\/(?:net|text)|google\.golang\.org\/grpc)$/,
    );
    assert.match(rule.version, /^v[^*\s]+$/);
    assert.equal(rule.type, "go-module");
    assert.ok(allowedLocations.has(rule.location));
  }
  for (const packageName of [
    "libasound2t64",
    "libatk-bridge2.0-0t64",
    "libatk1.0-0t64",
    "libatspi2.0-0t64",
    "libcups2t64",
    "libglib2.0-0t64",
    "uidmap",
    "fuse-overlayfs",
    "iptables",
  ]) {
    assert.match(
      runnerDockerfile,
      new RegExp(`^\\s+${packageName.replaceAll(".", "\\.")}\\s+\\\\$`, "m"),
    );
  }
  assert.deepEqual(agentCliPackage.dependencies, {
    "@anthropic-ai/claude-code": "2.1.215",
    "@openai/codex": "0.144.6",
  });
  assert.deepEqual(agentCliPackage.allowScripts, {
    "@anthropic-ai/claude-code@2.1.215": true,
  });
  assert.deepEqual(agentCliLock.packages[""].dependencies, agentCliPackage.dependencies);
  for (const packageName of Object.keys(agentCliPackage.dependencies)) {
    const locked = agentCliLock.packages[`node_modules/${packageName}`];
    assert.ok(locked);
    assert.match(locked.integrity, /^sha512-/);
  }
  for (const dockerfile of [controlDockerfile, webDockerfile, runnerDockerfile]) {
    const stages = new Set();
    const externalBases = [];
    for (const match of dockerfile.matchAll(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/gim)) {
      const reference = match[1];
      if (!stages.has(reference)) externalBases.push(reference);
      if (match[2]) stages.add(match[2]);
    }
    assert.ok(externalBases.length > 0);
    for (const base of externalBases) {
      assert.match(base, /@sha256:[0-9a-f]{64}$/);
    }
  }
});

for (const [name, overrides, message] of [
  ["platform mismatch", { PLATFORM: "linux/arm64" }, /does not match CPU_ARCHITECTURE/],
  ["invalid architecture", { CPU_ARCHITECTURE: "MIPS64" }, /must be X86_64 or ARM64/],
]) {
  test(`${name} fails before registry authentication`, async (t) => {
    const fake = await fakeCommands(t);
    const result = run(fake, overrides);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert.deepEqual(await invocations(fake.awsLog), []);
    assert.deepEqual(await invocations(fake.dockerLog), []);
  });
}

test("missing Buildx fails actionably before registry authentication", async (t) => {
  const fake = await fakeCommands(t);
  const result = run(fake, { FAKE_BUILDX_UNAVAILABLE: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Docker Buildx is required/);
  assert.deepEqual(await invocations(fake.awsLog), []);
  assert.deepEqual(
    (await invocations(fake.dockerLog)).map(({ args }) => args),
    [["buildx", "version"]],
  );
});

test("dirty release inputs fail before registry authentication unless explicitly acknowledged", async (t) => {
  const fake = await fakeCommands(t);
  const denied = run(fake, { FAKE_GIT_DIRTY: "1" });
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /Refusing to label uncommitted image bytes with SOURCE_SHA/);
  assert.deepEqual(await invocations(fake.awsLog), []);
  assert.deepEqual(await invocations(fake.dockerLog), []);

  const allowed = run(fake, { FAKE_GIT_DIRTY: "1", FACILITY_ALLOW_DIRTY_BUILD: "1" });
  assert.equal(allowed.status, 0, allowed.stderr);
});
