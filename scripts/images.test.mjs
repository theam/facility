import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BUILD_IMAGES,
  loadDigests,
  parseTagsJson,
  publicationPlan,
  recordBakeDigests,
  recordDigest,
  validateRepositoryIdentity,
} from "./images.mjs";

const sha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const imagesWorkflow = readFileSync(
  new URL("../.github/workflows/images.yml", import.meta.url),
  "utf8",
);
const ciWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

test("manual publication is SHA-only even when dispatch targets a tag", () => {
  for (const ref of ["refs/heads/main", "refs/heads/feature", "refs/tags/v0.3.0"]) {
    assert.deepEqual(
      publicationPlan({
        eventName: "workflow_dispatch",
        ref,
        visibility: "public",
        sha,
      }),
      { mode: "manual", tags: [`sha-${sha.slice(0, 12)}`] },
    );
  }
});

test("an accepted release publishes its immutable SHA and matching version tags", () => {
  assert.deepEqual(
    publicationPlan({
      eventName: "push",
      ref: "refs/heads/main",
      visibility: "public",
      sha,
      release: { tag: "v0.3.0", version: "0.3.0" },
    }),
    { mode: "release", tags: [`sha-${sha.slice(0, 12)}`, "0.3.0"] },
  );
});

test("malformed, private, and unvalidated release inputs fail closed", () => {
  const valid = {
    eventName: "push",
    ref: "refs/heads/main",
    visibility: "public",
    sha,
    release: { tag: "v0.3.0", version: "0.3.0" },
  };
  const invalid = [
    [{ sha: "deadbeef" }, /full lowercase GitHub commit SHA/],
    [{ eventName: "pull_request" }, /does not accept pull_request/],
    [{ visibility: "private" }, /disabled until the repository is public/],
    [{ release: undefined }, /requires a validated release/],
    [{ release: { tag: "vlatest", version: "0.3.0" } }, /does not match v0\.3\.0/],
    [{ ref: "refs/tags/v0.3.0" }, /release images come from main/],
    [{ ref: "refs/heads/feature" }, /release images come from main/],
    [{ release: { tag: "v0.3.0,latest", version: "0.3.0,latest" } }, /invalid container tag/],
  ];
  for (const [override, message] of invalid) {
    assert.throws(() => publicationPlan({ ...valid, ...override }), message);
  }
});

test("repository and tag inputs reject cross-owner and injection-shaped values", () => {
  assert.deepEqual(
    validateRepositoryIdentity({
      repository: "theam/facility",
      owner: "theam",
      ownerType: "Organization",
    }),
    {
      owner: "theam",
      ownerType: "Organization",
      repository: "theam/facility",
      repositoryName: "facility",
    },
  );
  assert.throws(
    () =>
      validateRepositoryIdentity({
        repository: "another/facility",
        owner: "theam",
        ownerType: "Organization",
      }),
    /does not belong to expected owner/,
  );
  assert.throws(() => parseTagsJson('["sha-good","bad,tag"]'), /invalid container tag/);
  assert.throws(() => parseTagsJson('["same","same"]'), /duplicate tag/);
});

test("digest manifests require the complete, expected five-image set", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "facility-image-digests-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  for (const image of BUILD_IMAGES) recordDigest({ image, digest, directory });
  assert.deepEqual(
    [...loadDigests(directory)],
    BUILD_IMAGES.map((image) => [image, digest]),
  );

  writeFileSync(join(directory, "api.json"), JSON.stringify({ image: "worker", digest }));
  assert.throws(() => loadDigests(directory), /names worker, expected api/);
});

test("one Bake result records an exact, internally consistent digest set", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "facility-bake-digests-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const metadata = Object.fromEntries(
    BUILD_IMAGES.map((image, index) => {
      const imageDigest = `sha256:${String(index + 1).repeat(64)}`;
      return [
        image,
        {
          "containerimage.digest": imageDigest,
          "containerimage.descriptor": { digest: imageDigest },
        },
      ];
    }),
  );
  metadata["service-packages"] = {};

  assert.equal(recordBakeDigests({ metadata, directory }).length, BUILD_IMAGES.length);
  assert.deepEqual(
    [...loadDigests(directory)],
    BUILD_IMAGES.map((image, index) => [image, `sha256:${String(index + 1).repeat(64)}`]),
  );
  assert.throws(
    () => recordBakeDigests({ metadata: { ...metadata, unexpected: {} }, directory }),
    /expected api,gateway,mcp,runner,web plus optional service-packages/,
  );
  assert.throws(
    () =>
      recordBakeDigests({
        metadata: {
          ...metadata,
          api: { ...metadata.api, "containerimage.descriptor": { digest } },
        },
        directory,
      }),
    /descriptor for api does not match/,
  );
});

