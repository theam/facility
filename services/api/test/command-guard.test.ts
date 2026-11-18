import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const guardUrl = new URL("../../../runner/facility-command-guard.mjs", import.meta.url);
const guardPath = fileURLToPath(guardUrl);
const { decideGit, decideGh, githubRepository, protectedBranches } = (await import(
  guardUrl.href
)) as {
  decideGit: (
    args: string[],
    context: {
      currentBranch: string | null;
      upstreamBranch: string | null;
      protectedBranches: string[];
    },
  ) => { allow: boolean; reason?: string };
  decideGh: (args: string[]) => { allow: boolean; reason?: string };
  githubRepository: (remote: string) => string | null;
  protectedBranches: (
    env: Record<string, string | undefined>,
    repository: string | null,
  ) => string[];
};

const story = {
  currentBranch: "facility/story",
  upstreamBranch: "facility/story",
  protectedBranches: ["main"],
};

function git(args: string[], context = story) {
  return decideGit(args, context);
}

describe("workspace command guard", () => {
  it("allows ordinary git commands and a push to the story branch", () => {
    expect(git(["status"])).toEqual({ allow: true });
    expect(git(["rev-parse", "HEAD"])).toEqual({ allow: true });
    expect(git(["push", "origin", "facility/story"])).toEqual({ allow: true });
    expect(git(["push", "origin", "HEAD"])).toEqual({ allow: true });
    expect(git(["-C", "/workspace/repos/acme/app", "push", "origin", "facility/story"])).toEqual({
      allow: true,
    });
    expect(git(["push", "origin", "refs/tags/v1"])).toEqual({ allow: true });
  });

  it("denies force-push, every-branch push, and the default branch", () => {
    expect(git(["push", "--force", "origin", "facility/story"]).reason).toContain("Force-push");
    expect(git(["push", "-f", "origin", "facility/story"]).reason).toContain("Force-push");
    expect(git(["push", "--force-with-lease", "origin", "facility/story"]).reason).toContain(
      "Force-push",
    );
    expect(git(["push", "origin", "+facility/story"]).reason).toContain("Force-push");
    expect(git(["push", "--all"]).reason).toContain("every branch");
    expect(git(["push", "--mirror", "origin"]).reason).toContain("every branch");
    expect(git(["push", "origin", "main"]).reason).toContain("default branch main");
    expect(git(["push", "origin", "HEAD:main"]).reason).toContain("default branch main");
    expect(git(["push", "origin", "refs/heads/main"]).reason).toContain("default branch main");
    expect(git(["push", "origin", ":main"]).reason).toContain("default branch main");
    expect(git(["push", "--delete", "origin", "main"]).reason).toContain("default branch main");
    expect(git(["push", "--repo", "origin", "main"]).reason).toContain("default branch main");
    expect(git(["push"], { ...story, currentBranch: null, upstreamBranch: null }).reason).toContain(
      "unknown",
    );
  });

  it("denies pull request merges and allows a comment that merely says merge", () => {
    expect(decideGh(["pr", "merge", "1"]).reason).toContain("Merging a pull request");
    expect(decideGh(["pr", "merge", "--auto", "1"]).reason).toContain("Merging a pull request");
    expect(decideGh(["pr", "merge", "--squash", "1"]).reason).toContain("Merging a pull request");
    expect(decideGh(["api", "-X", "PUT", "repos/acme/app/pulls/1/merge"]).reason).toContain(
      "merge endpoint",
    );
    expect(decideGh(["api", "repos/acme/app/merges"]).reason).toContain("merge endpoint");
    expect(
      decideGh(["api", "https://api.github.com/repos/acme/app/pulls/1/merge"]).reason,
    ).toContain("merge endpoint");
    expect(
      decideGh([
        "api",
        "graphql",
        "-f",
        "query=mutation { mergePullRequest(input: {}) { clientMutationId } }",
      ]).reason,
    ).toContain("merge endpoint");
    expect(decideGh(["pr", "comment", "1", "--body", "merge"])).toEqual({ allow: true });
    expect(decideGh(["pr", "view", "1"])).toEqual({ allow: true });
    expect(decideGh(["api", "repos/acme/app/pulls/1/comments"])).toEqual({ allow: true });
  });

  it("reads a graphql input file and denies a merge mutation stored there", () => {
    const dir = mkdtempSync(join(tmpdir(), "facility-guard-"));
    const merge = join(dir, "merge.graphql");
    const read = join(dir, "read.graphql");
    writeFileSync(merge, "mutation { mergePullRequest(input: {}) { clientMutationId } }");
    writeFileSync(read, "query { viewer { login } }");
    expect(decideGh(["api", "graphql", "--input", merge]).reason).toContain("merge endpoint");
    expect(decideGh(["api", "graphql", "--input", read])).toEqual({ allow: true });
    expect(decideGh(["api", "graphql", "--input", join(dir, "missing.graphql")]).reason).toContain(
      "merge endpoint",
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses the repository default branch and falls back to main and master", () => {
    expect(githubRepository("https://github.com/Acme/App.git")).toBe("acme/app");
    expect(githubRepository("https://x-access-token:secret@github.com/Acme/App.git")).toBe(
      "acme/app",
    );
    expect(githubRepository("git@github.com:Acme/App.git")).toBe("acme/app");
    expect(githubRepository("origin")).toBeNull();
    expect(protectedBranches({}, null)).toEqual(["main", "master"]);
    expect(protectedBranches({ FACILITY_DEFAULT_BRANCHES: "{" }, "acme/app")).toEqual([
      "main",
      "master",
    ]);
    expect(
      protectedBranches(
        { FACILITY_DEFAULT_BRANCHES: JSON.stringify({ "acme/app": "trunk" }) },
        "acme/app",
      ),
    ).toEqual(["trunk"]);
    expect(
      git(["push", "origin", "main"], {
        ...story,
        protectedBranches: ["trunk"],
      }),
    ).toEqual({ allow: true });
    expect(
      git(["push", "origin", "trunk"], {
        ...story,
        protectedBranches: ["trunk"],
      }).reason,
    ).toContain("default branch trunk");
  });

  it("does not execute a denied command and does execute an allowed push", () => {
    const dir = mkdtempSync(join(tmpdir(), "facility-guard-exec-"));
    const log = join(dir, "log");
    const real = installFake(dir, "git");
    const run = (args: string[], env: Record<string, string> = {}) =>
      spawnSync(process.execPath, [guardPath, "git", ...args], {
        encoding: "utf8",
        env: { ...process.env, FACILITY_REAL_GIT: real, GUARD_LOG: log, ...env },
      });

    const forced = run(["push", "--force", "origin", "facility/story"]);
    expect(forced.status).not.toBe(0);
    expect(forced.stderr).toContain("facility: Force-push");
    expect(invocations(log).some((entry) => entry.args[0] === "push")).toBe(false);

    const storyPush = run(["push", "origin", "facility/story"]);
    expect(storyPush.status).toBe(0);
    const bare = run(["push"]);
    expect(bare.status).toBe(0);
    expect(invocations(log).some((entry) => entry.args[0] === "push")).toBe(true);

    const branches = JSON.stringify({ "acme/app": "trunk" });
    const mainPush = run(["push", "origin", "main"], { FACILITY_DEFAULT_BRANCHES: branches });
    expect(mainPush.status).toBe(0);
    const trunkPush = run(["push", "origin", "trunk"], { FACILITY_DEFAULT_BRANCHES: branches });
    expect(trunkPush.status).not.toBe(0);
    expect(trunkPush.stderr).toContain("default branch trunk");
    expect(invocations(log).filter((entry) => entry.args[0] === "push")).toHaveLength(3);

    rmSync(dir, { recursive: true, force: true });
  });

  it("runs allowed gh with a fresh config directory and does not run a merge", () => {
    const dir = mkdtempSync(join(tmpdir(), "facility-guard-gh-"));
    const log = join(dir, "log");
    const real = installFake(dir, "gh");
    const run = (args: string[]) =>
      spawnSync(process.execPath, [guardPath, "gh", ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          FACILITY_REAL_GH: real,
          GUARD_LOG: log,
          GH_CONFIG_DIR: join(dir, "caller-config"),
        },
      });

    const merge = run(["pr", "merge", "1"]);
    expect(merge.status).not.toBe(0);
    expect(merge.stderr).toContain("facility: Merging a pull request");
    expect(invocations(log)).toEqual([]);

    const view = run(["pr", "view", "1"]);
    expect(view.status).toBe(0);
    const [call] = invocations(log);
    expect(call?.args).toEqual(["pr", "view", "1"]);
    expect(call?.config).toContain("facility-gh-");
    expect(call?.config).not.toBe(join(dir, "caller-config"));

    rmSync(dir, { recursive: true, force: true });
  });
});

function invocations(log: string) {
  try {
    return readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { args: string[]; config: string | null });
  } catch {
    return [];
  }
}

function installFake(dir: string, name: string) {
  const script = join(dir, `${name}.mjs`);
  writeFileSync(
    script,
    [
      "import { appendFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "appendFileSync(process.env.GUARD_LOG, JSON.stringify({ args, config: process.env.GH_CONFIG_DIR ?? null }) + '\\n');",
      "if (args[0] === 'remote' && args[1] === 'get-url') process.stdout.write('https://github.com/acme/app.git\\n');",
      "else if (args.includes('HEAD')) process.stdout.write('facility/story\\n');",
      "else if (args.includes('@{upstream}')) process.stdout.write('origin/facility/story\\n');",
    ].join("\n"),
  );
  if (process.platform === "win32") {
    const command = join(dir, `${name}.cmd`);
    writeFileSync(command, `@echo off\r\nnode "%~dp0${name}.mjs" %*\r\n`);
    return command;
  }
  const command = join(dir, name);
  writeFileSync(command, `#!/bin/sh\nexec node "$(dirname "$0")/${name}.mjs" "$@"\n`);
  chmodSync(command, 0o755);
  return command;
}
