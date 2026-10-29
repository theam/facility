import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
const runnerDockerfile = readFileSync(new URL("../runner/Dockerfile", import.meta.url), "utf8");

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

test("digest manifests require the complete, expected three-image set", (t) => {
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
    /expected api,runner,web plus optional service-packages/,
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
  assert.match(scanJob, /for image in api web runner/);
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
    /publish-images:[\s\S]*needs: \[decide-release, verify, package-release, self-host-build, workspace-e2e, allocate-release\]/,
  );
  assert.match(ciWorkflow, /publish-images:[\s\S]*uses: \.\/\.github\/workflows\/images\.yml/);
});

test("workspace CI runs the persistent Docker acceptance path", () => {
  const workspaceJob = ciWorkflow.split("\n  publish-npm:")[0].split("\n  workspace-e2e:")[1];
  assert.ok(workspaceJob, "CI must contain the workspace E2E job");
  assert.match(workspaceJob, /FACILITY_E2E_DOCKER: "1"/);
  assert.match(workspaceJob, /FACILITY_WORKSPACE_TEST_IMAGE: facility-runner:dev/);
  assert.match(workspaceJob, /run: pnpm test:e2e-workspace/);
  assert.doesNotMatch(workspaceJob, /CodeBuild|run-objective|sandbox\.e2e/);
});

test("runner Go binaries resolve the fixed cryptography and gRPC modules", () => {
  assert.doesNotMatch(runnerDockerfile, /google\.golang\.org\/grpc@v1\.83\.1/);
  assert.doesNotMatch(runnerDockerfile, /golang\.org\/x\/crypto@v0\.55\.0/);
  assert.match(
    runnerDockerfile,
    /for binary in \/out\/dockerd \/out\/containerd \/out\/rootlesskit \/out\/docker-buildx \/out\/docker-compose \/out\/gh; do[\s\S]*golang\.org\/x\/crypto" && \$3 == "v0\.56\.0"/,
  );
  assert.match(
    runnerDockerfile,
    /for binary in \/out\/dockerd \/out\/containerd \/out\/containerd-shim-runc-v2 \/out\/ctr \/out\/docker-buildx \/out\/docker-compose \/out\/gh; do[\s\S]*google\.golang\.org\/grpc" && \$3 == "v1\.83\.2"/,
  );
});

test("containerd rebuilds against patched compression without downgrading other tools", () => {
  const sourceBuild = runnerDockerfile.split(" AS containerd-build\n")[1]?.split("\nFROM ")[0];
  const replacement =
    /go mod edit -replace=github\.com\/klauspost\/compress=github\.com\/klauspost\/compress@v1\.18\.7\s/g;
  assert.match(sourceBuild ?? "", replacement);
  assert.equal([...runnerDockerfile.matchAll(replacement)].length, 1);
});

