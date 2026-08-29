import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PACKAGE_NAME, publishTarball, registryState } from "./release.mjs";

const releaseScript = fileURLToPath(new URL("./release.mjs", import.meta.url));
const repoRoot = dirname(dirname(releaseScript));
const packagePath = `/${encodeURIComponent(PACKAGE_NAME)}`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "facility-release-test-"));
  const packageDir = join(root, "package");
  const tarball = join(root, "facility.tgz");
  const lifecycleMarker = join(root, "lifecycle-ran");
  const npmConfig = join(root, "npmrc");
  await mkdir(packageDir);
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({
      name: PACKAGE_NAME,
      version: "0.3.0",
      scripts: { prepublishOnly: "node lifecycle.mjs" },
    }),
  );
  await writeFile(
    join(packageDir, "lifecycle.mjs"),
    "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.RELEASE_LIFECYCLE_MARKER, 'ran');\n",
  );
  execFileSync("tar", ["-czf", tarball, "-C", root, "package"]);

  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return { root, tarball, lifecycleMarker, npmConfig };
}

async function fakeRegistry(t, { lookupStatus = 404, lookupBody, tokenStatus } = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const record = {
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body: Buffer.concat(chunks).toString("utf8"),
      responseStatus: undefined,
    };
    requests.push(record);

    response.setHeader("content-type", "application/json");
    if (request.method === "GET") {
      record.responseStatus = lookupStatus;
      response.statusCode = lookupStatus;
      response.end(
        lookupBody ??
          JSON.stringify(
            lookupStatus === 404
              ? { error: "not_found" }
              : { name: PACKAGE_NAME, versions: { "0.2.0": {} } },
          ),
      );
      return;
    }

    if (request.method === "PUT") {
      const status = tokenStatus?.(request.headers.authorization) ?? 201;
      record.responseStatus = status;
      response.statusCode = status;
      response.end(
        JSON.stringify(
          status < 400
            ? { ok: true }
            : { error: status === 403 ? "forbidden" : "unauthorized", reason: "bootstrap token rejected" },
        ),
      );
      return;
    }

    record.responseStatus = 404;
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/`;

  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections?.();
    });
  });
  return { requests, url };
}

async function release(args, env) {
  const [command, tarball, authOption] = args;
  const childArgs =
    command === "publish"
      ? [
          "--input-type=module",
          "--eval",
          `import { publishRelease } from ${JSON.stringify(new URL("./release.mjs", import.meta.url).href)};
           publishRelease({
             tarball: process.argv[1],
             authMode: process.argv[2],
             registryUrl: process.env.NPM_CONFIG_REGISTRY,
             allowNonOfficialRegistry: true,
           }).catch((error) => { console.error(error.message); process.exitCode = 1; });`,
          tarball,
          authOption?.slice("--auth=".length),
        ]
      : [releaseScript, ...args];
  const child = spawn(process.execPath, childArgs, {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stderr, stdout };
}

async function releaseCli(args, env) {
  const child = spawn(process.execPath, [releaseScript, ...args], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stderr };
}

async function npmEnvironment(fixtureState, registryUrl, token) {
  const registry = new URL(registryUrl);
  const authKey = `//${registry.host}${registry.pathname}:_authToken=\${NODE_AUTH_TOKEN}`;
  await writeFile(fixtureState.npmConfig, `registry=${registry.href}\n${authKey}\n`);
  const environment = {
    ...process.env,
    GITHUB_ACTIONS: "false",
    NODE_AUTH_TOKEN: token,
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_CACHE: join(fixtureState.root, "npm-cache"),
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_REGISTRY: registry.href,
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_USERCONFIG: fixtureState.npmConfig,
    RELEASE_LIFECYCLE_MARKER: fixtureState.lifecycleMarker,
  };
  delete environment.NPM_TOKEN;
  return environment;
}

async function assertMissing(path) {
  await assert.rejects(access(path), { code: "ENOENT" });
}

