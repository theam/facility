#!/usr/bin/env node
// Decides whether a merge to main releases, and what version it releases.
//
// The full commit messages since the last release are the input; the repository has
// no version-bump commit and no release pull request. `package.json` is stamped
// from this decision inside the release run. After every acceptance gate passes,
// CI allocates the git tag before either immutable registry can consume the
// version, preventing a partial or uncertain publish from reusing the number.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import {
  assertSubject,
  messagesForRevision,
  parseSubject,
  releaseImpact,
  subjectOf,
} from "./conventional-commit-subjects.mjs";

export { parseSubject };

/**
 * A commit releases if its subject is a releasing type, or if it breaks
 * something — a breaking `refactor!` still has to reach users.
 */
export function classify(messages) {
  const commits = [];
  for (const message of messages) {
    const parsed = assertSubject(subjectOf(message), { label: "commit subject" });
    const impact = releaseImpact(message);
    if (impact === "none") continue;
    commits.push({ ...parsed, breaking: impact === "minor" });
  }
  return commits;
}

/**
 * Pre-1.0, a breaking change is a minor and everything else is a patch — the
 * plain reading of "no upgrade path is promised between 0.x releases". After
 * 1.0 the usual major/minor/patch applies.
 */
export function nextVersion(current, commits) {
  const [major, minor, patch] = current.split(".").map((part) => Number.parseInt(part, 10));
  if ([major, minor, patch].some((part) => Number.isNaN(part))) {
    throw new Error(`current version is not a semver triple: ${current}`);
  }
  if (commits.length === 0) return null;
  const breaking = commits.some((commit) => commit.breaking);
  const feature = commits.some((commit) => commit.type === "feat");
  if (major === 0) {
    return breaking ? `0.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
  }
  if (breaking) return `${major + 1}.0.0`;
  return feature ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

/** Release notes grouped the way a reader scans them: breaking first. */
export function releaseNotes(version, commits) {
  const groups = [
    ["Breaking changes", commits.filter((commit) => commit.breaking)],
    ["Features", commits.filter((commit) => commit.type === "feat" && !commit.breaking)],
    ["Fixes", commits.filter((commit) => commit.type === "fix" && !commit.breaking)],
    ["Performance", commits.filter((commit) => commit.type === "perf" && !commit.breaking)],
    ["Reverts", commits.filter((commit) => commit.type === "revert" && !commit.breaking)],
  ];
  const lines = [`## ${version}`, ""];
  for (const [heading, entries] of groups) {
    if (entries.length === 0) continue;
    lines.push(`### ${heading}`, "");
    for (const entry of entries) {
      lines.push(`- ${entry.scope ? `**${entry.scope}**: ` : ""}${entry.summary}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function lastReleaseTag(repoDir = process.cwd(), { exec = execFileSync } = {}) {
  const tags = exec("git", ["tag", "--list", "v*", "--sort=-v:refname"], {
    cwd: repoDir,
    encoding: "utf8",
  })
    .split("\n")
    .map((tag) => tag.trim())
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
  return tags[0] ?? null;
}

export function messagesSince(tag, repoDir = process.cwd(), { exec = execFileSync } = {}) {
  const revision = tag ? `${tag}..HEAD` : "HEAD";
  return messagesForRevision(revision, { repoDir, exec });
}

/**
 * The tags are the source of truth for what has been released. Before the first
 * one exists there is nothing to read, so the version in package.json seeds the
 * sequence — otherwise a repository that already shipped a 0.3.0 would compute
 * its next release as 0.1.0 and try to publish backwards.
 */
export function decide({ repoDir = process.cwd(), exec = execFileSync, fallbackVersion } = {}) {
  const tag = lastReleaseTag(repoDir, { exec });
  const current = tag ? tag.slice(1) : (fallbackVersion ?? "0.0.0");
  const messages = messagesSince(tag, repoDir, { exec });
  const commits = classify(messages);
  const version = nextVersion(current, commits);
  return {
    release: version !== null,
    version,
    previous: current,
    tag: version ? `v${version}` : null,
    notes: version ? releaseNotes(version, commits) : "",
    considered: messages.length,
    releasing: commits.length,
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  const fallbackVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
  const decision = decide({ fallbackVersion });
  const summary =
    `${decision.considered} commits since ${decision.previous}, ${decision.releasing} of them releasing` +
    (decision.release ? ` → ${decision.version}` : " → no release");
  console.error(summary);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `release=${decision.release}`,
        `version=${decision.version ?? ""}`,
        `tag=${decision.tag ?? ""}`,
        `notes<<FACILITY_NOTES_EOF`,
        decision.notes,
        `FACILITY_NOTES_EOF`,
        "",
      ].join("\n"),
    );
  } else {
    console.log(JSON.stringify(decision, null, 2));
  }
}
