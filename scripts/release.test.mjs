import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  OFFICIAL_REGISTRY,
  normalizeRegistry,
  releaseMode,
  stampVersion,
  validateReleasePolicy,
} from "./release.mjs";

const releaseWorkflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const ciWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

const validPolicy = {
  eventName: "push",
  ref: "refs/heads/main",
  visibility: "public",
  rootVersion: "0.3.0",
  packageVersion: "0.3.0",
  decidedVersion: "0.3.0",
  headSha: "release-sha",
  checkoutSha: "release-sha",
  isOnMain: true,
};

test("manual dispatches are dry-runs even when a real publish is requested", () => {
  assert.equal(
    releaseMode({
      eventName: "workflow_dispatch",
      ref: "refs/heads/release-candidate",
      visibility: "public",
      acceptancePassed: true,
      requestedDryRun: false,
    }),
    "dry-run",
  );
});

test("only an accepted public main push with a decision enters publish mode", () => {
  const accepted = {
    eventName: "push",
    ref: "refs/heads/main",
    visibility: "public",
    acceptancePassed: true,
    releaseDecided: true,
  };
  assert.equal(releaseMode(accepted), "publish");

  for (const candidate of [
    { ...accepted, releaseDecided: false },
    { ...accepted, releaseDecided: "true" },
    { ...accepted, ref: "refs/heads/feature" },
    { ...accepted, ref: "refs/tags/v0.3.0" },
    { ...accepted, eventName: "pull_request" },
    { ...accepted, visibility: "private" },
    { ...accepted, acceptancePassed: false },
    { ...accepted, acceptancePassed: "false" },
    { ...accepted, acceptancePassed: "failure" },
  ]) {
    assert.equal(releaseMode(candidate), "skip");
  }
});

test("release policy accepts only a stamped main commit matching the decision", () => {
  assert.deepEqual(validateReleasePolicy(validPolicy), {
    packageName: "@theagilemonkeys/facility",
    version: "0.3.0",
    tag: "v0.3.0",
  });
});

test("release policy fails closed on every version and provenance mismatch", () => {
  const invalid = [
    [{ eventName: "workflow_dispatch" }, /real release must come from a push event/],
    [{ visibility: "private" }, /publishing is disabled until the repository is public/],
    // Unset is the mode that actually stopped a release: a workflow step that
    // never passes the variable looks exactly like a private repository here.
    [{ visibility: undefined }, /publishing is disabled until the repository is public/],
    [{ ref: "refs/tags/v0.3.0" }, /a release must come from main, not refs\/tags\/v0\.3\.0/],
    [{ decidedVersion: undefined }, /no release version was decided for this commit/],
    [{ rootVersion: "0.2.0" }, /root package version \(0\.2\.0\) does not match CLI package version \(0\.3\.0\)/],
    [
      { decidedVersion: "0.4.0" },
      /stamped version 0\.3\.0 does not match the decided version 0\.4\.0/,
    ],
    [{ checkoutSha: "other-sha" }, /checked-out commit other-sha does not match event SHA release-sha/],
    [{ isOnMain: false }, /release commit is not reachable from origin\/main/],
  ];

  for (const [override, message] of invalid) {
    assert.throws(() => validateReleasePolicy({ ...validPolicy, ...override }), message);
  }
});