async function releaseAllocationScript() {
  const workflow = await readFile(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
  const allocationStep = workflow.split("      - name: Allocate the immutable release version\n")[1];
  assert(allocationStep, "CI workflow must contain the release-allocation step");
  const indentedScript = allocationStep.split("        run: |\n")[1];
  assert(indentedScript, "release-allocation step must contain a shell script");
  const lines = [];
  for (const line of indentedScript.split("\n")) {
    if (line && !line.startsWith("          ")) break;
    lines.push(line.startsWith("          ") ? line.slice(10) : line);
  }
  return lines.join("\n");
}

async function releaseRecordingScript() {
  const workflow = await readFile(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
  const recordStep = workflow.split("      - name: Tag the released commit and publish its notes\n")[1];
  assert(recordStep, "CI workflow must contain the release-recording step");
  const indentedScript = recordStep.split("        run: |\n")[1];
  assert(indentedScript, "release-recording step must contain a shell script");
  return indentedScript
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");
}

async function releaseCheckout(t) {
  const repoDir = await mkdtemp(join(tmpdir(), "facility-release-checkout-"));
  await mkdir(join(repoDir, "packages/cli"), { recursive: true });
  await writeFile(join(repoDir, "package.json"), '{"name":"facility","version":"0.3.0"}\n');
  await writeFile(
    join(repoDir, "packages/cli/package.json"),
    '{"name":"@theagilemonkeys/facility","version":"0.3.0"}\n',
  );
  const git = (args) =>
    execFileSync(
      "git",
      [
        "-c",
        "commit.gpgSign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Facility Tests",
        "-c",
        "user.email=facility-tests@example.invalid",
        ...args,
      ],
      {
        cwd: repoDir,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      },
    ).trim();
  git(["init", "--initial-branch=main"]);
  git(["add", "package.json", "packages/cli/package.json"]);
  git(["commit", "-m", "chore: establish the release fixture"]);
  const sha = git(["rev-parse", "HEAD"]);
  git(["update-ref", "refs/remotes/origin/main", sha]);
  t.after(() => rm(repoDir, { recursive: true, force: true }));
  return { repoDir, sha };
}

async function installNpmRecorder(fixtureState) {
  const bin = join(fixtureState.root, "bin");
  const command = join(bin, "npm");
  const invocation = join(fixtureState.root, "npm-invocation.json");
  await mkdir(bin);
  await writeFile(
    command,
    `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
writeFileSync(process.env.RELEASE_NPM_INVOCATION, JSON.stringify({
  args: process.argv.slice(2),
  credentials: {
    nodeAuthToken: process.env.NODE_AUTH_TOKEN ?? null,
    npmToken: process.env.NPM_TOKEN ?? null,
    configAuthToken: process.env.NPM_CONFIG_AUTH_TOKEN ?? null,
  },
  userConfig: readFileSync(process.env.NPM_CONFIG_USERCONFIG, "utf8"),
}));
`,
  );
  await chmod(command, 0o755);
  return { bin, invocation };
}

test("a fresh checkout must be stamped before the decided release validates", async (t) => {
  const checkout = await releaseCheckout(t);
  const env = {
    ...process.env,
    FACILITY_RELEASE_VERSION: "0.4.0",
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY_VISIBILITY: "public",
    GITHUB_SHA: checkout.sha,
  };

  const unstamped = await releaseCli(["validate", checkout.repoDir], env);
  assert.equal(unstamped.code, 1);
  assert.match(unstamped.stderr, /stamped version 0\.3\.0 does not match the decided version 0\.4\.0/);

  const stamp = await releaseCli(["stamp", "0.4.0", checkout.repoDir], env);
  assert.equal(stamp.code, 0, stamp.stderr);
  const validated = await releaseCli(["validate", checkout.repoDir], env);
  assert.equal(validated.code, 0, validated.stderr);
});

test("release allocation reserves the accepted commit before publication", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "facility-release-allocation-"));
  const repoDir = join(root, "checkout");
  const remoteDir = join(root, "origin.git");
  await mkdir(repoDir);
  t.after(() => rm(root, { recursive: true, force: true }));

  const git = (args, cwd = repoDir) =>
    spawnSync(
      "git",
      [
        "-c",
        "commit.gpgSign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Facility Tests",
        "-c",
        "user.email=facility-tests@example.invalid",
        ...args,
      ],
      {
        cwd,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      },
    );

  assert.equal(git(["init", "--bare", "--initial-branch=main", remoteDir], root).status, 0);
  assert.equal(git(["init", "--initial-branch=main"]).status, 0);
  await writeFile(join(repoDir, "change.txt"), "accepted release\n");
  assert.equal(git(["add", "change.txt"]).status, 0);
  assert.equal(git(["commit", "-m", "fix: publish the accepted release"]).status, 0);
  assert.equal(git(["remote", "add", "origin", remoteDir]).status, 0);
  assert.equal(git(["push", "-u", "origin", "main"]).status, 0);
  const acceptedSha = git(["rev-parse", "HEAD"]).stdout.trim();

  const script = await releaseAllocationScript();
  const environment = { ...process.env, TAG: "v0.4.0", VERSION: "0.4.0" };
  const allocated = spawnSync("bash", ["-c", script], {
    cwd: repoDir,
    encoding: "utf8",
    env: environment,
  });
  assert.equal(allocated.status, 0, allocated.stderr);
  assert.equal(
    git(["--git-dir", remoteDir, "rev-parse", "refs/tags/v0.4.0^{commit}"], root).stdout.trim(),
    acceptedSha,
  );

  const replay = spawnSync("bash", ["-c", script], {
    cwd: repoDir,
    encoding: "utf8",
    env: environment,
  });
  assert.equal(replay.status, 0, replay.stderr);
  assert.match(replay.stdout, /already allocates the accepted commit/);

  await writeFile(join(repoDir, "change.txt"), "later commit\n");
  assert.equal(git(["add", "change.txt"]).status, 0);
  assert.equal(git(["commit", "-m", "fix: advance after allocation"]).status, 0);
  const conflict = spawnSync("bash", ["-c", script], {
    cwd: repoDir,
    encoding: "utf8",
    env: environment,
  });
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /not accepted commit/);
});

