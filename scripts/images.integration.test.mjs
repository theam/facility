import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BUILD_IMAGES, PUBLISHED_IMAGES, publishImageSet } from "./images.mjs";

const repository = "theam/facility";
const owner = "theam";
const ownerType = "Organization";
const token = "test-installation-token";
const tags = ["sha-aaaaaaaaaaaa", "0.3.0"];

function imageDigests() {
  return new Map(
    BUILD_IMAGES.map((image, index) => [image, `sha256:${String(index + 1).repeat(64)}`]),
  );
}

function containerVersion(digest, versionTags) {
  return {
    name: digest,
    metadata: { package_type: "container", container: { tags: versionTags } },
  };
}

async function fakePackages(t, responder = () => ({ status: 404 })) {
  const requests = [];
  const server = createServer((request, response) => {
    const match = /^\/orgs\/theam\/packages\/container\/([^/]+)\/versions$/.exec(
      new URL(request.url, "http://127.0.0.1").pathname,
    );
    const packageName = match ? decodeURIComponent(match[1]) : undefined;
    requests.push({
      authorization: request.headers.authorization,
      method: request.method,
      packageName,
      url: request.url,
    });
    const answer = responder({ packageName, request });
    response.statusCode = answer.status;
    response.setHeader("content-type", "application/json");
    response.end(answer.body ?? JSON.stringify(answer.versions ?? { error: "not_found" }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections?.();
    });
  });
  return { requests, url: `http://127.0.0.1:${address.port}/` };
}

async function fakeDocker(t) {
  const root = await mkdtemp(join(tmpdir(), "facility-fake-docker-"));
  const command = join(root, "docker");
  const log = join(root, "invocations.jsonl");
  await writeFile(
    command,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const invocation = {
  args: process.argv.slice(2),
  githubToken: process.env.GITHUB_TOKEN ?? null,
  ghToken: process.env.GH_TOKEN ?? null,
};
appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(invocation) + "\\n");
if (process.env.FAKE_DOCKER_FAIL_IMAGE && invocation.args.some((arg) =>
  arg.includes("/" + process.env.FAKE_DOCKER_FAIL_IMAGE + ":"))) process.exit(23);
`,
  );
  await chmod(command, 0o755);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { command, log };
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

function publishOptions({ api, docker, overrides = {} }) {
  return {
    repository,
    owner,
    ownerType,
    token,
    tags,
    digests: imageDigests(),
    apiBaseUrl: api.url,
    dockerCommand: docker.command,
    env: {
      ...process.env,
      FAKE_DOCKER_LOG: docker.log,
      GITHUB_TOKEN: "must-not-reach-docker",
      GH_TOKEN: "must-not-reach-docker",
    },
    ...overrides,
  };
}

test("a fresh image set promotes four packages and aliases worker to the api digest", async (t) => {
  const api = await fakePackages(t);
  const docker = await fakeDocker(t);

  const result = await publishImageSet(publishOptions({ api, docker }));

  assert.equal(result.promoted, PUBLISHED_IMAGES.length);
  assert.equal(api.requests.length, PUBLISHED_IMAGES.length);
  assert.deepEqual(
    api.requests.map(({ authorization, method }) => ({ authorization, method })),
    Array.from({ length: PUBLISHED_IMAGES.length }, () => ({
      authorization: `Bearer ${token}`,
      method: "GET",
    })),
  );
  const calls = await invocations(docker.log);
  assert.equal(calls.length, PUBLISHED_IMAGES.length);
  assert.deepEqual(
    calls.map(({ githubToken, ghToken }) => ({ githubToken, ghToken })),
    Array.from({ length: PUBLISHED_IMAGES.length }, () => ({ githubToken: null, ghToken: null })),
  );
  assert.ok(
    calls.every(({ args }) => args.includes("--prefer-index=false")),
    "promotion must preserve each single-platform source manifest digest",
  );
  const worker = calls.find(({ args }) => args.includes("ghcr.io/theam/facility/worker:0.3.0"));
  assert(worker);
  assert.equal(worker.args.at(-1), `ghcr.io/theam/facility/api@${imageDigests().get("api")}`);
});

test("an exact replay is idempotent and never invokes Docker", async (t) => {
  const digests = imageDigests();
  const api = await fakePackages(t, ({ packageName }) => {
    const image = packageName.split("/").at(-1);
    const source = image === "worker" ? "api" : image;
    return { status: 200, versions: [containerVersion(digests.get(source), tags)] };
  });
  const docker = await fakeDocker(t);

  const result = await publishImageSet(publishOptions({ api, docker }));

  assert.equal(result.promoted, 0);
  assert.deepEqual(await invocations(docker.log), []);
});

test("a conflicting replay fails before any registry mutation", async (t) => {
  const api = await fakePackages(t, ({ packageName }) =>
    packageName === "facility/runner"
      ? {
          status: 200,
          versions: [containerVersion(`sha256:${"f".repeat(64)}`, [tags[0]])],
        }
      : { status: 404 },
  );
  const docker = await fakeDocker(t);

  await assert.rejects(
    publishImageSet(publishOptions({ api, docker })),
    /refusing to replace facility\/runner:sha-aaaaaaaaaaaa/,
  );
  assert.equal(
    api.requests.length,
    PUBLISHED_IMAGES.length,
    "every package must be inspected before promotion starts",
  );
  assert.deepEqual(await invocations(docker.log), []);
});

test("expired, revoked, malformed, and cross-owner inputs fail closed", async (t) => {
  for (const [name, answer, message] of [
    ["expired", { status: 401 }, /HTTP 401/],
    ["revoked", { status: 403 }, /HTTP 403/],
    ["malformed", { status: 200, body: "{not-json" }, /malformed metadata/],
  ]) {
    await t.test(name, async (t) => {
      const api = await fakePackages(t, () => answer);
      const docker = await fakeDocker(t);
      await assert.rejects(publishImageSet(publishOptions({ api, docker })), message);
      assert.deepEqual(await invocations(docker.log), []);
    });
  }

  await t.test("cross-owner", async (t) => {
    const api = await fakePackages(t);
    const docker = await fakeDocker(t);
    await assert.rejects(
      publishImageSet(
        publishOptions({ api, docker, overrides: { repository: "attacker/facility" } }),
      ),
      /does not belong to expected owner/,
    );
    assert.equal(api.requests.length, 0);
    assert.deepEqual(await invocations(docker.log), []);
  });
});

test("a promotion failure stops the set and a same-digest retry can fill the remainder", async (t) => {
  const firstApi = await fakePackages(t);
  const failingDocker = await fakeDocker(t);
  const failing = publishOptions({ api: firstApi, docker: failingDocker });
  failing.env.FAKE_DOCKER_FAIL_IMAGE = "web";

  await assert.rejects(publishImageSet(failing), /promotion failed for web with exit 23/);
  assert.equal((await invocations(failingDocker.log)).length, 3);

  const digests = imageDigests();
  const retryApi = await fakePackages(t, ({ packageName }) => {
    if (packageName !== "facility/api" && packageName !== "facility/worker") return { status: 404 };
    const source = packageName === "facility/worker" ? "api" : "api";
    return { status: 200, versions: [containerVersion(digests.get(source), tags)] };
  });
  const retryDocker = await fakeDocker(t);
  const retry = await publishImageSet(publishOptions({ api: retryApi, docker: retryDocker }));

  assert.equal(retry.promoted, 2);
  assert.equal((await invocations(retryDocker.log)).length, 2);
});
