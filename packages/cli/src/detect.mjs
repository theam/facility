import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function git(cwd, args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

export function detect(dir) {
  const pkg = readJson(join(dir, "package.json"));
  const scripts = pkg?.scripts ?? {};
  const packageManager = existsSync(join(dir, "pnpm-lock.yaml"))
    ? "pnpm"
    : existsSync(join(dir, "yarn.lock"))
      ? "yarn"
      : existsSync(join(dir, "package-lock.json")) || pkg
        ? "npm"
        : "none";
  const runner =
    packageManager === "none" ? null : packageManager === "npm" ? "npm run" : `${packageManager} run`;
  const provision = runner && scripts.setup ? `${runner} setup` : "";
  const start =
    existsSync(join(dir, "compose.yml")) || existsSync(join(dir, "docker-compose.yml"))
      ? "docker compose up -d"
      : runner && scripts.dev
        ? `${runner} dev`
        : runner && scripts.start
          ? `${runner} start`
          : "";
  const remote = git(dir, ["remote", "get-url", "origin"]);
  const match = remote.match(/[/:]([^/:]+)\/([^/]+?)(\.git)?$/);

  return {
    isGitRepo: git(dir, ["rev-parse", "--is-inside-work-tree"]) === "true",
    packageManager,
    provision,
    start,
    org: match?.[1] ?? "",
    repository: match ? `${match[1]}/${match[2]}` : "",
  };
}