test("release recording retries after tag push and rejects a tag on another commit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "facility-release-record-"));
  const repoDir = join(root, "checkout");
  const remoteDir = join(root, "origin.git");
  const binDir = join(root, "bin");
  const releaseMarker = join(root, "release-created");
  const ghLog = join(root, "gh-invocations.jsonl");
  const runnerTemp = join(root, "runner-temp");
  await mkdir(repoDir);
  await mkdir(binDir);
  await mkdir(runnerTemp);
  t.after(() => rm(root, { recursive: true, force: true }));

  const git = (args, cwd = repoDir) =>
    execFileSync(
      "git",
      [
        "-c",
        "commit.gpgSign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Facility Tests",
        "-c",
        "user.email=facility-tests@example.invalid",
        ...args,
      ],
      {
        cwd,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      },
    ).trim();
  git(["init", "--bare", "--initial-branch=main", remoteDir], root);
  git(["init", "--initial-branch=main"]);
  await writeFile(join(repoDir, "change.txt"), "release\n");
  git(["add", "change.txt"]);
  git(["commit", "-m", "feat!: release the fixture"]);
  git(["remote", "add", "origin", remoteDir]);
  git(["push", "-u", "origin", "main"]);
  const releasedSha = git(["rev-parse", "HEAD"]);

  const ghCommand = join(binDir, "gh");
  await writeFile(
    ghCommand,
    `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
const args = process.argv.slice(2);
const [resource, action] = args;
if (resource !== "release") process.exit(64);
if (action === "view") process.exit(existsSync(process.env.FAKE_RELEASE_MARKER) ? 0 : 1);
if (action !== "create") process.exit(64);
if (process.env.FAKE_GH_FAIL_CREATE === "1") process.exit(23);
const notesIndex = args.indexOf("--notes-file");
if (notesIndex === -1) process.exit(64);
writeFileSync(process.env.FAKE_RELEASE_MARKER, readFileSync(args[notesIndex + 1], "utf8"));
`,
  );
  await chmod(ghCommand, 0o755);

  const script = await releaseRecordingScript();
  const baseEnv = {
    ...process.env,
    FAKE_GH_LOG: ghLog,
    FAKE_RELEASE_MARKER: releaseMarker,
    GH_TOKEN: "local-test-token",
    NOTES: "fixture release notes",
    PATH: `${binDir}:${process.env.PATH}`,
    RUNNER_TEMP: runnerTemp,
    TAG: "v0.4.0",
    VERSION: "0.4.0",
    NPM_PUBLISHED: "true",
    IMAGES_PROMOTED: "false",
  };

  const interrupted = spawnSync("bash", ["-c", script], {
    cwd: repoDir,
    encoding: "utf8",
    env: { ...baseEnv, FAKE_GH_FAIL_CREATE: "1" },
  });
  assert.equal(interrupted.status, 23, interrupted.stderr);
  assert.equal(git(["rev-parse", "refs/tags/v0.4.0^{commit}"]), releasedSha);
  assert.equal(
    git(["--git-dir", remoteDir, "rev-parse", "refs/tags/v0.4.0^{commit}"], root),
    releasedSha,
  );
  await assertMissing(releaseMarker);

  const retried = spawnSync("bash", ["-c", script], {
    cwd: repoDir,
    encoding: "utf8",
    env: baseEnv,
  });
  assert.equal(retried.status, 0, retried.stderr);
  const releaseNotes = await readFile(releaseMarker, "utf8");
  assert.match(releaseNotes, /^fixture release notes/);
  assert.match(releaseNotes, /- npm package: published/);
  assert.match(releaseNotes, /- container image set: promotion was not confirmed complete/);

  await writeFile(join(repoDir, "change.txt"), "later commit\n");
  git(["add", "change.txt"]);
  git(["commit", "-m", "fix: advance beyond the released commit"]);
  const mismatched = spawnSync("bash", ["-c", script], {
    cwd: repoDir,
    encoding: "utf8",
    env: baseEnv,
  });
  assert.equal(mismatched.status, 1);
  assert.match(mismatched.stderr, /v0\.4\.0 points to .* not released commit/);

  const invocations = (await readFile(ghLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    invocations.map((args) => args.slice(0, 3)),
    [
      ["release", "view", "v0.4.0"],
      ["release", "create", "v0.4.0"],
      ["release", "view", "v0.4.0"],
      ["release", "create", "v0.4.0"],
    ],
  );
});