test("CI gates release images and the reusable publisher stages digests before promotion", () => {
  assert.match(imagesWorkflow, /on:\n {2}workflow_call:\n {4}inputs:\n {6}version:/);
  assert.match(
    imagesWorkflow,
    /workflow_call:[\s\S]*outputs:\n {6}promoted:[\s\S]*value: \$\{\{ jobs\.promote\.outputs\.promoted \}\}/,
  );
  assert.match(imagesWorkflow, /\n {2}workflow_dispatch:\n/);
  assert.doesNotMatch(imagesWorkflow, /tags: \["v\*"\]/);
  assert.match(
    imagesWorkflow,
    /group: images-\$\{\{ github\.repository \}\}\n {2}cancel-in-progress: false/,
  );
  assert.match(imagesWorkflow, /node scripts\/images\.mjs plan/);
  const buildJob = imagesWorkflow.split("\n  promote:")[0].split("\n  build:")[1];
  assert.ok(buildJob, "images workflow must contain a build job");
  assert.match(
    buildJob,
    /- name: Stamp the decided version\n {8}if: inputs\.version != ''\n {8}run: node scripts\/release\.mjs stamp "\$\{\{ inputs\.version \}\}"/,
  );
  assert.ok(
    buildJob.indexOf("Stamp the decided version") <
      buildJob.indexOf("Build and push the addressable image set"),
    "the isolated build checkout must be stamped before Docker consumes it",
  );
  assert.doesNotMatch(buildJob, /strategy:|matrix:/);
  assert.ok(
    buildJob.indexOf("crazy-max/ghaction-github-runtime@") < buildJob.indexOf("docker buildx bake"),
    "raw Buildx must receive the GitHub Actions cache runtime before Bake runs",
  );
  assert.match(buildJob, /docker buildx bake/);
  assert.match(buildJob, /--file docker-bake\.publish\.hcl/);
  assert.match(buildJob, /--metadata-file "\$metadata"/);
  assert.match(buildJob, /node scripts\/images\.mjs record-bake-digests/);
  assert.match(buildJob, /facility-image-digests-\$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(
    buildJob,
    /build[_-]args|FACILITY_API_URL=/,
    "the release web image must remain portable across runtime API origins",
  );
  const scanJob = imagesWorkflow.split("\n  promote:")[0].split("\n  scan:")[1];
  assert.ok(scanJob, "images workflow must scan the addressable digest set");
  assert.match(scanJob, /needs: build/);
  assert.doesNotMatch(scanJob, /anchore\/scan-action|raw\.githubusercontent\.com/);
  assert.match(scanJob, /GRYPE_VERSION: 0\.110\.0/);
  assert.match(scanJob, /GRYPE_SHA256: [0-9a-f]{64}/);
  assert.match(scanJob, /sha256sum --check --strict/);
  assert.match(scanJob, /"\$GRYPE" db update/);
  assert.match(scanJob, /GRYPE_DB_AUTO_UPDATE: "false"/);
  assert.match(scanJob, /GRYPE_CHECK_FOR_APP_UPDATE: "false"/);
  assert.match(scanJob, /actions\/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5/);
  assert.match(scanJob, /for image in api gateway mcp web runner/);
  assert.match(scanJob, /registry:\$IMAGE_PREFIX\/\$image@\$digest/);
  assert.match(scanJob, /--fail-on high --only-fixed/);
  assert.match(scanJob, /\[\[ "\$image" == "runner" \]\]/);
  assert.match(scanJob, /--config "\$GITHUB_WORKSPACE\/runner\/grype\.yaml"/);
  assert.match(scanJob, /cd "\$RUNNER_TEMP"/);
  assert.match(scanJob, /scan_failed=1/);
  assert.match(scanJob, /exit "\$scan_failed"/);
  assert.doesNotMatch(scanJob, /matrix:/);
  assert.match(imagesWorkflow, /promote:\n {4}needs: \[plan, build, scan\]/);
  assert.match(imagesWorkflow, /node scripts\/images\.mjs promote/);
  assert.match(
    imagesWorkflow,
    /promote:[\s\S]*outputs:\n {6}promoted: \$\{\{ steps\.promotion\.outputs\.promoted \}\}/,
  );
  assert.match(imagesWorkflow, /id: promotion\n {8}run: echo 'promoted=true' >> "\$GITHUB_OUTPUT"/);
  assert.match(
    ciWorkflow,
    /publish-images:[\s\S]*needs: \[decide-release, verify, package-release, self-host-build, sandbox-e2e, allocate-release\]/,
  );
  assert.match(ciWorkflow, /publish-images:[\s\S]*uses: \.\/\.github\/workflows\/images\.yml/);
});

test("sandbox CI explicitly admits RootlessKit user namespaces on Ubuntu 24.04", () => {
  const sandboxJob = ciWorkflow.split("\n  publish-npm:")[0].split("\n  sandbox-e2e:")[1];
  assert.ok(sandboxJob, "CI must contain the sandbox E2E job");
  assert.match(sandboxJob, /- name: Permit nested rootless user namespaces/);
  assert.match(sandboxJob, /key=kernel\.apparmor_restrict_unprivileged_userns/);
  assert.match(sandboxJob, /if sudo sysctl "\$key" >\/dev\/null 2>&1; then/);
  assert.match(sandboxJob, /sudo sysctl -w "\$key=0"/);
  assert.ok(
    sandboxJob.indexOf("Permit nested rootless user namespaces") <
      sandboxJob.indexOf("Exercise the privileged CodeBuild boundary"),
    "the host must admit unprivileged user namespaces before RootlessKit starts",
  );
});
