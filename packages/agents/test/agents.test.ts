import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentManifestError,
  loadAgentCatalog,
  parseAgentCatalog,
  parseAgentManifest,
  renderAgentManifest,
  triggerIdentity,
} from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function manifest(overrides = "") {
  return `---
name: builder
description: Implements a complete story and verifies the result.
engine: codex
model: gpt-5.6-sol
options:
  reasoning_effort: high
triggers:
  - type: manual
  - type: mcp
  - type: ui
  - type: github
    name: assigned-issue
    event: issues
    actions: [assigned]
${overrides}---

Implement the requested story in the persistent workspace.
`;
}

describe("agent manifests", () => {
  it("parses the engine, model, triggers, prompt, and stable content hash", () => {
    const first = parseAgentManifest(manifest(), "builder.md");
    const second = parseAgentManifest(manifest().replace(/\n/g, "\r\n"), "builder.md");

    expect(first).toMatchObject({
      name: "builder",
      engine: "codex",
      model: "gpt-5.6-sol",
      options: { reasoning_effort: "high" },
      prompt: "Implement the requested story in the persistent workspace.",
    });
    expect(first.hash).toBe(second.hash);
    expect(first.triggers.slice(0, 3).map(triggerIdentity)).toEqual(["manual", "mcp", "ui"]);
    const githubTrigger = first.triggers[3];
    expect(githubTrigger).toBeDefined();
    if (!githubTrigger) throw new Error("expected GitHub trigger");
    expect(triggerIdentity(githubTrigger)).toBe("github:assigned-issue");
  });

  it("rejects access controls because every agent has the same fixed capability", () => {
    expect(() =>
      parseAgentManifest(manifest("permissions: [contents:read]\n"), "builder.md"),
    ).toThrow(/Unrecognized key.*permissions/);
  });

  it("allows reasoning effort as the only execution option and renders canonical source", () => {
    const unsupported = manifest().replace(
      "  reasoning_effort: high",
      "  reasoning_effort: high\n  max_turns: 12",
    );
    expect(() => parseAgentManifest(unsupported, "builder.md")).toThrow(
      /Unrecognized key.*max_turns/,
    );

    const rendered = renderAgentManifest({
      name: "builder",
      description: "Builds and verifies stories.",
      engine: "codex",
      model: "gpt-5.6-sol",
      enabled: true,
      options: { reasoning_effort: "xhigh" },
      triggers: [{ type: "manual" }],
      prompt: "Implement the story and verify it.",
    });
    expect(rendered.source).toContain("reasoning_effort: xhigh");
    expect(rendered.manifest).toMatchObject({
      name: "builder",
      prompt: "Implement the story and verify it.",
    });
    expect(rendered.manifest.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects invalid schedules before dispatch", () => {
    const source = manifest().replace(
      "  - type: manual",
      "  - type: schedule\n    name: weekly\n    cron: never\n    timezone: UTC",
    );
    expect(() => parseAgentManifest(source, "builder.md")).toThrow(AgentManifestError);
  });

  it("rejects a filename that disagrees with the manifest identity", () => {
    expect(() => parseAgentManifest(manifest(), "architect.md")).toThrow(
      /filename must be builder\.md/,
    );
  });

  it("loads one deterministic catalog and rejects duplicate names", async () => {
    const root = await mkdtemp(join(tmpdir(), "facility-agents-"));
    roots.push(root);
    await writeFile(join(root, "builder.md"), manifest());
    await writeFile(
      join(root, "architect.md"),
      manifest()
        .replace("name: builder", "name: architect")
        .replace("model: gpt-5.6-sol", "model: claude-opus-4-8"),
    );

    await expect(loadAgentCatalog(root)).resolves.toMatchObject([
      { name: "architect" },
      { name: "builder" },
    ]);
    expect(() =>
      parseAgentCatalog([
        { file: "builder.md", source: manifest() },
        { file: "nested/builder.md", source: manifest() },
      ]),
    ).toThrow(/duplicate agent name builder/);
  });

  it("validates the complete kickstart crew through the canonical parser", async () => {
    const templateDirectory = join(
      fileURLToPath(new URL(".", import.meta.url)),
      "../../cli/templates/agents",
    );
    const templates = await readdir(templateDirectory);
    const sources = await Promise.all(
      templates
        .filter((file) => file.endsWith(".md"))
        .map(async (file) => ({
          file,
          source: (await readFile(join(templateDirectory, file), "utf8"))
            .replaceAll("{{PLAN_MODEL}}", "claude-opus-4-8")
            .replaceAll("{{REVIEW_MODEL}}", "claude-sonnet-4-6")
            .replaceAll("{{CODEX_BUILD_MODEL}}", "gpt-5.6-sol")
            .replaceAll("{{CODEX_PLAN_MODEL}}", "gpt-5.6-sol"),
        })),
    );
    const catalog = parseAgentCatalog(sources);

    expect(catalog.map((agent) => agent.name)).toEqual([
      "address-review",
      "architect",
      "builder",
      "ci-doctor",
      "pr-reviewer",
      "security-audit",
    ]);
    for (const agent of catalog) {
      expect(agent.prompt).toContain("<role>");
      expect(agent.prompt).toContain("<working_contract>");
      expect(agent.prompt).toContain("<access>");
      expect(agent.prompt).toContain("<output_contract>");
      expect(agent.prompt).toContain("<completion_criteria>");
      expect(agent.prompt).toContain("<safety>");
      expect(agent.prompt).toContain("same full workspace");
      expect(agent.prompt).toMatch(/untrusted data/i);
      expect(agent.prompt).not.toMatch(/receipt|HITL|budget ceiling|permission profile:/i);
    }
  });
});
