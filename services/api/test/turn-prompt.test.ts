import type { AgentManifest } from "@facility/agents";
import { describe, expect, it } from "vitest";
import {
  compactTranscript,
  type PromptMessage,
  summaryText,
  TRANSCRIPT_LIMIT,
  turnPrompt,
} from "../src/turns/prompt.js";

const manifest = { prompt: "You are the builder." } as AgentManifest;
const story = { title: "Persistent workspace", provider: "manual", externalId: "issue-1" };

function message(seq: number, body: string, turnId: string): PromptMessage {
  return { seq, role: "user", body, turnId, actor: { type: "user", id: "ada" } };
}

describe("turn prompts", () => {
  it("sends only the new user message when a native session is confirmed", () => {
    const prompt = turnPrompt({
      manifest,
      story,
      summary: "Older constraints stay in the session.",
      nativeSessionId: "session-1",
      turnId: "turn_2",
      messages: [
        message(1, "Keep the public API stable.", "turn_1"),
        message(2, "Add the export.", "turn_2"),
      ],
    });
    expect(prompt).toBe("Add the export.");
  });

  it("uses the stored summary instead of the transcript after resume has failed", () => {
    const prompt = turnPrompt({
      manifest,
      story,
      summary: "Keep the public API stable.",
      turnId: "turn_3",
      messages: [message(3, "Retry requested for the lost session.", "turn_3")],
    });
    expect(prompt).toContain("# Conversation summary\nKeep the public API stable.");
    expect(prompt).toContain("# New message\nRetry requested for the lost session.");
    expect(prompt).not.toContain("# Shared conversation");
    expect(prompt).toContain("You are the builder.");
  });

  it("keeps the oldest constraints when a new session must bound a long transcript", () => {
    const oldest = `OLDEST-CONSTRAINT ${"a".repeat(90_000)} MIDDLE-TOKEN ${"b".repeat(90_000)}`;
    const prompt = turnPrompt({
      manifest,
      story,
      summary: null,
      turnId: "turn_2",
      messages: [message(1, oldest, "turn_1"), message(2, "CURRENT-ASK", "turn_2")],
    });
    expect(prompt.startsWith("You are the builder.")).toBe(true);
    expect(prompt).toContain("OLDEST-CONSTRAINT");
    expect(prompt).toContain("CURRENT-ASK");
    expect(prompt).toContain("[Middle of the transcript omitted]");
    expect(prompt).not.toContain("MIDDLE-TOKEN");
    expect(prompt).not.toContain("[Earlier transcript omitted]");
  });

  it("compacts the failed turn into the summary and preserves both ends", () => {
    const text = `START ${"x".repeat(TRANSCRIPT_LIMIT)} END`;
    const compact = compactTranscript(text);
    expect(compact.startsWith("START")).toBe(true);
    expect(compact.endsWith("END")).toBe(true);
    expect(compact).toContain("[Middle of the transcript omitted]");
    expect(compact.length).toBeLessThanOrEqual(TRANSCRIPT_LIMIT);

    const summary = summaryText(
      [
        message(1, "Keep the public API stable.", "turn_1"),
        message(2, "Add the export.", "turn_2"),
      ],
      "turn_2",
    );
    expect(summary).toContain("Keep the public API stable.");
    expect(summary).toContain("Add the export.");
  });
});
