import { describe, expect, it } from "vitest";
import { renderWorkspaceKickstart } from "../src/render-workspace-kickstart.js";

describe("Facility 0.12 workspace kickstart", () => {
  it("renders only the environment contract and canonical agent catalog", () => {
    const result = renderWorkspaceKickstart({
      repository: "acme/payments",
      setup: "pnpm install --frozen-lockfile",
      start: "docker compose up -d",
      ready: "curl --fail http://localhost:3000/health",
      servicePort: 3000,
      models: {
        build: "claude-fable-5",
        review: "claude-sonnet-5",
        plan: "claude-opus-4-8",
        codexBuild: "gpt-5.6-sol",
        codexPlan: "gpt-5.6-sol",
      },
    });

    expect(result.files.map((file) => file.path).sort()).toEqual([
      ".agents/address-review.md",
      ".agents/architect.md",
      ".agents/builder.md",
      ".agents/ci-doctor.md",
      ".agents/pr-reviewer.md",
      ".agents/security-audit.md",
      ".facility.yml",
    ]);
    expect(result.manifest.templateSet).toBe("0.12");
    expect(result.files.find((file) => file.path === ".facility.yml")?.content).toContain(
      'start: "docker compose up -d"',
    );
    expect(result.files.map((file) => file.path).join(" ")).not.toMatch(
      /receipt|watchtower|budget|workflow|guard|standard/i,
    );
  });

  it("never overwrites an existing project-owned contract or agent", () => {
    const result = renderWorkspaceKickstart(
      { repository: "acme/payments", start: "pnpm dev" },
      {
        ".facility.yml": "owned by the project\n",
        ".agents/builder.md": "owned by the project\n",
      },
    );

    expect(result.skipped).toEqual([".facility.yml", ".agents/builder.md"]);
    expect(result.files.map((file) => file.path)).not.toContain(".facility.yml");
    expect(result.files.map((file) => file.path)).not.toContain(".agents/builder.md");
  });

  it("rejects an unsafe repository identity, missing start command, and invalid port", () => {
    expect(() =>
      renderWorkspaceKickstart({ repository: "https://example.com/repo", start: "pnpm dev" }),
    ).toThrow(/owner\/name/);
    expect(() => renderWorkspaceKickstart({ repository: "acme/app", start: " " })).toThrow(
      /start command is required/,
    );
    expect(() =>
      renderWorkspaceKickstart({ repository: "acme/app", start: "pnpm dev", servicePort: 0 }),
    ).toThrow(/between 1 and 65535/);
  });
});
