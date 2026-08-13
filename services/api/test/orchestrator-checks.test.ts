import { describe, expect, it } from "vitest";
import { harnessFragmentForBundle } from "../src/harness.js";
import {
  boundedResumeFallbackScope,
  platformDeliveryFailure,
  renderRunContract,
  resolveCheckCmds,
  resolvePackageInstallCmd,
  resolveProvisionCmd,
  resolveProvisioningCommands,
  resolveRepoEngineConfig,
  resumeFallbackScopeValue,
  runSafePermissions,
} from "../src/sandbox/orchestrator.js";

describe("platform delivery boundaries", () => {
  it("fails non-delivery agents that alter a repository", () => {
    expect(platformDeliveryFailure({ mode: "learning", gh: {} }, { changed: true })).toBe(
      "repository_changes_not_allowed",
    );
    expect(platformDeliveryFailure({ mode: "custom", gh: {} }, { changed: false })).toBeNull();
  });
});

describe("resolveCheckCmds — acceptance-gate source of truth", () => {
  it("uses the project's configured checks when the sandbox profile has none", () => {
    expect(resolveCheckCmds({ setup: {} }, {}, { check_cmds: ["pnpm test", "pnpm lint"] })).toEqual(
      ["pnpm test", "pnpm lint"],
    );
  });

  it("lets an explicit sandbox-profile override win over project checks", () => {
    expect(
      resolveCheckCmds(
        { setup: { check_cmds: ["make ci"] } },
        { checkCmds: ["pnpm repo-test"] },
        { check_cmds: ["pnpm project-test"] },
      ),
    ).toEqual(["make ci"]);
  });

  it("is empty when neither profile nor project configures checks", () => {
    expect(resolveCheckCmds({ setup: {} }, {}, { check_cmds: [] })).toEqual([]);
    expect(resolveCheckCmds({ setup: {} }, undefined, undefined)).toEqual([]);
    expect(resolveCheckCmds({ setup: null }, null, null)).toEqual([]);
  });

  it("ignores non-string entries", () => {
    expect(resolveCheckCmds({ setup: {} }, {}, { check_cmds: ["ok", 3, null, "fine"] })).toEqual([
      "ok",
      "fine",
    ]);
  });

  it("keeps checks repository-specific when a project has multiple repos", () => {
    expect(
      resolveCheckCmds(
        { setup: {} },
        { checkCmds: ["pnpm --filter repo-a test"] },
        { check_cmds: ["legacy project check"] },
      ),
    ).toEqual(["pnpm --filter repo-a test"]);
    expect(resolveCheckCmds({ setup: {} }, { checkCmds: [] }, { check_cmds: ["legacy"] })).toEqual(
      [],
    );
  });
});

describe("repository-specific model overrides", () => {
  it("applies only the selected repo's engine model", () => {
    expect(
      resolveRepoEngineConfig(
        "architect",
        { model: "default-model", effort: "high" },
        { models: { plan: "repo-a-plan" } },
      ),
    ).toEqual({ model: "repo-a-plan", effort: "high" });
    expect(
      resolveRepoEngineConfig(
        "codex-builder",
        { primary: "default-codex", reasoning_effort: "high" },
        { models: { codexBuild: "repo-a-codex" } },
      ),
    ).toEqual({ primary: "repo-a-codex", reasoning_effort: "high" });
  });

  it("does not let another repo's absent override mutate the project default", () => {
    expect(resolveRepoEngineConfig("builder", { model: "default" }, { models: {} })).toEqual({
      model: "default",
    });
  });

  it("selects repository overrides by configured engine, not legacy agent name", () => {
    const models = {
      plan: "claude-plan",
      build: "claude-build",
      review: "claude-review",
      codexPlan: "codex-plan",
      codexBuild: "codex-build",
    };

    expect(
      resolveRepoEngineConfig(
        "architect",
        { model: "stale-claude", primary: "default-codex", reasoning_effort: "high" },
        { models },
        "codex",
      ),
    ).toEqual({ primary: "codex-plan", reasoning_effort: "high" });
    expect(
      resolveRepoEngineConfig("builder", { primary: "default-codex" }, { models }, "codex"),
    ).toEqual({ primary: "codex-build" });
    expect(
      resolveRepoEngineConfig("architect", { primary: "stale-codex" }, { models }, "claude_code"),
    ).toEqual({ model: "claude-plan" });
    // There is no configured codexReview override, so a Codex review keeps its
    // own compatible project default rather than receiving the Claude alias.
    expect(
      resolveRepoEngineConfig("review", { primary: "default-codex" }, { models }, "codex"),
    ).toEqual({ primary: "default-codex" });
  });
});

