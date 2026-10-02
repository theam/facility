#!/usr/bin/env node
// Workspace entrypoint for git and gh. Every agent gets the same rules:
// no pull-request merge (including the HTTP merge endpoint), no push to a
// repository's default branch, and no force-push. An ordinary push to the
// story branch is allowed.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GIT_GLOBAL_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
  "--exec-path",
]);
const PUSH_VALUE = new Set([
  "--repo",
  "--receive-pack",
  "--exec",
  "-o",
  "--push-option",
  "--recurse-submodules",
]);
const GH_VALUE = new Set([
  "-R",
  "--repo",
  "--hostname",
  "--jq",
  "--template",
  "--cache",
  "-X",
  "--method",
  "-H",
  "--header",
  "-f",
  "--raw-field",
  "-F",
  "--field",
  "--input",
  "-i",
  "--preview",
  "-b",
  "--body",
  "-t",
  "--title",
  "-m",
  "--message",
]);
const FALLBACK_BRANCHES = ["main", "master"];

export function githubRepository(remote) {
  const value = remote.trim();
  let path = "";
  if (value.startsWith("git@")) {
    const colon = value.indexOf(":");
    path = colon === -1 ? "" : value.slice(colon + 1);
  } else {
    try {
      path = new URL(value).pathname;
    } catch {
      return null;
    }
  }
  const parts = path
    .replace(/^\/+/, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts[0]}/${parts[1]}`.toLowerCase();
}

export function protectedBranches(env, repository) {
  let map = null;
  try {
    const parsed = JSON.parse(env.FACILITY_DEFAULT_BRANCHES ?? "");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) map = parsed;
  } catch {
    map = null;
  }
  if (!map) return FALLBACK_BRANCHES;
  if (repository && typeof map[repository] === "string" && map[repository]) return [map[repository]];
  const branches = [
    ...new Set(Object.values(map).filter((value) => typeof value === "string" && value)),
  ];
  return branches.length > 0 ? branches : FALLBACK_BRANCHES;
}

export function decideGit(args, context) {
  const push = parseGitPush(args);
  if (!push) return { allow: true };
  if (push.force) return deny("Force-push is not allowed.");
  if (push.all || push.mirror) return deny("Pushing every branch is not allowed.");
  const destinations =
    push.refspecs.length > 0
      ? push.refspecs.map((refspec) => destinationBranch(refspec, context.currentBranch))
      : [context.upstreamBranch || context.currentBranch || null];
  if (destinations.some((branch) => branch === null)) {
    return deny("Refusing to push because the destination branch is unknown.");
  }
  const blocked = destinations.find(
    (branch) => branch && context.protectedBranches.includes(branch),
  );
  if (blocked) return deny(`Push to the default branch ${blocked} is not allowed.`);
  return { allow: true };
}

export function decideGh(args) {
  const positionals = ghPositionals(args);
  const [command, subcommand] = positionals;
  if (command === "pr" && subcommand === "merge") {
    return deny("Merging a pull request is not allowed.");
  }
  if (command !== "api") return { allow: true };
  const endpoint = positionals.slice(1).find((token) => token.includes("/") || token === "graphql");
  if (endpoint && isMergeEndpoint(endpoint)) {
    return deny("The pull request merge endpoint is not allowed.");
  }
  if (endpoint === "graphql" || (endpoint?.includes("graphql") ?? false)) {
    const query = graphqlText(args);
    if (query === null || MERGE_MUTATION.test(query)) {
      return deny("The pull request merge endpoint is not allowed.");
    }
  }
  return { allow: true };
}

const MERGE_MUTATION = /mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest/;

function deny(reason) {
  return { allow: false, reason };
}

function graphqlText(args) {
  const chunks = [args.join("\n")];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const next = token === "--input" || token === "-i" ? args[index + 1] : null;
    const file = next || referencedFile(token);
    if (!file) continue;
    try {
      chunks.push(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }
  return chunks.join("\n");
}

function referencedFile(token) {
  if (token.startsWith("--input=")) return token.slice("--input=".length);
  const at = token.indexOf("@");
  if (at <= 0) return null;
  const prefix = token.slice(0, at);
  if (prefix.endsWith("=") || prefix === "-f" || prefix === "-F") return token.slice(at + 1);
  return null;
}

function parseGitPush(args) {
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token === "--") {
      index += 1;
      break;
    }
    if (!token.startsWith("-")) break;
    const name = token.split("=", 1)[0];
    if (!token.includes("=") && GIT_GLOBAL_VALUE.has(name)) index += 1;
    index += 1;
  }
  if (args[index] !== "push") return null;
  const push = {
    force: false,
    all: false,
    mirror: false,
    remote: null,
    refspecs: [],
    prefix: args.slice(0, index),
    explicitRepo: false,
  };
  const candidates = [];
  for (let cursor = index + 1; cursor < args.length; cursor += 1) {
    const token = args[cursor];
    if (token === "--") {
      candidates.push(...args.slice(cursor + 1));
      break;
    }
    if (token.startsWith("-")) {
      if (isForceOption(token)) push.force = true;
      if (token === "--all") push.all = true;
      if (token === "--mirror") push.mirror = true;
      const name = token.split("=", 1)[0];
      if (name === "--repo") push.explicitRepo = true;
      if (!token.includes("=") && PUSH_VALUE.has(name)) cursor += 1;
      continue;
    }
    candidates.push(token);
  }
  if (push.explicitRepo) {
    push.remote = candidates.find(isRemoteUrl) ?? null;
    push.refspecs = candidates.filter((token) => !isRemoteUrl(token));
  } else if (candidates.length > 0 && !candidates[0].includes(":") && !isRemoteUrl(candidates[0])) {
    push.remote = candidates[0];
    push.refspecs = candidates.slice(1);
  } else {
    push.remote = candidates.find(isRemoteUrl) ?? null;
    push.refspecs = candidates.filter((token) => !isRemoteUrl(token));
  }
  if (push.refspecs.some((refspec) => refspec.startsWith("+"))) push.force = true;
  return push;
}

function isForceOption(token) {
  if (token === "--force" || token.startsWith("--force=") || token.startsWith("--force-with-lease")) {
    return true;
  }
  if (token.startsWith("--force-if-includes")) return true;
  return /^-[^-]*f/.test(token);
}

function isRemoteUrl(token) {
  return token.includes("://") || token.startsWith("git@") || token.includes("github.com:");
}

function destinationBranch(refspec, currentBranch) {
  const spec = refspec.startsWith("+") ? refspec.slice(1) : refspec;
  const colon = spec.indexOf(":");
  const raw = colon === -1 ? spec : spec.slice(colon + 1);
  if (!raw) return colon === -1 ? null : branchName(spec.slice(0, colon), currentBranch);
  return branchName(raw, currentBranch);
}

function branchName(ref, currentBranch) {
  if (ref === "HEAD") return currentBranch ?? null;
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  if (ref.startsWith("refs/")) return undefined;
  return ref;
}

function ghPositionals(args) {
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    const name = token.split("=", 1)[0];
    if (!token.includes("=") && GH_VALUE.has(name)) index += 1;
  }
  return positionals;
}

function isMergeEndpoint(endpoint) {
  let path = endpoint;
  try {
    if (path.startsWith("http://") || path.startsWith("https://")) path = new URL(path).pathname;
  } catch {
    return false;
  }
  path = path
    .replace(/^\/+/, "")
    .replace(/^api\/v3\//, "")
    .split("?")[0];
  return /(?:^|\/)repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/merge$/i.test(path) ||
    /(?:^|\/)repos\/[^/]+\/[^/]+\/merges$/i.test(path);
}

function spawnReal(real, args, options) {
  // Node on Windows cannot spawn a .cmd test double directly. The runner is Linux.
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(real)) {
    return spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", real, ...args], options);
  }
  return spawnSync(real, args, options);
}

function realGitEnv() {
  return {
    ...process.env,
    GIT_EXEC_PATH: process.env.FACILITY_GIT_EXEC_PATH ?? "/usr/lib/git-core",
  };
}

function gitText(real, prefix, args) {
  const result = spawnReal(real, [...prefix, ...args], { encoding: "utf8", env: realGitEnv() });
  return result.status === 0 ? result.stdout.trim() : null;
}

function branchContext(real, push) {
  const needsCurrent =
    push.refspecs.length === 0 ||
    push.refspecs.some((refspec) => refspec.replace(/^\+/, "").includes("HEAD"));
  const current = needsCurrent
    ? gitText(real, push.prefix, ["rev-parse", "--abbrev-ref", "HEAD"])
    : null;
  const upstream = push.refspecs.length === 0
    ? gitText(real, push.prefix, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
    : null;
  const slash = upstream?.indexOf("/") ?? -1;
  return {
    currentBranch: current && current !== "HEAD" ? current : null,
    upstreamBranch: upstream && slash !== -1 ? upstream.slice(slash + 1) : upstream,
  };
}

function run(tool, args) {
  const realGit = process.env.FACILITY_REAL_GIT ?? "/usr/libexec/facility/git";
  const push = tool === "git" ? parseGitPush(args) : null;
  let decision = { allow: true };
  if (tool === "gh") decision = decideGh(args);
  else if (tool !== "git") decision = deny("Unknown command.");
  else if (push?.force || push?.all || push?.mirror) {
    decision = decideGit(args, {
      currentBranch: null,
      upstreamBranch: null,
      protectedBranches: [],
    });
  } else if (push) {
    const remote = isRemoteUrl(push.remote ?? "")
      ? push.remote
      : gitText(realGit, push.prefix, ["remote", "get-url", push.remote ?? "origin"]);
    decision = decideGit(args, {
      ...branchContext(realGit, push),
      protectedBranches: protectedBranches(process.env, remote ? githubRepository(remote) : null),
    });
  }
  if (!decision.allow) {
    process.stderr.write(`facility: ${decision.reason}\n`);
    process.exit(1);
  }
  const real = tool === "git" ? realGit : (process.env.FACILITY_REAL_GH ?? "/usr/libexec/facility/gh");
  const env = tool === "git" ? realGitEnv() : { ...process.env };
  let ghConfig = null;
  if (tool === "gh") {
    ghConfig = mkdtempSync(join(tmpdir(), "facility-gh-"));
    env.GH_CONFIG_DIR = ghConfig;
  }
  const child = spawnReal(real, args, { stdio: "inherit", env });
  if (ghConfig) rmSync(ghConfig, { recursive: true, force: true });
  process.exit(child.status ?? 1);
}

if (process.argv[1]?.endsWith("facility-command-guard.mjs")) {
  run(process.argv[2], process.argv.slice(3));
}