test("compression audit validates effective embedded versions and fails closed on inspection errors", () => {
  const audit = [...runnerDockerfile.matchAll(/for binary in ([^;]+); do[\s\S]*?\n {2}done/g)].find(
    ([loop]) => loop.includes('"github.com/klauspost/compress"'),
  );
  assert.ok(audit, "missing executable compression audit");
  assert.equal(audit[1], "/out/*", "inspect every copied Go binary");
  const binaries = [
    "/out/dockerd",
    "/out/docker-proxy",
    "/out/docker",
    "/out/containerd",
    "/out/containerd-shim-runc-v2",
    "/out/ctr",
    "/out/rootlesskit",
    "/out/docker-buildx",
    "/out/docker-compose",
    "/out/runc",
    "/out/gh",
  ];
  // Expand the production glob deterministically without writing to host /out.
  const loop = audit[0].replace("in /out/*;", `in ${binaries.join(" ")};`);
  const command = `
    go() {
      if [ "$3" = "$AUDIT_TEST_BINARY" ]; then
        case "$AUDIT_TEST_VARIANT" in
          outdated) printf 'dep github.com/klauspost/compress v1.18.6\\n'; return ;;
          stale-replacement) printf 'dep github.com/klauspost/compress v1.18.4\\n=> github.com/klauspost/compress v1.18.5\\n'; return ;;
          substituted) printf 'dep github.com/klauspost/compress v1.18.4\\n=> example.com/fork v1.18.7\\n'; return ;;
          malformed) printf 'dep github.com/klauspost/compress\\n'; return ;;
          error) return 1 ;;
          patched) printf 'dep github.com/klauspost/compress v1.18.7\\n'; return ;;
          newer) printf 'dep github.com/klauspost/compress v1.19.1\\n'; return ;;
          newer-replacement) printf 'dep github.com/klauspost/compress v1.18.5\\n=> github.com/klauspost/compress v1.19.1\\n'; return ;;
          prerelease) printf 'dep github.com/klauspost/compress v1.18.7-beta\\n'; return ;;
          unreviewed-major) printf 'dep github.com/klauspost/compress v2.0.0\\n'; return ;;
          absent) printf 'dep example.com/unrelated v1.18.5\\n'; return ;;
        esac
      fi
      printf 'dep example.com/unrelated v1.18.5\\ndep github.com/klauspost/compress v1.18.4\\n=> github.com/klauspost/compress v1.18.7\\ndep example.com/next v1.0.0\\n'
    }
    ${loop.replaceAll(/\\\n/g, " ")}
  `;
  const runAudit = (binary = "", variant = "") =>
    spawnSync("sh", ["-c", command], {
      encoding: "utf8",
      env: { ...process.env, AUDIT_TEST_BINARY: binary, AUDIT_TEST_VARIANT: variant },
    });
  assert.equal(runAudit().status, 0);
  for (const binary of binaries) {
    for (const variant of ["patched", "newer", "newer-replacement", "absent"]) {
      const result = runAudit(binary, variant);
      assert.equal(result.status, 0, `${binary}: ${variant}: ${result.stderr}`);
    }
    for (const variant of [
      "outdated",
      "stale-replacement",
      "substituted",
      "malformed",
      "prerelease",
      "unreviewed-major",
      "error",
    ]) {
      const result = runAudit(binary, variant);
      assert.equal(result.status, 1, `${binary}: ${variant} must fail closed: ${result.stderr}`);
    }
  }
});

test("JOSE audit validates effective embedded versions and fails closed on inspection errors", () => {
  const audit = [...runnerDockerfile.matchAll(/for binary in ([^;]+); do[\s\S]*?\n {2}done/g)].find(
    ([loop]) => loop.includes('"github.com/go-jose/go-jose/v4"'),
  );
  assert.ok(audit, "missing executable JOSE audit");
  assert.equal(audit[1], "/out/*", "inspect every copied Go binary");
  const binaries = [
    "/out/dockerd",
    "/out/docker-proxy",
    "/out/docker",
    "/out/containerd",
    "/out/containerd-shim-runc-v2",
    "/out/ctr",
    "/out/rootlesskit",
    "/out/docker-buildx",
    "/out/docker-compose",
    "/out/runc",
    "/out/gh",
  ];
  // Expand the production glob deterministically without writing to host /out.
  const loop = audit[0].replace("in /out/*;", `in ${binaries.join(" ")};`);
  const command = `
    go() {
      if [ "$3" = "$AUDIT_TEST_BINARY" ]; then
        case "$AUDIT_TEST_VARIANT" in
          outdated) printf 'dep github.com/go-jose/go-jose/v4 v4.1.5\\n'; return ;;
          stale-replacement) printf 'dep github.com/go-jose/go-jose/v4 v4.1.2\\n=> github.com/go-jose/go-jose/v4 v4.1.3\\n'; return ;;
          substituted) printf 'dep github.com/go-jose/go-jose/v4 v4.1.2\\n=> example.com/fork v4.1.6\\n'; return ;;
          malformed) printf 'dep github.com/go-jose/go-jose/v4\\n'; return ;;
          error) return 1 ;;
          patched) printf 'dep github.com/go-jose/go-jose/v4 v4.1.6\\n'; return ;;
          newer) printf 'dep github.com/go-jose/go-jose/v4 v4.2.0\\n'; return ;;
          newer-replacement) printf 'dep github.com/go-jose/go-jose/v4 v4.1.3\\n=> github.com/go-jose/go-jose/v4 v4.2.0\\n'; return ;;
          prerelease) printf 'dep github.com/go-jose/go-jose/v4 v4.1.6-beta\\n'; return ;;
          unreviewed-major) printf 'dep github.com/go-jose/go-jose/v4 v5.0.0\\n'; return ;;
          absent) printf 'dep example.com/unrelated v4.1.3\\n'; return ;;
        esac
      fi
      printf 'dep example.com/unrelated v4.1.3\\ndep github.com/go-jose/go-jose/v4 v4.1.2\\n=> github.com/go-jose/go-jose/v4 v4.1.6\\ndep example.com/next v1.0.0\\n'
    }
    ${loop.replaceAll(/\\\n/g, " ")}
  `;
  const runAudit = (binary = "", variant = "") =>
    spawnSync("sh", ["-c", command], {
      encoding: "utf8",
      env: { ...process.env, AUDIT_TEST_BINARY: binary, AUDIT_TEST_VARIANT: variant },
    });
  assert.equal(runAudit().status, 0);
  for (const binary of binaries) {
    for (const variant of ["patched", "newer", "newer-replacement", "absent"]) {
      const result = runAudit(binary, variant);
      assert.equal(result.status, 0, `${binary}: ${variant}: ${result.stderr}`);
    }
    for (const variant of [
      "outdated",
      "stale-replacement",
      "substituted",
      "malformed",
      "prerelease",
      "unreviewed-major",
      "error",
    ]) {
      const result = runAudit(binary, variant);
      assert.equal(result.status, 1, `${binary}: ${variant} must fail closed: ${result.stderr}`);
    }
  }
});