test("release recording publishes status exactly when a publisher confirms an artifact", async (t) => {
  const script = await releaseRecordingScript();
  const cases = [
    {
      name: "npm only",
      npmPublished: "true",
      imagesPromoted: "false",
      npmStatus: "published",
      imageStatus: "promotion was not confirmed complete",
      recorded: true,
    },
    {
      name: "images only",
      npmPublished: "false",
      imagesPromoted: "true",
      npmStatus: "publication was not confirmed",
      imageStatus: "promoted",
      recorded: true,
    },
    {
      name: "both registries",
      npmPublished: "true",
      imagesPromoted: "true",
      npmStatus: "published",
      imageStatus: "promoted",
      recorded: true,
    },
    {
      name: "neither registry",
      npmPublished: "false",
      imagesPromoted: "false",
      recorded: false,
    },
  ];

  for (const releaseCase of cases) {
    await t.test(releaseCase.name, async (t) => {
      const root = await mkdtemp(join(tmpdir(), "facility-release-consumption-"));
      const repoDir = join(root, "checkout");
      const remoteDir = join(root, "origin.git");
      const binDir = join(root, "bin");
      const runnerTemp = join(root, "runner-temp");
      const releaseMarker = join(root, "release-notes");
      await mkdir(repoDir);
      await mkdir(binDir);
      await mkdir(runnerTemp);
      t.after(() => rm(root, { recursive: true, force: true }));

      const git = (args, cwd = repoDir) =>
        spawnSync(
          "git",
          [
            "-c",
            "commit.gpgSign=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "user.name=Facility Tests",
            "-c",
            "user.email=facility-tests@example.invalid",
            ...args,
          ],
          {
            cwd,
            encoding: "utf8",
            env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
          },
        );
      assert.equal(git(["init", "--bare", "--initial-branch=main", remoteDir], root).status, 0);
      assert.equal(git(["init", "--initial-branch=main"]).status, 0);
      await writeFile(join(repoDir, "change.txt"), "release\n");
      assert.equal(git(["add", "change.txt"]).status, 0);
      assert.equal(git(["commit", "-m", "fix: publish the fixture"]).status, 0);
      assert.equal(git(["remote", "add", "origin", remoteDir]).status, 0);
      assert.equal(git(["push", "-u", "origin", "main"]).status, 0);

      const ghCommand = join(binDir, "gh");
      await writeFile(
        ghCommand,
        `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] !== "release") process.exit(64);
if (args[1] === "view") process.exit(1);
if (args[1] !== "create") process.exit(64);
const notesIndex = args.indexOf("--notes-file");
if (notesIndex === -1) process.exit(64);
writeFileSync(process.env.FAKE_RELEASE_MARKER, readFileSync(args[notesIndex + 1], "utf8"));
`,
      );
      await chmod(ghCommand, 0o755);

      const result = spawnSync("bash", ["-c", script], {
        cwd: repoDir,
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_RELEASE_MARKER: releaseMarker,
          GH_TOKEN: "local-test-token",
          IMAGES_PROMOTED: releaseCase.imagesPromoted,
          NOTES: "fixture release notes",
          NPM_PUBLISHED: releaseCase.npmPublished,
          PATH: `${binDir}:${process.env.PATH}`,
          RUNNER_TEMP: runnerTemp,
          TAG: "v0.4.0",
          VERSION: "0.4.0",
        },
      });

      if (!releaseCase.recorded) {
        assert.equal(result.status, 1);
        assert.match(result.stderr, /no publisher confirmed an artifact/);
        assert.notEqual(git(["show-ref", "--verify", "--quiet", "refs/tags/v0.4.0"]).status, 0);
        await assertMissing(releaseMarker);
        return;
      }

      assert.equal(result.status, 0, result.stderr);
      assert.equal(git(["show-ref", "--verify", "--quiet", "refs/tags/v0.4.0"]).status, 0);
      assert.equal(
        git(["--git-dir", remoteDir, "show-ref", "--verify", "--quiet", "refs/tags/v0.4.0"], root).status,
        0,
      );
      const notes = await readFile(releaseMarker, "utf8");
      assert.match(notes, new RegExp(`- npm package: ${releaseCase.npmStatus}`));
      assert.match(notes, new RegExp(`- container image set: ${releaseCase.imageStatus}`));
    });
  }
});