test("stamping updates both manifests together and rejects malformed versions", (t) => {
  const repoDir = mkdtempSync(join(tmpdir(), "facility-stamp-test-"));
  t.after(() => rmSync(repoDir, { recursive: true, force: true }));
  mkdirSync(join(repoDir, "packages/cli"), { recursive: true });
  writeFileSync(join(repoDir, "package.json"), '{"name":"facility","version":"0.3.0"}\n');
  writeFileSync(
    join(repoDir, "packages/cli/package.json"),
    '{"name":"@theagilemonkeys/facility","version":"0.3.0"}\n',
  );

  assert.deepEqual(stampVersion("0.4.0", { repoDir }), {
    version: "0.4.0",
    stamped: ["package.json", "packages/cli/package.json"],
  });
  assert.equal(JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8")).version, "0.4.0");
  assert.equal(
    JSON.parse(readFileSync(join(repoDir, "packages/cli/package.json"), "utf8")).version,
    "0.4.0",
  );
  assert.throws(() => stampVersion("0.4", { repoDir }), /not a semver triple/);
});

test("GitHub publication requires the exact official npm registry", () => {
  assert.equal(normalizeRegistry(OFFICIAL_REGISTRY, { githubActions: true }).href, OFFICIAL_REGISTRY);
  assert.throws(
    () => normalizeRegistry("https://registry.npmjs.org/custom", { githubActions: true }),
    /must use exactly https:\/\/registry\.npmjs\.org\//,
  );
  assert.throws(
    () => normalizeRegistry("http://127.0.0.1:4873", { githubActions: true }),
    /must use exactly https:\/\/registry\.npmjs\.org\//,
  );
});

test("the workflow keeps manual runs credential-free and real publication main-only", () => {
  assert.match(releaseWorkflow, /workflow_call:\n    inputs:\n      version:/);
  assert.match(
    releaseWorkflow,
    /workflow_call:[\s\S]*outputs:\n      published:[\s\S]*value: \$\{\{ jobs\.publish\.outputs\.published \}\}/,
  );
  assert.doesNotMatch(releaseWorkflow, /workflow_dispatch:\n\s+inputs:/);
  assert.match(releaseWorkflow, /dry-run:\n    if: github\.event_name == 'workflow_dispatch'/);
  assert.match(
    releaseWorkflow,
    /publish:\n    if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' && github\.event\.repository\.visibility == 'public'/,
  );
  assert.match(releaseWorkflow, /node scripts\/release\.mjs dry-run "\$candidate"/);
  assert.match(releaseWorkflow, /node scripts\/release\.mjs publish "\$CANDIDATE" --auth=oidc/);
  assert.match(releaseWorkflow, /node scripts\/release\.mjs publish "\$CANDIDATE" --auth=bootstrap/);

  const dryRunJob = releaseWorkflow.split("\n  publish:")[0].split("\n  dry-run:")[1];
  assert.doesNotMatch(dryRunJob, /id-token: write|environment:|secrets\./);
  assert.equal(releaseWorkflow.match(/secrets\.NPM_BOOTSTRAP_TOKEN/g)?.length, 1);
  assert.match(releaseWorkflow, /environment: npm/);
  assert.match(releaseWorkflow, /npm install --global npm@11\.15\.0/);
  const publishJob = releaseWorkflow.split("\n  publish:")[1];
  assert.ok(publishJob, "release workflow must contain a publish job");
  const stampIndex = publishJob.indexOf('node scripts/release.mjs stamp "${{ inputs.version }}"');
  const validateIndex = publishJob.indexOf("node scripts/release.mjs validate");
  assert.notEqual(stampIndex, -1, "the publish checkout must be stamped");
  assert.notEqual(validateIndex, -1, "the publish checkout must be validated");
  assert.ok(
    stampIndex < validateIndex,
    "the publish checkout must be stamped before release validation",
  );
  assert.match(
    releaseWorkflow,
    /publish:[\s\S]*concurrency:\n      group: npm-theagilemonkeys-facility\n      cancel-in-progress: false/,
  );
  assert.match(
    publishJob,
    /outputs:\n      published: \$\{\{ steps\.publication\.outputs\.published \}\}/,
  );
  assert.match(
    publishJob,
    /steps\.registry\.outputs\.state == 'published'[\s\S]*steps\.oidc\.outcome == 'success'[\s\S]*steps\.bootstrap\.outcome == 'success'/,
  );
});

// The policy above is only as good as its input. A job-level `if` on
// github.event.repository.visibility is evaluated by Actions and says nothing
// about what the step's process can read, so a step that runs `validate`
// without binding the variable refuses a public release — which is how the
// v0.3.1 run failed. Assert the binding on every validating step in both
// workflows, so deleting one fails here instead of at the release.
test("both release validations receive the visibility their policy checks", () => {
  for (const [name, workflow] of [
    ["ci.yml", ciWorkflow],
    ["release.yml", releaseWorkflow],
  ]) {
    const validating = workflow
      .split(/\n      - name: /)
      .slice(1)
      .filter((step) => /node scripts\/release\.mjs validate/.test(step));
    assert.ok(validating.length, `${name} must validate the release before publishing`);
    for (const step of validating) {
      assert.match(
        step,
        /GITHUB_REPOSITORY_VISIBILITY: \$\{\{ github\.event\.repository\.visibility \}\}/,
        `${name}: the step running \`release.mjs validate\` must pass the visibility it reads`,
      );
    }
  }
});

// `environment: npm` on the called job is necessary but not sufficient: without
// `secrets: inherit` on the caller, a called workflow resolves every
// environment-scoped secret to an empty string instead of failing, so the
// bootstrap step runs with no token. That is how the first 0.3.1 attempt
// published six images and nothing to npm. Both halves are asserted here
// because either one alone silently reproduces that split.
test("the npm publisher inherits the secrets its environment gates", () => {
  const publishNpm = ciWorkflow.split("\n  publish-npm:")[1]?.split("\n\n  ")[0];
  assert.ok(publishNpm, "CI workflow must contain a publish-npm job");
  assert.match(publishNpm, /uses: \.\/\.github\/workflows\/release\.yml/);
  assert.match(
    publishNpm,
    /\n    secrets: inherit\b/,
    "publish-npm must pass secrets to the reusable workflow, or NPM_BOOTSTRAP_TOKEN arrives empty",
  );
  assert.match(
    releaseWorkflow.split("\n  publish:")[1] ?? "",
    /\n    environment: npm\n/,
    "the publish job must still name the environment that gates the token",
  );
});

test("CI publishes only the exact artifact produced after all acceptance jobs", () => {
  assert.match(
    ciWorkflow,
    /concurrency:\n {2}group: ci-\$\{\{ github\.repository \}\}-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/,
  );
  assert.match(ciWorkflow, /npm pack --ignore-scripts --pack-destination "\$release_dir"/);
  assert.match(ciWorkflow, /name: facility-release-package/);
  assert.match(
    ciWorkflow,
    /publish-npm:[\s\S]*needs: \[decide-release, verify, package-release, self-host-build, sandbox-e2e, allocate-release\]/,
  );
  assert.match(ciWorkflow, /publish-npm:[\s\S]*uses: \.\/\.github\/workflows\/release\.yml/);
});

test("CI allocates the version after acceptance and before registry mutation", () => {
  const allocationJob = ciWorkflow
    .split("\n  publish-npm:")[0]
    .split("\n  allocate-release:")[1];
  assert.ok(allocationJob, "CI workflow must contain an allocate-release job");
  assert.match(
    allocationJob,
    /needs: \[decide-release, verify, package-release, self-host-build, sandbox-e2e\]/,
  );
  assert.match(allocationJob, /permissions:\n {6}contents: write/);
  assert.match(allocationJob, /git tag -a "\$TAG" -m "\$VERSION"/);
  assert.match(allocationJob, /git push origin "\$TAG"/);
  assert.match(allocationJob, /if \[ "\$tag_sha" != "\$head_sha" \]; then/);
  assert.ok(
    ciWorkflow.indexOf("\n  allocate-release:") < ciWorkflow.indexOf("\n  publish-npm:"),
    "the immutable version must be allocated before npm can consume it",
  );
  assert.ok(
    ciWorkflow.indexOf("\n  allocate-release:") < ciWorkflow.indexOf("\n  publish-images:"),
    "the immutable version must be allocated before GHCR can consume it",
  );
});

test("release recording reports confirmed artifacts without bypassing cancellation", () => {
  const recordJob = ciWorkflow.split("\n  record-release:")[1];
  assert.ok(recordJob, "CI workflow must contain a record-release job");
  assert.match(recordJob, /if: >-\n      !cancelled\(\)/);
  assert.doesNotMatch(recordJob, /always\(\)/);
  assert.match(recordJob, /needs\.decide-release\.result == 'success'/);
  assert.match(recordJob, /needs\.allocate-release\.result == 'success'/);
  assert.match(recordJob, /needs\.publish-npm\.outputs\.published == 'true'/);
  assert.match(recordJob, /needs\.publish-images\.outputs\.promoted == 'true'/);
  assert.doesNotMatch(recordJob, /needs\.publish-(?:npm|images)\.result == 'success'/);
  assert.match(recordJob, /NPM_PUBLISHED: \$\{\{ needs\.publish-npm\.outputs\.published \}\}/);
  assert.match(recordJob, /IMAGES_PROMOTED: \$\{\{ needs\.publish-images\.outputs\.promoted \}\}/);
  assert.match(recordJob, /if \[ "\$npm_published" != "true" \] && \[ "\$images_promoted" != "true" \]; then/);
  assert.match(recordJob, /tag_sha="\$\(git rev-parse "refs\/tags\/\$TAG\^\{commit\}"\)"/);
  assert.match(recordJob, /if \[ "\$tag_sha" != "\$head_sha" \]; then/);
  assert.match(recordJob, /if gh release view "\$TAG" >\/dev\/null 2>&1; then/);
  assert.match(recordJob, /else\n {12}gh release create "\$TAG"/);
  assert.doesNotMatch(
    recordJob,
    /already exists; the release was recorded by an earlier run\."\n {12}exit 0/,
  );
  assert.match(recordJob, /## Artifact status/);
  assert.match(recordJob, /npm package: published/);
  assert.match(recordJob, /npm package: publication was not confirmed/);
  assert.match(recordJob, /container image set: promoted/);
  assert.match(recordJob, /container image set: promotion was not confirmed complete/);
});
