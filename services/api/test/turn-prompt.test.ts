import { parseAgentManifest } from "@facility/agents";
import type { stories, storyMessages } from "@facility/db";
import { describe, expect, it } from "vitest";
import {
  actorLabel,
  buildPrompt,
  composeTranscript,
  TRANSCRIPT_BUDGET,
} from "../src/turns/prompt.js";

const manifest = parseAgentManifest(
  `---
name: builder
description: Implements stories.
engine: codex
model: gpt-5.5
enabled: true
options:
  reasoning_effort: high
triggers:
  - type: manual
---
Implement the request and verify it.
`,
  "builder.md",
);

const userActor = { type: "user", id: "tester" };
const agentActor = { type: "agent", id: "codex" };

function story(overrides: Partial<typeof stories.$inferSelect> = {}): typeof stories.$inferSelect {
  return {
    id: "story_1",
    orgId: "org_1",
    projectId: "proj_1",
    repositoryId: null,
    provider: "manual",
    externalId: "ext_1",
    title: "Implement the feature",
    status: "working",
    activeAgentName: null,
    branch: null,
    pullRequestNumber: null,
    pullRequestUrl: null,
    titleSource: "user",
    titleGeneration: null,
    integrationState: {},
    integrationStateRevision: 0,
    createdBy: userActor,
    completedAt: null,
    archivedAt: null,
    archivedFromStatus: null,
    deletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function message(
  overrides: Partial<typeof storyMessages.$inferSelect> & { seq: number },
): typeof storyMessages.$inferSelect {
  return {
    id: `msg_${overrides.seq}`,
    orgId: "org_1",
    projectId: "proj_1",
    storyId: "story_1",
    conversationId: "conv_1",
    role: "user",
    body: "hello",
    actor: userActor,
    turnId: null,
    requestedAgentName: null,
    requestedTrigger: null,
    dedupeKey: null,
    metadata: {},
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

/** Pads a distinctive label to an exact length so block sizes are deterministic. */
function body(label: string, length: number) {
  if (label.length > length) throw new Error("label longer than the requested body length");
  return `${label}${"x".repeat(length - label.length)}`;
}

// Handcrafted so the budget math is exact and reviewable:
// - "user"/"tester" and "agent"/"codex" both label to 11 characters, so a user
//   header is 20 characters and an agent header is 21.
// - opening (40) + ack (40) + 7 filler blocks (300 each) + closing (40) = 2220
//   characters, well over the 2_000 budget used below.
// - headBudget = floor(2_000 * 0.25) = 500 fits [opening, ack, filler #1] (384
//   characters); tailBudget = 2_000 - 500 - 160 = 1_340 fits [filler #4..#7,
//   closing] (1_248 characters), leaving filler #2 and #3 (seq 4-5) omitted.
function buildElidedFixture(budget = 2_000) {
  const opening = message({ seq: 1, role: "user", actor: userActor, body: body("OPENING", 20) });
  const ack = message({ seq: 2, role: "agent", actor: agentActor, body: body("ACK", 19) });
  const fillers = Array.from({ length: 7 }, (_, i) =>
    message({
      seq: i + 3,
      role: "agent",
      actor: agentActor,
      body: body(`FILLER-${i + 1}`, 279),
    }),
  );
  const closing = message({ seq: 10, role: "user", actor: userActor, body: body("CLOSING", 20) });
  const messages = [opening, ack, ...fillers, closing];
  return { messages, opening, closing, budget };
}

describe("composeTranscript below budget", () => {
  it("returns exactly the naive join, byte for byte, with no elision marker", () => {
    const messages = [
      message({ seq: 1, role: "user", body: "Hello" }),
      message({ seq: 2, role: "agent", body: "Hi there" }),
      message({ seq: 3, role: "user", body: "Thanks" }),
    ];
    const naiveJoin = messages
      .map((m) => `${m.role.toUpperCase()} (${actorLabel(m.actor)}):\n${m.body}`)
      .join("\n\n");
    const result = composeTranscript(messages, 1_000);
    expect(result).toBe(naiveJoin);
    expect(result).not.toContain("Omitted");
  });
});

describe("composeTranscript above budget", () => {
  const { messages, opening, closing, budget } = buildElidedFixture();
  const result = composeTranscript(messages, budget);

  it("keeps both the opening message and the closing message intact", () => {
    expect(result).toContain(opening.body);
    expect(result).toContain(closing.body);
  });

  it("emits exactly one elision marker naming the omitted message count and seq range", () => {
    expect(result).toContain("[Omitted 2 earlier messages (seq 4-5) to fit the context budget]");
    expect(result.match(/\[Omitted/g)?.length ?? 0).toBe(1);
  });

  it("never splits a message body from its role/actor header", () => {
    for (const segment of result.split("\n\n")) {
      const isMarker = segment.startsWith("[Omitted");
      const hasIntactHeader = /^(USER|AGENT) \([a-z]+:[a-z0-9]+\):\n/.test(segment);
      expect(isMarker || hasIntactHeader).toBe(true);
    }
  });

  it("never exceeds the budget", () => {
    expect(result.length).toBeLessThanOrEqual(budget);
  });
});

describe("buildPrompt", () => {
  it("excludes messages queued after the current turn's user message", () => {
    const messages = [
      message({ seq: 1, role: "user", body: "First ask", turnId: "turn_1" }),
      message({ seq: 2, role: "agent", body: "First answer", turnId: "turn_1" }),
      message({ seq: 3, role: "user", body: "Second ask", turnId: "turn_2" }),
      message({ seq: 4, role: "user", body: "Future queued ask", turnId: "turn_3" }),
    ];
    const prompt = buildPrompt(manifest, story(), null, messages, "turn_2");
    expect(prompt).toContain("Second ask");
    expect(prompt).not.toContain("Future queued ask");
  });

  it("emits the conversation summary section before the shared conversation when present", () => {
    const messages = [message({ seq: 1, role: "user", body: "Hello", turnId: "turn_1" })];
    const prompt = buildPrompt(manifest, story(), "Prior summary text", messages, "turn_1");
    const summaryIndex = prompt.indexOf("# Conversation summary");
    const sharedIndex = prompt.indexOf("# Shared conversation");
    expect(summaryIndex).toBeGreaterThanOrEqual(0);
    expect(sharedIndex).toBeGreaterThan(summaryIndex);
    expect(prompt).toContain("Prior summary text");
  });

  it("omits the conversation summary section when summary is null", () => {
    const messages = [message({ seq: 1, role: "user", body: "Hello", turnId: "turn_1" })];
    const prompt = buildPrompt(manifest, story(), null, messages, "turn_1");
    expect(prompt).not.toContain("# Conversation summary");
  });
});

describe("composeTranscript denied paths and limits", () => {
  it("trims a single message larger than the whole budget and stays within it", () => {
    const huge = [message({ seq: 1, role: "user", body: "x".repeat(5_000) })];
    const budget = 200;
    const result = composeTranscript(huge, budget);
    expect(result.length).toBeLessThanOrEqual(budget);
    expect(result).toContain("truncated to fit the context budget");
  });

  it("never throws and still respects a budget smaller than the marker reserve", () => {
    const messages = [
      message({ seq: 1, role: "user", body: "x".repeat(500) }),
      message({ seq: 2, role: "agent", body: "y".repeat(500) }),
    ];
    const budget = 10;
    expect(() => composeTranscript(messages, budget)).not.toThrow();
    expect(composeTranscript(messages, budget).length).toBeLessThanOrEqual(budget);
  });

  it("returns an empty string with no marker for an empty conversation", () => {
    expect(composeTranscript([], TRANSCRIPT_BUDGET)).toBe("");
  });

  it.each([0, 1, 10, 1_000])("never exceeds the budget with %i short messages", (count) => {
    const messages = Array.from({ length: count }, (_, i) =>
      message({ seq: i + 1, role: i % 2 === 0 ? "user" : "agent", body: "z" }),
    );
    expect(composeTranscript(messages, TRANSCRIPT_BUDGET).length).toBeLessThanOrEqual(
      TRANSCRIPT_BUDGET,
    );
  });

  it.each([1, 500_000])("never exceeds the budget with bodies of %i characters", (bodyLength) => {
    const messages = [
      message({ seq: 1, role: "user", body: "a".repeat(bodyLength) }),
      message({ seq: 2, role: "agent", body: "b".repeat(bodyLength) }),
      message({ seq: 3, role: "user", body: "c".repeat(bodyLength) }),
    ];
    expect(composeTranscript(messages, TRANSCRIPT_BUDGET).length).toBeLessThanOrEqual(
      TRANSCRIPT_BUDGET,
    );
  });
});