test("an exact 404 permits bootstrap publication without running package lifecycle scripts", async (t) => {
  const state = await fixture(t);
  const registry = await fakeRegistry(t, {
    tokenStatus: (authorization) => (authorization === "Bearer valid-bootstrap-token" ? 201 : 401),
  });
  const env = await npmEnvironment(state, registry.url, "valid-bootstrap-token");

  const result = await release(["publish", state.tarball, "--auth=bootstrap"], env);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    registry.requests.slice(0, 2).map(({ method, url, responseStatus }) => ({ method, url, responseStatus })),
    [
      { method: "GET", url: packagePath, responseStatus: 404 },
      { method: "GET", url: packagePath, responseStatus: 404 },
    ],
  );
  const writes = registry.requests.filter(({ method }) => method === "PUT");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].authorization, "Bearer valid-bootstrap-token");
  assert.equal(writes[0].responseStatus, 201);
  await assertMissing(state.lifecycleMarker);
});

// The mode a missing `secrets: inherit` produces. A called workflow resolves an
// environment secret it was never passed to the empty string rather than
// failing, so the bootstrap step runs with NODE_AUTH_TOKEN set and empty — which
// is how the first 0.3.1 attempt reached npm with no credential. Unset is
// covered alongside it because the two must not diverge: both are "no token".
test("bootstrap publication without a token fails closed before any write", async (t) => {
  for (const [name, mutate] of [
    ["empty", (env) => Object.assign(env, { NODE_AUTH_TOKEN: "" })],
    ["unset", (env) => (delete env.NODE_AUTH_TOKEN, env)],
  ]) {
    const state = await fixture(t);
    const registry = await fakeRegistry(t, { tokenStatus: () => 201 });
    const env = mutate(await npmEnvironment(state, registry.url, "unused-bootstrap-token"));

    const result = await release(["publish", state.tarball, "--auth=bootstrap"], env);

    assert.equal(result.code, 1, `${name} token must not publish: ${result.stdout}`);
    assert.match(
      result.stderr,
      /NPM_BOOTSTRAP_TOKEN is required for the first package publication/,
      `${name} token must name the missing credential`,
    );
    assert.deepEqual(
      registry.requests.filter(({ method }) => method === "PUT"),
      [],
      `${name} token must not reach the registry with a write`,
    );
    await assertMissing(state.lifecycleMarker);
  }
});

