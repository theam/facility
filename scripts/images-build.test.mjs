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
  await chmod(join(directory, "docker"), 0o755);
  await chmod(join(directory, "aws"), 0o755);
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
