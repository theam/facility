import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { installGhStub, isolateGhEnv, prependPath } from "./gh-stub.mjs";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const verifier = join(pkgRoot, "templates", "delivery", "verify.mjs");

test("delivery verifier emits a passed receipt for a compliant bot PR", (t) => {
  const fixture = makeFixture(t);
  const discover = runVerifier(fixture, "discover");
  assert.equal(discover.status, 0, discover.stdout + discover.stderr);
  const outputs = readFileSync(fixture.outputPath, "utf8");
  assert.ok(outputs.includes("pr_number=7"));
  assert.ok(outputs.includes("head_ref=feature/incident-triage"));

  const finalize = runVerifier(fixture, "finalize", {
    FACILITY_PR_NUMBER: "7",
    FACILITY_HEAD_REF: "feature/incident-triage",
    FACILITY_HEAD_SHA: "new-sha",
  });
  assert.equal(finalize.status, 0, finalize.stdout + finalize.stderr);
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
    assert.equal(result.status, 0, `${message}\n${result.stdout}${result.stderr}`);
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
    "fix: render \u001b[31mred output",
    "fix: render \u009b31mred output",
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

function makeFixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "facility-delivery-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dataPath = join(dir, "data.json");
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
  const data = {
    pr,
    commits: [
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
    ],
  };
  writeFileSync(dataPath, JSON.stringify(data));
  writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 7 } }));
  writeFileSync(outputPath, "");
  installGhStub(
    dir,
    `import { readFileSync } from "node:fs";
const data = JSON.parse(readFileSync(process.env.FAKE_GH_DATA, "utf8"));
const endpoint = process.argv[3] || "";
if (endpoint.includes("/commits")) process.stdout.write(JSON.stringify(data.commits));
else process.stdout.write(JSON.stringify(data.pr));
`,
  );
  return { dir, dataPath, eventPath, outputPath, runnerTemp };
}

function runVerifier(fixture, mode, extraEnv = {}) {
  return spawnSync(process.execPath, [verifier, mode], {
    encoding: "utf8",
    env: isolateGhEnv({
      ...process.env,
      ...prependPath(fixture.dir),
      FAKE_GH_DATA: fixture.dataPath,
      GITHUB_REPOSITORY: "acme/demo",
      GITHUB_EVENT_PATH: fixture.eventPath,
      GITHUB_OUTPUT: fixture.outputPath,
      RUNNER_TEMP: fixture.runnerTemp,
      DEFAULT_BRANCH: "main",
      FACILITY_START_SHA: "base-sha",
      FACILITY_STARTED_AT: "2026-07-15T12:00:00Z",
      ...extraEnv,
    }),
  });
}
