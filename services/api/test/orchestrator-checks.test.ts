import { describe, expect, it } from "vitest";
import {
  platformDeliveryFailure,
  renderRunContract,
  resolveCheckCmds,
  resolvePackageInstallCmd,
  resolveProvisionCmd,
  resolveRepoEngineConfig,
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

  it("falls back to the harness floor when nothing run-safe is declared", () => {
    expect(runSafePermissions([])).toEqual(["kb:read", "kb:write", "tasks:read", "tasks:write"]);
    expect(runSafePermissions(["members:write"])).toEqual([
      "kb:read",
      "kb:write",
      "tasks:read",
      "tasks:write",
    ]);
  });
});