test("every gRPC-bearing source build replaces the vulnerable module", () => {
  assert.doesNotMatch(runnerDockerfile, /google\.golang\.org\/grpc[^\n]*v1\.83\.1/);
  for (const stage of [
    "moby-build",
    "containerd-build",
    "buildx-build",
    "compose-build",
    "gh-build",
  ]) {
    const sourceBuild = runnerDockerfile.split(` AS ${stage}\n`)[1]?.split("\nFROM ")[0];
    assert.ok(sourceBuild, `missing source build ${stage}`);
    assert.match(
      sourceBuild,
      /go mod edit -replace=google\.golang\.org\/grpc=google\.golang\.org\/grpc@v1\.83\.2\s/,
      `${stage} must rebuild against the fixed gRPC module`,
    );
  }
});

test("the executable gRPC audit accepts fixed modules and rejects unsafe binaries", () => {
  // Execute the Dockerfile's actual shell loop with deterministic go-version output.
  // This checks the gate itself without requiring registries or a Go toolchain.
  const audit = [...runnerDockerfile.matchAll(/for binary in ([^;]+); do[\s\S]*?\n {2}done/g)].find(
    ([loop]) => loop.includes('"google.golang.org/grpc"'),
  );
  assert.ok(audit, "missing executable gRPC audit");
  const binaries = audit[1].split(" ");
  assert.equal(binaries.length, 7);
  const command = `
    go() {
      if [ "$3" = "$AUDIT_TEST_BINARY" ]; then
        case "$AUDIT_TEST_FAILURE" in
          outdated) printf '=> google.golang.org/grpc v1.83.1\\n'; return ;;
          missing) printf 'dep example.com/unrelated v1.0.0\\n'; return ;;
          error) return 1 ;;
        esac
      fi
      printf '=> google.golang.org/grpc v1.83.2\\n'
    }
    ${audit[0].replaceAll(/\\\n/g, " ")}
  `;
  const runAudit = (binary = "", failure = "") =>
    spawnSync("sh", ["-c", command], {
      encoding: "utf8",
      env: { ...process.env, AUDIT_TEST_BINARY: binary, AUDIT_TEST_FAILURE: failure },
    });
  const accepted = runAudit();
  assert.equal(accepted.status, 0, accepted.stderr);
  for (const binary of binaries) {
    for (const failure of ["outdated", "missing", "error"]) {
      const rejected = runAudit(binary, failure);
      assert.equal(
        rejected.status,
        1,
        `${binary}: ${failure} must fail closed: ${rejected.stderr}`,
      );
    }
  }
});

