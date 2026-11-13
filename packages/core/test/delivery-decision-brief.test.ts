import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readDeliveryDecisionBrief } from "../src/delivery-decision-brief.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/delivery-decision-brief.json", import.meta.url), "utf8"),
);
const block = (value: unknown = fixture) =>
  `\`\`\`facility-delivery\n${JSON.stringify(value)}\n\`\`\``;
describe("delivery author briefs", () => {
  it("parses the published delivery example through the same output contract", () => {
    const doc = readFileSync(
      new URL("../../../apps/docs/docs/reference/decision-brief.md", import.meta.url),
      "utf8",
    );
    expect(readDeliveryDecisionBrief(doc)).toEqual({ status: "available", value: fixture });
  });
  it("keeps all required and optional references and ignores quoted or nested examples", () => {
    expect(readDeliveryDecisionBrief(block())).toEqual({ status: "available", value: fixture });
    expect(readDeliveryDecisionBrief(block().replaceAll("```", "~~~~"))).toEqual({
      status: "available",
      value: fixture,
    });
    expect(readDeliveryDecisionBrief(`\`\`\`\`markdown\n${block()}\n\`\`\`\``)).toEqual({
      status: "absent",
    });
    expect(
      readDeliveryDecisionBrief(
        block()
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n"),
      ),
    ).toEqual({ status: "absent" });
    expect(readDeliveryDecisionBrief("Ordinary response ".repeat(10000))).toEqual({
      status: "absent",
    });
  });
  it("rejects ambiguous, invalid, unsupported and oversized claims without assigning authority", () => {
    for (const value of [
      { ...fixture, approved: true },
      { ...fixture, subject: { ...fixture.subject, pullRequests: [] } },
      {
        ...fixture,
        subject: {
          ...fixture.subject,
          pullRequests: [fixture.subject.pullRequests[0], fixture.subject.pullRequests[0]],
        },
      },
      {
        ...fixture,
        subject: {
          ...fixture.subject,
          pullRequests: [{ ...fixture.subject.pullRequests[0], required: false }],
        },
      },
      { ...fixture, subject: { ...fixture.subject, candidateRevision: "invented" } },
      { ...fixture, brief: { ...fixture.brief, approved: true } },
    ])
      expect(readDeliveryDecisionBrief(block(value))).toEqual({
        status: "invalid",
        reason: "invalid_fields",
      });
    expect(readDeliveryDecisionBrief(block({ ...fixture, schemaVersion: 2 }))).toEqual({
      status: "invalid",
      reason: "unsupported_version",
    });
    expect(readDeliveryDecisionBrief(`${block()}\n${block()}`)).toEqual({
      status: "invalid",
      reason: "duplicate",
    });
    expect(readDeliveryDecisionBrief(block().slice(0, -3))).toEqual({
      status: "invalid",
      reason: "malformed",
    });
    expect(readDeliveryDecisionBrief(block("x".repeat(32001)))).toEqual({
      status: "invalid",
      reason: "too_large",
    });
    expect(readDeliveryDecisionBrief(`${"x".repeat(100001)}\n${block()}`)).toEqual({
      status: "invalid",
      reason: "too_large",
    });
  });
});
