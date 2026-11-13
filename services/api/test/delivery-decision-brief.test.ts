import { readFileSync } from "node:fs";
import type { DeliveryBriefSource } from "@facility/core";
import { describe, expect, it } from "vitest";
import {
  type BriefDeliveryObservation,
  projectDeliveryBrief,
} from "../src/stories/delivery-decision-brief.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../packages/core/test/fixtures/delivery-decision-brief.json", import.meta.url),
    "utf8",
  ),
);
const markdown = `\`\`\`facility-delivery\n${JSON.stringify(fixture)}\n\`\`\``;
const source: DeliveryBriefSource = {
  messageId: "message",
  seq: 1,
  createdAt: "2026-11-05T12:00:00Z",
  digest: "e".repeat(64),
  turn: { id: "turn", agentName: "reviewer", engine: "codex", model: "fixture" },
};
const observation = (): BriefDeliveryObservation => ({
  scopeRevision: 4,
  candidate: {
    revision: "a".repeat(64),
    state: "recorded",
    requiredCount: 1,
    mergedCount: 0,
    allRequiredMerged: false,
  },
  pullRequests: fixture.subject.pullRequests.map((pull: object) => ({
    ...pull,
    state: "open",
    stale: false,
  })),
});
describe("delivery brief validity", () => {
  it("binds the same author statements to the entire set independent of ordering", () => {
    const current = observation();
    current.pullRequests.reverse();
    expect(projectDeliveryBrief(markdown, source, current)).toEqual({
      status: "available",
      source,
      subject: fixture.subject,
      brief: fixture.brief,
    });
    for (const index of [0, 1]) {
      const changed = observation();
      changed.pullRequests = changed.pullRequests.map((pull, i) =>
        i === index ? { ...pull, headSha: "d".repeat(40) } : pull,
      );
      expect(projectDeliveryBrief(markdown, source, changed)).toMatchObject({
        status: "stale",
        reason: "heads_changed",
      });
    }
    const partial = observation();
    partial.pullRequests.pop();
    expect(projectDeliveryBrief(markdown, source, partial)).toMatchObject({
      status: "stale",
      reason: "heads_changed",
    });
    expect(
      projectDeliveryBrief(markdown, source, { ...observation(), scopeRevision: 5 }),
    ).toMatchObject({ status: "stale", reason: "scope_changed" });
    const candidate = observation();
    candidate.candidate.revision = "f".repeat(64);
    expect(projectDeliveryBrief(markdown, source, candidate)).toMatchObject({
      status: "stale",
      reason: "candidate_changed",
    });
  });
  it("keeps incomplete observations and an unverified author distinct from current evidence", () => {
    const stale = observation();
    stale.pullRequests = stale.pullRequests.map((pull, i) =>
      i === 1 ? { ...pull, stale: true } : pull,
    );
    expect(projectDeliveryBrief(markdown, source, stale)).toMatchObject({
      status: "unverifiable",
      reason: "observations_stale",
    });
    const absent = observation();
    absent.pullRequests = absent.pullRequests.map((pull, i) =>
      i === 1 ? { ...pull, headSha: null } : pull,
    );
    expect(projectDeliveryBrief(markdown, source, absent)).toMatchObject({
      status: "unverifiable",
      reason: "observations_unavailable",
    });
    expect(projectDeliveryBrief(markdown, { ...source, turn: null }, observation())).toMatchObject({
      status: "unverifiable",
      reason: "source_unavailable",
    });
    expect(projectDeliveryBrief("Broken source", source, observation())).toMatchObject({
      status: "invalid",
      reason: "malformed",
      source,
    });
    expect(projectDeliveryBrief(markdown, source, observation(), false)).toMatchObject({
      status: "invalid",
      reason: "too_large",
      source,
    });
  });
});