describe("platform run repository setup", () => {
  it("keeps dependency installation separate from repository provisioning", () => {
    expect(
      resolvePackageInstallCmd(
        { setup: {} },
        { packageInstallCmd: "pnpm install --frozen-lockfile" },
      ),
    ).toBe("pnpm install --frozen-lockfile");
    expect(
      resolvePackageInstallCmd(
        { setup: { package_install_cmd: "npm ci" } },
        { packageInstallCmd: "pnpm install" },
      ),
    ).toBe("npm ci");
  });

  it("uses the kickstart provision command when the profile has no override", () => {
    expect(resolveProvisionCmd({ setup: {} }, { provisionCmd: "pnpm install" })).toBe(
      "pnpm install",
    );
  });

  it("lets an explicit sandbox-profile provision command win", () => {
    expect(
      resolveProvisionCmd(
        { setup: { provision_cmd: "make bootstrap" } },
        { provisionCmd: "pnpm install" },
      ),
    ).toBe("make bootstrap");
  });

  it("gates repository setup with an explicit provisioning depth", () => {
    const answers = {
      packageInstallCmd: "pnpm install --frozen-lockfile",
      provisionCmd: "pnpm run local:setup:ui",
    };
    expect(resolveProvisioningCommands({ setup: {} }, answers)).toEqual({
      packageInstallCmd: "pnpm install --frozen-lockfile",
      provisionCmd: "pnpm run local:setup:ui",
    });
    expect(resolveProvisioningCommands({ setup: { provisioning: "full" } }, answers)).toEqual({
      packageInstallCmd: "pnpm install --frozen-lockfile",
      provisionCmd: "pnpm run local:setup:ui",
    });
    expect(resolveProvisioningCommands({ setup: { provisioning: "deps_only" } }, answers)).toEqual({
      packageInstallCmd: "pnpm install --frozen-lockfile",
      provisionCmd: null,
    });
    expect(resolveProvisioningCommands({ setup: { provisioning: "deps_only" } }, {})).toEqual({
      packageInstallCmd: null,
      provisionCmd: null,
    });
    expect(resolveProvisioningCommands({ setup: { provisioning: "none" } }, answers)).toEqual({
      packageInstallCmd: null,
      provisionCmd: null,
    });
    // Invalid persisted state stays on the legacy full lifecycle.
    expect(resolveProvisioningCommands({ setup: { provisioning: "skip" } }, answers)).toEqual({
      packageInstallCmd: "pnpm install --frozen-lockfile",
      provisionCmd: "pnpm run local:setup:ui",
    });
  });

  it("renders repository setup and gates into platform contracts", () => {
    expect(
      renderRunContract("Provision: {{PROVISION_CMD}}\nChecks: {{CHECKS_INLINE}}", "pnpm install", [
        "pnpm test",
        "pnpm lint",
      ]),
    ).toBe("Provision: pnpm install\nChecks: pnpm test && pnpm lint");
  });
});

describe("runSafePermissions — run-key permission ceiling", () => {
  it("keeps an agent's run-safe scopes so its declared permissions take effect", () => {
    expect(runSafePermissions(["kb:write", "tasks:write", "hitl:write"])).toEqual([
      "hitl:write",
      "kb:write",
      "tasks:write",
    ]);
  });

  it("strips tenant-admin / destructive scopes no matter what the agent declares", () => {
    const clamped = runSafePermissions([
      "kb:write",
      "members:write",
      "roles:write",
      "keys:issue",
      "providers:write",
      "budgets:write",
      "org:write",
      "*",
    ]);
    expect(clamped).toEqual(["kb:write"]);
  });

  it("never grants hitl:decide to a run (a run can't approve its own gate)", () => {
    expect(runSafePermissions(["hitl:decide", "hitl:write"])).toEqual(["hitl:write"]);
  });

  it("does not grant undeclared KB access to a non-harness agent", () => {
    expect(runSafePermissions([])).toEqual([]);
    expect(runSafePermissions(["members:write"])).toEqual([]);
  });

  it("keeps the legacy floor only for an explicitly harness-enabled agent", () => {
    expect(runSafePermissions([], true)).toEqual([
      "kb:read",
      "kb:write",
      "tasks:read",
      "tasks:write",
    ]);
  });
});

describe("harness and resume bundle boundaries", () => {
  const space = {
    config: {},
    charterMd: "# Charter\n",
    activeMd: "## Objective\n",
  } as never;

  it("injects mandatory KB files only for an agent with a harness item", () => {
    expect(
      harnessFragmentForBundle({
        space,
        harnessItemId: null,
        runId: "run_without_harness",
        mode: "builder",
      }),
    ).toBeUndefined();
    expect(
      harnessFragmentForBundle({
        space,
        harnessItemId: "item_product_chain",
        runId: "run_with_harness",
        mode: "project-owner",
      })?.files,
    ).toHaveProperty("harness/SESSION.md");
  });

  it("bounds degraded-resume context without blocking the resume", () => {
    expect(
      boundedResumeFallbackScope({ approvedPlan: "Implement issue 557", issue: { number: 557 } }),
    ).toEqual({ approvedPlan: "Implement issue 557", issue: { number: 557 } });
    expect(boundedResumeFallbackScope({ approvedPlan: "x".repeat(33 * 1024) })).toBeUndefined();
  });

  it("preserves the original governed scope across nested resumes", () => {
    const original = { approvedPlan: "Implement issue 557", issue: { number: 557 } };
    expect(
      resumeFallbackScopeValue(
        { type: "resume", message: "Try for a third time" },
        {
          bundle: {
            resume: {
              sessionId: "sess_1",
              sessionStateFrom: "run_original",
              prompt: "Try again",
              fallbackScope: original,
            },
          },
        },
      ),
    ).toEqual(original);
  });
});
