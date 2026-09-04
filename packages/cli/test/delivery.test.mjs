import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const verifier = join(pkgRoot, "templates", "delivery", "verify.mjs");
const { runDelivery } = await import(pathToFileURL(verifier));

test("delivery verifier emits a passed receipt for a compliant bot PR", (t) => {
  const fixture = makeFixture(t);
  const discover = runVerifier(fixture, "discover");
  assert.equal(discover.status, 0, discover.stderr);
  const outputs = readFileSync(fixture.outputPath, "utf8");
  assert.ok(outputs.includes("pr_number=7"));
  assert.ok(outputs.includes("head_ref=feature/incident-triage"));

  const finalize = runVerifier(fixture, "finalize", {
    FACILITY_PR_NUMBER: "7",
    FACILITY_HEAD_REF: "feature/incident-triage",
    FACILITY_HEAD_SHA: "new-sha",
  });
  assert.equal(finalize.status, 0, finalize.stderr);
  const receipt = JSON.parse(
    readFileSync(join(fixture.runnerTemp, "facility-delivery", "receipt.json"), "utf8"),
  );
  assert.equal(receipt.verification, "passed");
  assert.deepEqual(receipt.deliveredCommits, ["new-sha"]);
});

test("delivery verifier rejects agent-prefixed branches and false co-authorship", (t) => {
  const branchFixture = makeFixture(t, { branch: "claude/incident-triage" });
  const branch = runVerifier(branchFixture, "discover");
  assert.notEqual(branch.status, 0);
  assert.match(branch.stderr, /not semantic|agent\/tool prefix/);

  const trailerFixture = makeFixture(t, {
    message: "feat: add triage\n\nCo-authored-by: Requester <requester@example.com>",
  });
  const trailer = runVerifier(trailerFixture, "discover");
  assert.notEqual(trailer.status, 0);
  assert.match(trailer.stderr, /Co-authored-by trailer/);
});

test("delivery verifier accepts style commits and punctuation in scopes", (t) => {
  for (const message of [
    "style: normalize formatting",
    "fix(web+api): align shared routes",
    "feat(api/auth)!: require scoped credentials",
  ]) {
    const fixture = makeFixture(t, { message });
    const result = runVerifier(fixture, "discover");
    assert.equal(result.status, 0, `${message}\n${result.stderr}`);
  }
});

test("delivery verifier rejects unknown types and malformed subjects", (t) => {
  for (const message of [
    "feature: add incident triage",
    "  fix: add incident triage",
    "fix(api(auth)): require scoped credentials",
    "fix((): require scoped credentials",
    "fix(api)): require scoped credentials",
    "fix( ): require scoped credentials",
    "fix(api\tauth): require scoped credentials",
    "fix: render [31mred output",
    "fix: render 31mred output",
    "feat:  summary starts after an extra space",
  ]) {
    const fixture = makeFixture(t, { message });
    const result = runVerifier(fixture, "discover");
    assert.notEqual(result.status, 0, message);
    assert.match(result.stderr, /not Conventional Commits/);
  }
});

test("delivery verifier rejects a rewritten existing PR baseline", (t) => {
  const fixture = makeFixture(t, { omitBaseline: true });
  const result = runVerifier(fixture, "discover");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pre-builder head|history was rewritten/);
});

test("hostile ambient environment cannot redirect the verifier's gh", (t) => {
  // Regression for the PR #245 review: an earlier workflow step could persist
  // variables through $GITHUB_ENV; the shipped script path must ignore any
  // ambient runner override and only ever invoke the fixed executable.
  const fixture = makeFixture(t);
  const marker = join(fixture.dir, "hostile-executed");
  const hostile = join(fixture.dir, "hostile-gh.mjs");
  writeFileSync(
    hostile,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "pwned");\nconsole.log("{}");\n`,
  );
  const spawned = spawnSync(process.execPath, [verifier, "discover"], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...fixture.env,
      FACILITY_GH_BIN: process.execPath,
      FACILITY_GH_ARGS: JSON.stringify([hostile]),
      // If the fixed gh is attempted it must die offline, never on the API.
      GH_HOST: "gh-stub.invalid",
      GH_TOKEN: "stub-only",
    },
  });
  assert.ok(!existsSync(marker), "ambient FACILITY_GH_BIN must never be executed");
  assert.notEqual(spawned.status, 0, "fixed gh cannot succeed against gh-stub.invalid");
});

function makeFixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "facility-delivery-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const eventPath = join(dir, "event.json");
  const outputPath = join(dir, "output.txt");
  const runnerTemp = join(dir, "runner-temp");
  const pr = {
    number: 7,
    state: "open",
    draft: false,
    html_url: "https://github.test/acme/demo/pull/7",
    created_at: "2026-07-15T12:00:01Z",
    base: { ref: "main" },
    head: {
      ref: overrides.branch ?? "feature/incident-triage",
      sha: "new-sha",
      repo: { full_name: "acme/demo" },
    },
    user: { login: "claude[bot]", type: "Bot" },
  };
  const commits = [
    ...(overrides.omitBaseline
      ? []
      : [
          {
            sha: "base-sha",
            commit: { message: "Initial commit", verification: { verified: false } },
          },
        ]),
    {
      sha: "new-sha",
      commit: {
        message: overrides.message ?? "feat: add incident triage",
        verification: { verified: true },
      },
    },
  ];
  writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 7 } }));
  writeFileSync(outputPath, "");
  const env = {
    GITHUB_REPOSITORY: "acme/demo",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_OUTPUT: outputPath,
    RUNNER_TEMP: runnerTemp,
    DEFAULT_BRANCH: "main",
    FACILITY_STARTED_AT: "2026-07-15T12:00:00Z",
    FACILITY_START_SHA: "base-sha",
  };
  // The runner is injected at the module boundary — the only seam there is.
  const gh = (args) => {
    const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";
    return JSON.stringify(endpoint.includes("/commits") ? commits : pr);
  };
  return { dir, outputPath, runnerTemp, env, gh };
}

function runVerifier(fixture, mode, extraEnv = {}) {
  const applied = { ...fixture.env, ...extraEnv };
  const saved = {};
  for (const key of Object.keys(applied)) {
    saved[key] = process.env[key];
    process.env[key] = applied[key];
  }
  try {
    runDelivery(mode, { gh: fixture.gh });
    return { status: 0, stderr: "" };
  } catch (error) {
    return { status: 1, stderr: String(error?.message ?? error) };
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
