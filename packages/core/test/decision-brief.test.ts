import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DecisionBriefSchema, readDecisionBrief } from "../src/decision-brief.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/decision-brief.json", import.meta.url), "utf8"),
);
const block = (value: unknown = fixture) =>
  `\`\`\`facility-decision\n${JSON.stringify(value)}\n\`\`\``;

describe("author decision briefs", () => {
  it("accepts the published author example through the same parser used by plan reads", () => {
    const reference = readFileSync(
      new URL("../../../apps/docs/docs/reference/decision-brief.md", import.meta.url),
      "utf8",
    );
    const result = readDecisionBrief(reference);
    expect(result.status).toBe("available");
    if (result.status !== "available") throw Error("Invalid documentation example");
    expect(result.brief.recommendation?.optionId).toBe("resume");
    expect(result.brief.evidence[0]?.url).toBe("https://example.com/reviews/scope-r3");
  });
  it("reads the same bounded author statements without rewriting their original plan", () => {
    const markdown = `# Complete plan\n\n${block()}\n\n## Verification\nRun the acceptance suite.\n`;
    expect(readDecisionBrief(markdown)).toEqual({ status: "available", brief: fixture });
    expect(readDecisionBrief(markdown.replaceAll("\n", "\r\n"))).toEqual(
      readDecisionBrief(markdown),
    );
    expect(markdown).toContain("Run the acceptance suite.");
    expect(readDecisionBrief("# Existing plan\nNo structured brief.")).toEqual({
      status: "absent",
    });
  });
  it("ignores quoted and nested examples and accepts matching tilde or longer fences", () => {
    expect(readDecisionBrief(`\`\`\`\`markdown\n${block()}\n\`\`\`\``)).toEqual({
      status: "absent",
    });
    expect(
      readDecisionBrief(
        block()
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n"),
      ),
    ).toEqual({ status: "absent" });
    expect(readDecisionBrief(block().replaceAll("```", "~~~~"))).toEqual({
      status: "available",
      brief: fixture,
    });
    expect(
      readDecisionBrief(`\`\`\`\`facility-decision\n${JSON.stringify(fixture)}\n\`\`\`\`\``).status,
    ).toBe("available");
  });
  it("rejects ambiguous, unfinished, malformed, oversized and unsupported blocks", () => {
    expect(readDecisionBrief(`${block()}\n${block()}`)).toEqual({
      status: "invalid",
      reason: "duplicate",
    });
    expect(readDecisionBrief(block().slice(0, -3))).toEqual({
      status: "invalid",
      reason: "malformed",
    });
    expect(readDecisionBrief("```facility-decision\n{no json}\n```")).toEqual({
      status: "invalid",
      reason: "malformed",
    });
    expect(readDecisionBrief(block({ ...fixture, schemaVersion: 2 }))).toEqual({
      status: "invalid",
      reason: "unsupported_version",
    });
    expect(readDecisionBrief(block("x".repeat(16_001)))).toEqual({
      status: "invalid",
      reason: "too_large",
    });
    expect(readDecisionBrief("x".repeat(100_001))).toEqual({
      status: "invalid",
      reason: "too_large",
    });
  });
  it("requires coherent option and evidence references and rejects invented authority fields", () => {
    for (const change of [
      { approved: true },
      { urgency: "critical" },
      { options: [fixture.options[0], fixture.options[0]] },
      { evidence: [fixture.evidence[0], fixture.evidence[0]] },
      { recommendation: { ...fixture.recommendation, optionId: "unknown" } },
      { summary: { text: "Unsupported statement", evidenceIds: ["unknown"] } },
      { summary: { text: "Duplicated source", evidenceIds: ["scope", "scope"] } },
      { options: [] },
      { summary: { text: "x".repeat(601), evidenceIds: [] } },
    ])
      expect(readDecisionBrief(block({ ...fixture, ...change }))).toEqual({
        status: "invalid",
        reason: "invalid_fields",
      });
    expect(
      DecisionBriefSchema.parse({ ...fixture, recommendation: null }).recommendation,
    ).toBeNull();
  });
  it("does not accept executable, relative, credential-bearing or malformed source URLs", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,hello",
      "//example.com",
      "/settings",
      "https://user:secret@example.com",
      "https:\\example.com",
      "https://example.com/\nattack",
      "not a URL",
    ]) {
      expect(
        readDecisionBrief(block({ ...fixture, evidence: [{ ...fixture.evidence[0], url }] })),
      ).toEqual({ status: "invalid", reason: "invalid_fields" });
    }
  });
});
