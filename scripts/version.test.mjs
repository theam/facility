import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  classify,
  decide,
  lastReleaseTag,
  nextVersion,
  parseSubject,
  releaseNotes,
} from "./version.mjs";

function git(repoDir, args) {
  return execFileSync(
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
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    },
  ).trim();
}

function localRepository(t, name) {
  const repoDir = mkdtempSync(join(tmpdir(), `facility-version-${name}-`));
  t.after(() => rmSync(repoDir, { recursive: true, force: true }));
  git(repoDir, ["init", "--initial-branch=main"]);
  git(repoDir, ["commit", "--allow-empty", "-m", "chore: establish the fixture"]);
  return repoDir;
}

function tagRelease(repoDir, tag) {
  git(repoDir, ["tag", "-a", tag, "-m", tag.slice(1)]);
}

function commit(repoDir, subject, body, { verbatim = false } = {}) {
  git(repoDir, [
    "commit",
    "--allow-empty",
    ...(verbatim ? ["--cleanup=verbatim"] : []),
    "-m",
    subject,
    ...(body ? ["-m", body] : []),
  ]);
}

test("parses conventional subjects, including scopes and breaking markers", () => {
  assert.deepEqual(parseSubject("feat: add the inbox"), {
    type: "feat",
    scope: null,
    breaking: false,
    summary: "add the inbox",
  });
  assert.deepEqual(parseSubject("fix(gateway): drain metering on shutdown"), {
    type: "fix",
    scope: "gateway",
    breaking: false,
    summary: "drain metering on shutdown",
  });
  assert.equal(parseSubject("chore(deps)!: drop node 20")?.breaking, true);
});

test("rejects subjects that are not allowed conventional commits", () => {
  assert.equal(parseSubject("Update README"), null);
  assert.equal(parseSubject("Merge pull request #51 from theam/ci/publish-images"), null);
  assert.throws(() => classify(["Update README"]), /commit subject is not an allowed Conventional Commit/);
});

test("only user-visible types release", () => {
  const commits = classify([
    "docs: retire the v1 PRD",
    "ci: publish the service images",
    "chore: tidy",
    "test: cover the drain",
    "fix(gateway): drain metering",
    "revert: restore the safe gateway behavior",
  ]);
  assert.deepEqual(
    commits.map((commit) => commit.type),
    ["fix", "revert"],
  );
});

test("a breaking change releases even when its type would not", () => {
  const commits = classify(["refactor!: rename the run contract"]);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].breaking, true);
});

test("a BREAKING CHANGE footer counts as breaking", () => {
  const commits = classify([
    "refactor: rename the run contract\n\nBREAKING CHANGE: runs/:id moved",
  ]);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].breaking, true);
});

test("before 1.0 a breaking change is a minor and everything else a patch", () => {
  assert.equal(nextVersion("0.3.0", classify(["fix: a"])), "0.3.1");
  assert.equal(nextVersion("0.3.0", classify(["feat: a"])), "0.3.1");
  assert.equal(nextVersion("0.3.7", classify(["feat!: a"])), "0.4.0");
});

test("after 1.0 the usual semver applies", () => {
  assert.equal(nextVersion("1.4.2", classify(["fix: a"])), "1.4.3");
  assert.equal(nextVersion("1.4.2", classify(["feat: a"])), "1.5.0");
  assert.equal(nextVersion("1.4.2", classify(["feat!: a"])), "2.0.0");
});

test("nothing releasing means no version at all", () => {
  assert.equal(nextVersion("0.3.0", classify(["docs: a", "chore: b"])), null);
});

