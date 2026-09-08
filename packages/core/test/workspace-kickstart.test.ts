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

  it("quotes untrusted model ids and commands so they cannot inject YAML", () => {
    const hostileModel = "gpt-5.6-sol\nenabled: false";
    const hostileStart = 'docker compose up -d && echo "$(id)" && echo "db: ready"';
    const result = renderWorkspaceKickstart({
      repository: "acme/payments",
      setup: "pnpm install --frozen-lockfile && echo 'setup: done'",
      start: hostileStart,
      ready: "curl --fail 'http://localhost:3000/health'",
      models: {
        build: "claude-fable-5 # not-a-comment",
        review: 'foo"bar # pwned',
        plan: "$(id)",
        codexBuild: hostileModel,
        codexPlan: "|",
      },
    });

    const manifest = fileContent(result, ".facility.yml");
    expect(manifest).toContain(
      `setup: ${JSON.stringify("pnpm install --frozen-lockfile && echo 'setup: done'")}`,
    );
    expect(manifest).toContain(`start: ${JSON.stringify(hostileStart)}`);
    expect(manifest).toContain(
      `ready: ${JSON.stringify("curl --fail 'http://localhost:3000/health'")}`,
    );
    expect(manifest).not.toMatch(/^ {2}start: docker compose/m);

    const builder = fileContent(result, ".agents/builder.md");
    expect(builder).toContain(`model: ${JSON.stringify(hostileModel)}`);
    expect(builder).toMatch(/^enabled: true$/m);
    expect(builder).not.toMatch(/^enabled: false$/m);

    expect(fileContent(result, ".agents/architect.md")).toContain(
      `model: ${JSON.stringify("$(id)")}`,
    );
    expect(fileContent(result, ".agents/security-audit.md")).toContain(
      `model: ${JSON.stringify("$(id)")}`,
    );
    expect(fileContent(result, ".agents/pr-reviewer.md")).toContain(
      `model: ${JSON.stringify('foo"bar # pwned')}`,
    );
    expect(fileContent(result, ".agents/architect.md")).not.toContain("model: $(id)");

    const doctor = fileContent(result, ".agents/ci-doctor.md");
    expect(doctor).toContain(`model: ${JSON.stringify("|")}`);
    expect(doctor).toMatch(/^options:$/m);
    expect(doctor).toMatch(/^ {2}reasoning_effort: high$/m);
  });

  it("keeps ordinary model ids as quoted YAML scalars", () => {
    const result = renderWorkspaceKickstart({
      repository: "acme/payments",
      start: "pnpm dev",
      models: { codexBuild: "gpt-5.6-sol", plan: "claude-opus-4-8-20260101" },
    });
    expect(fileContent(result, ".agents/builder.md")).toContain(
      `model: ${JSON.stringify("gpt-5.6-sol")}`,
    );
    expect(fileContent(result, ".agents/architect.md")).toContain(
      `model: ${JSON.stringify("claude-opus-4-8-20260101")}`,
    );
  });
});

function fileContent(result: { files: Array<{ path: string; content: string }> }, path: string) {
  const file = result.files.find((candidate) => candidate.path === path);
  if (!file) throw new Error(`missing ${path}`);
  return file.content;
}
