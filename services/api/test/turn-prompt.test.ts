import type { AgentManifest } from "@facility/agents";
import type { attentionItems, stories, storyMessages } from "@facility/db";
import { describe, expect, it } from "vitest";
import { buildPrompt } from "../src/turns/prompt.js";

const manifest = { prompt: "Review the implementation." } as AgentManifest;
const story = {
  title: "A story",
  provider: "manual",
  externalId: "test",
} as typeof stories.$inferSelect;

function message(seq: number, role: "user" | "agent", body: string, turnId: string | null) {
  return {
    seq,
    role,
    body,
    turnId,
    actor: { type: "user", id: "test" },
  } as typeof storyMessages.$inferSelect;
}

function prompt(
  messages: Array<typeof storyMessages.$inferSelect>,
  turnId = "reviewer",
  attention: Array<typeof attentionItems.$inferSelect> = [],
) {
  return buildPrompt(manifest, story, null, messages, turnId, attention);
}

function question(
  detail: string | null,
  turnId: string | null = "builder",
  status = "resolved",
  kind = "agent_waiting",
) {
  return { kind, turnId, detail, status } as typeof attentionItems.$inferSelect;
}

describe("turn conversation context", () => {
  it("includes a predecessor response appended after a review was queued, before the review request", () => {
    const result = prompt([
      message(1, "user", "Build the change", "builder"),
      message(2, "user", "Review the result", "reviewer"),
      message(3, "agent", "Integration tests were not run", "builder"),
    ]);
    expect(result).toContain("Integration tests were not run");
    expect(result.indexOf("Integration tests were not run")).toBeLessThan(
      result.indexOf("Review the result"),
    );
  });

  it("excludes later queued requests and their responses, even from the same actor", () => {
    const result = prompt([
      message(1, "user", "Build the change", "builder"),
      message(2, "user", "Review the result", "reviewer"),
      message(3, "user", "FUTURE_REQUEST", "future"),
      message(4, "agent", "Builder handoff", "builder"),
      message(5, "agent", "FUTURE_RESPONSE", "future"),
      message(6, "user", "UNASSIGNED_REQUEST", null),
    ]);
    expect(result).toContain("Builder handoff");
    expect(result).not.toContain("FUTURE_REQUEST");
    expect(result).not.toContain("FUTURE_RESPONSE");
    expect(result).not.toContain("UNASSIGNED_REQUEST");
  });

  it("includes every completed predecessor when multiple requests were queued before their responses", () => {
    const result = prompt([
      message(1, "user", "Plan the change", "architect"),
      message(2, "user", "Build the plan", "builder"),
      message(3, "user", "Review the result", "reviewer"),
      message(4, "agent", "Architect decision", "architect"),
      message(5, "agent", "Builder limitation", "builder"),
    ]);
    expect(result).toContain("Architect decision");
    expect(result).toContain("Builder limitation");
    expect(result.indexOf("Builder limitation")).toBeLessThan(result.indexOf("Review the result"));
  });

  it("preserves normal sequential conversation ordering without duplicating messages", () => {
    const messages = [
      message(1, "user", "Build the change", "builder"),
      message(2, "agent", "Unique builder response", "builder"),
      message(3, "user", "Review the result", "reviewer"),
    ];
    const original = structuredClone(messages);
    const result = prompt(messages);
    expect(result.match(/Unique builder response/g)).toHaveLength(1);
    expect(result.indexOf("Unique builder response")).toBeLessThan(
      result.indexOf("Review the result"),
    );
    expect(messages).toEqual(original);
  });

  it("does not include unrelated or current-turn responses beyond the request boundary", () => {
    const result = prompt([
      message(1, "user", "Build the change", "builder"),
      message(2, "user", "Review the result", "reviewer"),
      message(3, "agent", "UNRELATED_RESPONSE", "unknown"),
      message(4, "agent", "CURRENT_RESPONSE", "reviewer"),
      message(5, "agent", "UNASSIGNED_RESPONSE", null),
    ]);
    expect(result).not.toContain("UNRELATED_RESPONSE");
    expect(result).not.toContain("CURRENT_RESPONSE");
    expect(result).not.toContain("UNASSIGNED_RESPONSE");
  });

  it("preserves the existing fallback when there is no matching user request", () => {
    expect(prompt([message(1, "agent", "Existing context", "builder")], "missing")).toContain(
      "Existing context",
    );
  });

  it.each(["open", "resolved"])("anchors a %s question once on its agent response", (status) => {
    const messages = [
      message(1, "user", "Build the change", "builder"),
      message(2, "agent", "I need a decision", "builder"),
      message(3, "user", "No, continue.", "reviewer"),
    ];
    const attention = [question("Keep the legacy export?", "builder", status)];
    const original = structuredClone({ messages, attention });
    const result = prompt(messages, "reviewer", attention);
    expect(result.match(/Keep the legacy export\?/g)).toHaveLength(1);
    expect(result.indexOf("I need a decision")).toBeLessThan(
      result.indexOf("Keep the legacy export?"),
    );
    expect(result.indexOf("Keep the legacy export?")).toBeLessThan(result.indexOf("No, continue."));
    expect({ messages, attention }).toEqual(original);
  });

  it("includes the question of a predecessor that finished after this reply was queued", () => {
    const result = prompt(
      [
        message(1, "user", "Build the change", "builder"),
        message(2, "user", "No, continue.", "reviewer"),
        message(3, "agent", "I need a decision", "builder"),
        message(4, "user", "FUTURE_REQUEST", "future"),
        message(5, "agent", "FUTURE_RESPONSE", "future"),
      ],
      "reviewer",
      [question("Keep the legacy export?"), question("FUTURE_QUESTION", "future")],
    );
    expect(result).toContain("Keep the legacy export?");
    expect(result.indexOf("Keep the legacy export?")).toBeLessThan(result.indexOf("No, continue."));
    expect(result).not.toContain("FUTURE_");
  });

  it("does not attach other attention kinds or unanchored questions to a request", () => {
    const result = prompt(
      [message(1, "user", "Build the change", "builder"), message(2, "user", "Reply", "reviewer")],
      "reviewer",
      [
        question("NO_AGENT_RESPONSE"),
        question("CURRENT_TURN", "reviewer"),
        question("UNASSIGNED", null),
        question("UNKNOWN_TURN", "unknown"),
      ],
    );
    expect(result).not.toMatch(/NO_AGENT_RESPONSE|CURRENT_TURN|UNASSIGNED|UNKNOWN_TURN/);
    expect(
      prompt(
        [
          message(1, "user", "Build the change", "builder"),
          message(2, "agent", "Done", "builder"),
          message(3, "user", "Reply", "reviewer"),
        ],
        "reviewer",
        [question("TURN_ERROR", "builder", "open", "turn_error"), question(null), question("")],
      ),
    ).not.toContain("Question this turn asked the human:");
  });
});