test("release notes lead with breaking changes and name the scope", () => {
  const notes = releaseNotes(
    "0.4.0",
    classify([
      "feat!: require node 22",
      "fix(gateway): drain metering",
      "feat: add the inbox",
      "revert: restore the old installer",
    ]),
  );
  assert.match(notes, /^## 0\.4\.0/);
  assert.ok(notes.indexOf("Breaking changes") < notes.indexOf("Features"));
  assert.ok(notes.includes("- **gateway**: drain metering"));
  assert.match(notes, /### Reverts[\s\S]*- restore the old installer/);
});

test("decide reads the last v-tag and the subjects after it", () => {
  const calls = [];
  const exec = (_command, args) => {
    calls.push(args.join(" "));
    if (args[0] === "tag") return "v0.3.0\nv0.2.9\nnot-a-tag\n";
    if (args[0] === "log") return "fix: one\0docs: two\0";
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };
  const decision = decide({ repoDir: "/tmp", exec });
  assert.equal(decision.previous, "0.3.0");
  assert.equal(decision.version, "0.3.1");
  assert.equal(decision.tag, "v0.3.1");
  assert.equal(decision.considered, 2);
  assert.equal(decision.releasing, 1);
  assert.ok(calls.includes("log -z --no-merges --format=%B v0.3.0..HEAD"));
});

test("decide starts from 0.0.0 when the repository has never released", () => {
  const exec = (_command, args) => {
    if (args[0] === "tag") return "\n";
    if (args[0] === "log") return "feat: first\0";
    throw new Error("unexpected");
  };
  assert.equal(decide({ repoDir: "/tmp", exec }).version, "0.0.1");
});

test("decide reports no release when only invisible work landed", () => {
  const exec = (_command, args) => {
    if (args[0] === "tag") return "v0.3.0\n";
    if (args[0] === "log") return "docs: a\0ci: b\0";
    throw new Error("unexpected");
  };
  const decision = decide({ repoDir: "/tmp", exec });
  assert.equal(decision.release, false);
  assert.equal(decision.tag, null);
});

test("without any tag the sequence starts from the version in package.json", () => {
  const exec = (_command, args) => {
    if (args[0] === "tag") return "\n";
    if (args[0] === "log") return "fix: one\0";
    throw new Error("unexpected");
  };
  const decision = decide({ repoDir: "/tmp", exec, fallbackVersion: "0.3.0" });
  assert.equal(decision.previous, "0.3.0");
  assert.equal(decision.version, "0.3.1");
});

test("tag discovery errors fail the release decision closed", () => {
  const failure = new Error("tag refs are unreadable");
  assert.throws(
    () => lastReleaseTag("/tmp", { exec: () => { throw failure; } }),
    (error) => error === failure,
  );
});

test("decide reads footer-only breaking changes from real git messages", (t) => {
  const repoDir = localRepository(t, "breaking-footer");
  tagRelease(repoDir, "v0.3.0");
  commit(
    repoDir,
    "fix: replace the run contract",
    "BREAKING CHANGE: runs/:id moved to sessions/:id",
  );

  const decision = decide({ repoDir });
  assert.equal(decision.previous, "0.3.0");
  assert.equal(decision.version, "0.4.0");
  assert.equal(decision.releasing, 1);
  assert.match(decision.notes, /### Breaking changes[\s\S]*replace the run contract/);
});

test("decide rejects an invalid landed subject from a real git history", (t) => {
  const repoDir = localRepository(t, "invalid-subject");
  tagRelease(repoDir, "v0.3.0");
  commit(repoDir, "  fix: do not normalize the release input", undefined, { verbatim: true });

  assert.throws(
    () => decide({ repoDir }),
    /commit subject is not an allowed Conventional Commit:[\s\S]*  fix: do not normalize/,
  );
});

test("decide publishes a real revert as a patch and includes it in the notes", (t) => {
  const repoDir = localRepository(t, "revert");
  tagRelease(repoDir, "v0.3.0");
  commit(repoDir, "revert: restore the safe gateway behavior");

  const decision = decide({ repoDir });
  assert.equal(decision.version, "0.3.1");
  assert.equal(decision.releasing, 1);
  assert.match(decision.notes, /### Reverts[\s\S]*restore the safe gateway behavior/);
});

test("decide validates and classifies only messages after the latest stable tag", (t) => {
  const repoDir = localRepository(t, "tag-boundary");
  tagRelease(repoDir, "v0.2.0");
  commit(repoDir, "legacy subject before the current release");
  tagRelease(repoDir, "v0.3.0");
  git(repoDir, ["tag", "vlatest"]);
  commit(repoDir, "fix: deliver the next patch");

  const decision = decide({ repoDir });
  assert.equal(decision.previous, "0.3.0");
  assert.equal(decision.version, "0.3.1");
  assert.equal(decision.considered, 1);
  assert.equal(decision.releasing, 1);
});

test("a backfilled consumed-version tag advances the next main change", (t) => {
  const repoDir = localRepository(t, "consumed-version");
  commit(repoDir, "fix(mcp)!: publish npm before the image gate failed");
  tagRelease(repoDir, "v0.9.0");
  commit(repoDir, "feat(governance): require approved plans for Builder");

  const decision = decide({ repoDir });
  assert.equal(decision.previous, "0.9.0");
  assert.equal(decision.version, "0.9.1");
  assert.equal(decision.considered, 1);
  assert.equal(decision.releasing, 1);
});