test("existing, replayed, unavailable, and malformed registry states fail closed before PUT", async (t) => {
  const cases = [
    {
      name: "existing package",
      lookupStatus: 200,
      lookupBody: JSON.stringify({ name: PACKAGE_NAME, versions: { "0.2.0": {} } }),
      error: /bootstrap credentials are allowed only for the first publication/,
    },
    {
      name: "replayed version",
      lookupStatus: 200,
      lookupBody: JSON.stringify({
        name: PACKAGE_NAME,
        versions: { "0.3.0": { dist: { integrity: "sha512-conflicting" } } },
      }),
      error: /already published with different contents; refusing conflicting replay/,
    },
    {
      name: "registry 5xx",
      lookupStatus: 503,
      lookupBody: JSON.stringify({ error: "unavailable" }),
      error: /registry lookup failed closed with HTTP 503/,
    },
    {
      name: "malformed metadata",
      lookupStatus: 200,
      lookupBody: "{not-json",
      error: /registry returned malformed package metadata/,
    },
  ];

  for (const candidate of cases) {
    await t.test(candidate.name, async (t) => {
      const state = await fixture(t);
      const registry = await fakeRegistry(t, candidate);
      const env = await npmEnvironment(state, registry.url, "valid-bootstrap-token");

      const result = await release(["publish", state.tarball, "--auth=bootstrap"], env);

      assert.equal(result.code, 1);
      assert.match(result.stderr, candidate.error);
      assert.equal(registry.requests.filter(({ method }) => method === "PUT").length, 0);
      await assertMissing(state.lifecycleMarker);
    });
  }
});

test("an exact already-published tarball is an idempotent retry with no npm invocation", async (t) => {
  const state = await fixture(t);
  const recorder = await installNpmRecorder(state);
  const integrity = `sha512-${createHash("sha512")
    .update(await readFile(state.tarball))
    .digest("base64")}`;
  const registry = await fakeRegistry(t, {
    lookupStatus: 200,
    lookupBody: JSON.stringify({
      name: PACKAGE_NAME,
      versions: { "0.3.0": { dist: { integrity } } },
    }),
  });
  const env = await npmEnvironment(state, registry.url, "must-not-be-used");
  env.PATH = `${recorder.bin}:${env.PATH}`;
  env.RELEASE_NPM_INVOCATION = recorder.invocation;

  const result = await release(["publish", state.tarball, "--auth=oidc"], env);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    registry.requests.map(({ method, responseStatus }) => ({ method, responseStatus })),
    [{ method: "GET", responseStatus: 200 }],
  );
  await assertMissing(recorder.invocation);
});

test("expired, revoked, and cross-scope bootstrap tokens fail closed", async (t) => {
  const cases = [
    ["expired", "expired-bootstrap-token", 401],
    ["revoked", "revoked-bootstrap-token", 401],
    ["cross-scope", "cross-scope-bootstrap-token", 403],
  ];

  for (const [name, token, status] of cases) {
    await t.test(name, async (t) => {
      const state = await fixture(t);
      const registry = await fakeRegistry(t, {
        tokenStatus: (authorization) => (authorization === `Bearer ${token}` ? status : 401),
      });
      const env = await npmEnvironment(state, registry.url, token);

      const result = await release(["publish", state.tarball, "--auth=bootstrap"], env);

      assert.equal(result.code, 1);
      assert.match(result.stderr, /npm publish failed with exit 1/);
      const writes = registry.requests.filter(({ method }) => method === "PUT");
      assert.equal(writes.length, 1);
      assert.equal(writes[0].authorization, `Bearer ${token}`);
      assert.equal(writes[0].responseStatus, status);
      await assertMissing(state.lifecycleMarker);
    });
  }
});

test("an existing package uses OIDC without forwarding static npm credentials", async (t) => {
  const state = await fixture(t);
  const recorder = await installNpmRecorder(state);
  const registry = await fakeRegistry(t, {
    lookupStatus: 200,
    lookupBody: JSON.stringify({ name: PACKAGE_NAME, versions: { "0.2.0": {} } }),
  });
  const env = await npmEnvironment(state, registry.url, "must-not-be-sent");
  env.NPM_TOKEN = "legacy-token-must-not-be-sent";
  env.NPM_CONFIG_AUTH_TOKEN = "config-token-must-not-be-sent";
  env.PATH = `${recorder.bin}:${env.PATH}`;
  env.RELEASE_NPM_INVOCATION = recorder.invocation;

  const result = await release(["publish", state.tarball, "--auth=oidc"], env);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    registry.requests.slice(0, 2).map(({ method, url, responseStatus }) => ({ method, url, responseStatus })),
    [
      { method: "GET", url: packagePath, responseStatus: 200 },
      { method: "GET", url: packagePath, responseStatus: 200 },
    ],
  );
  assert.equal(registry.requests.filter(({ method }) => method === "PUT").length, 0);
  const invocation = JSON.parse(await readFile(recorder.invocation, "utf8"));
  assert.deepEqual(invocation.credentials, {
    nodeAuthToken: null,
    npmToken: null,
    configAuthToken: null,
  });
  assert.doesNotMatch(invocation.userConfig, /auth|token/i);
  assert.equal(invocation.args.includes("--ignore-scripts"), true);
  await assertMissing(state.lifecycleMarker);
});

