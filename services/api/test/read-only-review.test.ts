import type { FacilityDb } from "@facility/db";
import { describe, expect, it } from "vitest";
import { GITHUB_READ_ONLY_PERMISSIONS, grantedReadPermissions } from "../src/github/client.js";
import { reviewerEnvironment } from "../src/turns/dispatcher.js";
import { TurnGitEvidenceService } from "../src/turns/git-evidence.js";
import type { WorkspaceLocator, WorkspaceRuntime } from "../src/workspaces/runtime.js";

describe("read-only Reviewer turn", () => {
  const environment = {
    ANTHROPIC_API_KEY: "engine",
    OPENAI_API_KEY: "application",
    VERCEL_TOKEN: "deploy",
    DATABASE_URL: "service",
    NODE_ENV: "test",
    GH_TOKEN: "read-only-token",
  };
  const secrets = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "VERCEL_TOKEN", "DATABASE_URL"];
  it("keeps only its own engine's credentials and removes the project's other secrets", () => {
    expect(reviewerEnvironment(environment, secrets, "claude_code")).toEqual({
      ANTHROPIC_API_KEY: "engine",
      NODE_ENV: "test",
      GH_TOKEN: "read-only-token",
    });
    expect(reviewerEnvironment(environment, secrets, "codex")).toEqual({
      OPENAI_API_KEY: "application",
      NODE_ENV: "test",
      GH_TOKEN: "read-only-token",
    });
  });

  it("asks GitHub only for read permissions the installation grants", () => {
    expect(Object.values(GITHUB_READ_ONLY_PERMISSIONS).every((level) => level === "read")).toBe(
      true,
    );
    // The documented App has no commit statuses permission; asking for it fails the token.
    expect(
      grantedReadPermissions(GITHUB_READ_ONLY_PERMISSIONS, {
        contents: "write",
        pull_requests: "write",
        issues: "write",
        checks: "write",
        actions: "write",
        metadata: "read",
        deployments: "write",
      }),
    ).toEqual({
      contents: "read",
      pull_requests: "read",
      issues: "read",
      checks: "read",
      actions: "read",
      metadata: "read",
    });
    expect(grantedReadPermissions(GITHUB_READ_ONLY_PERMISSIONS, { metadata: "read" })).toEqual({
      metadata: "read",
    });
  });

  it("restores a changed clean checkout and never discards earlier uncommitted work", async () => {
    const commands: Array<{ cwd?: string; args: string[] }> = [];
    // After the turn, both checkouts have a new commit and a new file.
    const runtime = {
      exec: async (_workspace: WorkspaceLocator, command: { cwd?: string; args?: string[] }) => {
        const args = command.args ?? [];
        commands.push({ cwd: command.cwd, args });
        const stdout =
          args[0] === "rev-parse" ? "f".repeat(40) : args[0] === "branch" ? "story" : "?? new.ts";
        return { exitCode: 0, stdout, stderr: "", durationMs: 1 };
      },
    } as unknown as WorkspaceRuntime;
    const changed = await new TurnGitEvidenceService({} as FacilityDb, runtime).restoreCheckouts(
      { id: "ws_review" } as WorkspaceLocator,
      {
        "repos/example/app": { head: "a".repeat(40), branch: "story", status: "" },
        "repos/example/consumer": { head: "b".repeat(40), branch: "story", status: " M wip.ts" },
      },
      {},
    );
    expect(changed).toEqual(["repos/example/app", "repos/example/consumer"]);
    expect(
      commands
        .filter(({ args }) => ["checkout", "reset", "clean"].includes(args[0] ?? ""))
        .map(({ cwd, args }) => [cwd, args[0]]),
    ).toEqual([
      ["repos/example/app", "checkout"],
      ["repos/example/app", "reset"],
      ["repos/example/app", "clean"],
    ]);
  });
});