test("embedded containerd audit rejects old, missing and substituted modules in every consumer", () => {
  const audit = [...runnerDockerfile.matchAll(/for binary in ([^;]+); do[\s\S]*?\n {2}done/g)].find(
    ([loop]) => loop.includes('"github.com/containerd/containerd/v2"'),
  );
  assert.ok(audit, "missing executable containerd audit");
  const binaries = audit[1].split(" ");
  assert.deepEqual(binaries, ["/out/dockerd", "/out/docker-buildx", "/out/docker-compose"]);
  const command = `
    go() {
      if [ "$3" = "$AUDIT_TEST_BINARY" ]; then
        case "$AUDIT_TEST_FAILURE" in
          outdated) printf 'dep github.com/containerd/containerd/v2 v2.3.3\\n'; return ;;
          stale-replacement) printf 'dep github.com/containerd/containerd/v2 v2.3.3\\n=> github.com/containerd/containerd/v2 v2.3.3\\n'; return ;;
          substituted) printf 'dep github.com/containerd/containerd/v2 v2.3.3\\n=> example.com/fork v2.3.6\\n'; return ;;
          missing) printf 'dep example.com/unrelated v2.3.6\\n'; return ;;
          error) return 1 ;;
        esac
      fi
      printf 'dep github.com/containerd/containerd/v2 v2.3.3\\n=> github.com/containerd/containerd/v2 v2.3.6\\n'
    }
    ${audit[0].replaceAll(/\\\n/g, " ")}
  `;
  const runAudit = (binary = "", failure = "") =>
    spawnSync("sh", ["-c", command], {
      encoding: "utf8",
      env: { ...process.env, AUDIT_TEST_BINARY: binary, AUDIT_TEST_FAILURE: failure },
    });
  const accepted = runAudit();
  assert.equal(accepted.status, 0, accepted.stderr);
  for (const binary of binaries) {
    for (const failure of ["outdated", "stale-replacement", "substituted", "missing", "error"]) {
      const rejected = runAudit(binary, failure);
      assert.equal(
        rejected.status,
        1,
        `${binary}: ${failure} must fail closed: ${rejected.stderr}`,
      );
    }
  }
});

test("Vercel runner supports SDK user switching without granting node sudo privileges", () => {
  const vercelStage = runnerDockerfile
    .split("FROM runner-base AS vercel-runner")[1]
    ?.split("FROM runner-base AS runner")[0];
  assert.ok(vercelStage);
  assert.match(vercelStage, /apt-get install -y --no-install-recommends sudo/);
  assert.match(vercelStage, /sudo -n -u node -- sh -c/);
  assert.match(vercelStage, /test -u \/usr\/bin\/sudo/);
  assert.match(vercelStage, /runuser -u node -- sh -c/);
  assert.match(vercelStage, /! runuser -u node -- sudo -n -u root -- true/);
  assert.doesNotMatch(vercelStage, /NOPASSWD/);
  assert.match(ciWorkflow, /docker build --target vercel-runner -f runner\/Dockerfile \./);
});

test("runner rejects Chromium packages older than the reviewed security fix", () => {
  assert.match(runnerDockerfile, /ARG CHROMIUM_MIN_VERSION=155\.0\.8059\.79-1~deb13u1/);
  for (const name of ["chromium", "chromium-common"]) {
    assert.ok(
      runnerDockerfile.includes(
        `dpkg --compare-versions "$(dpkg-query -W -f='\${Version}' ${name})" ge "$CHROMIUM_MIN_VERSION"`,
      ),
    );
  }
  assert.match(runnerDockerfile, /ARG EXPAT_MIN_VERSION=2\.9\.0-1~deb13u1/);
  assert.ok(
    runnerDockerfile.includes(
      `dpkg --compare-versions "$(dpkg-query -W -f='\${Version}' libexpat1)" ge "$EXPAT_MIN_VERSION"`,
    ),
  );
});

test("image security refreshes invalidate cached distro layers and audit the cached package manager", () => {
  for (const path of ["Dockerfile", "apps/web/Dockerfile", "runner/Dockerfile"]) {
    const dockerfile = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    const epoch = path === "runner/Dockerfile" ? "20261019" : "20261005";
    assert.ok(dockerfile.includes(`ARG DEBIAN_SECURITY_REFRESH=${epoch}`));
    assert.match(dockerfile, /test -n "\$DEBIAN_SECURITY_REFRESH"/);
  }
  assert.match(runnerDockerfile, /brace-expansion@5\.0\.12/);
  assert.match(runnerDockerfile, /undici@6\.29\.1/);
  const seed = runnerDockerfile.indexOf(
    'corepack install --global --cache-only "$package_manager"',
  );
  const audit = runnerDockerfile.indexOf("node /tmp/verify-package-security.mjs");
  const freeze = runnerDockerfile.indexOf("chmod -R a-w /opt/facility-corepack");
  assert.ok(seed > 0 && audit > seed && freeze > audit);
});