test("dry-run performs no registry PUT and strips publication credentials", async (t) => {
  const state = await fixture(t);
  const registry = await fakeRegistry(t);
  const env = await npmEnvironment(state, registry.url, "must-not-be-sent");

  const result = await release(["dry-run", state.tarball], env);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(registry.requests.filter(({ method }) => method === "PUT").length, 0);
  assert.equal(registry.requests.some(({ authorization }) => authorization), false);
  await assertMissing(state.lifecycleMarker);
});

test("real publication rejects a nonofficial registry unless the test seam is injected", async (t) => {
  const state = await fixture(t);
  const registry = await fakeRegistry(t);
  const env = await npmEnvironment(state, registry.url, "must-not-be-sent");
  let spawned = false;

  assert.throws(
    () =>
      publishTarball({
        tarball: state.tarball,
        authMode: "bootstrap",
        registryUrl: registry.url,
        env,
        spawn: () => {
          spawned = true;
          return { status: 0 };
        },
      }),
    /must use exactly https:\/\/registry\.npmjs\.org\//,
  );
  assert.equal(spawned, false);
  assert.equal(registry.requests.length, 0);
});

test("ambiguous or unknown publish flags fail before any registry request", async (t) => {
  const state = await fixture(t);
  const registry = await fakeRegistry(t);
  const env = await npmEnvironment(state, registry.url, "must-not-be-sent");

  for (const args of [
    ["publish", state.tarball, "--auth=oidc", "--auth=bootstrap"],
    ["publish", state.tarball, "--auth=unknown"],
    ["publish", state.tarball, "--unexpected"],
  ]) {
    const result = await releaseCli(args, env);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /requires exactly one --auth=oidc or --auth=bootstrap option/);
  }
  assert.equal(registry.requests.length, 0);
});

test("dry-run removes GitHub OIDC request credentials before spawning npm", async (t) => {
  const state = await fixture(t);
  let childEnvironment;

  publishTarball({
    tarball: state.tarball,
    authMode: "dry-run",
    env: {
      ...process.env,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-token-must-not-be-sent",
      ACTIONS_ID_TOKEN_REQUEST_URL: "http://127.0.0.1:9/oidc",
      NODE_AUTH_TOKEN: "npm-token-must-not-be-sent",
    },
    spawn: (_command, _args, options) => {
      childEnvironment = options.env;
      return { status: 0 };
    },
  });

  assert.equal(childEnvironment.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);
  assert.equal(childEnvironment.ACTIONS_ID_TOKEN_REQUEST_URL, undefined);
  assert.equal(childEnvironment.NODE_AUTH_TOKEN, undefined);
});

test("registry metadata shapes and timeouts fail closed", async (t) => {
  const state = await fixture(t);
  for (const lookupBody of [
    JSON.stringify({ name: PACKAGE_NAME, versions: null }),
    JSON.stringify({ name: PACKAGE_NAME, versions: [] }),
    JSON.stringify({ versions: {} }),
    JSON.stringify({ name: "@other/package", versions: {} }),
  ]) {
    const registry = await fakeRegistry(t, { lookupStatus: 200, lookupBody });
    await assert.rejects(
      registryState({ tarball: state.tarball, registryUrl: registry.url }),
      /malformed package metadata/,
    );
  }

  const stalled = createServer(() => {});
  await new Promise((resolve, reject) => {
    stalled.once("error", reject);
    stalled.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => {
    stalled.closeAllConnections?.();
    stalled.close();
  });
  const address = stalled.address();
  assert(address && typeof address === "object");
  await assert.rejects(
    registryState({
      tarball: state.tarball,
      registryUrl: `http://127.0.0.1:${address.port}/`,
      timeoutMs: 25,
    }),
    /registry lookup failed closed/,
  );
});
