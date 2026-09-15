import { describe, expect, it } from "vitest";
import { ACTIVITY_TEXT_LIMIT, presentTurnEvent } from "../src/turns/activity.js";
import {
  ClaudeEventParser,
  CodexEventParser,
  separateFinalResponse,
} from "../src/turns/engines.js";

const at = new Date("2026-09-10T10:00:00Z");

function event(type: string, data: Record<string, unknown>, seq = 1) {
  return { turnId: "turn_a", seq, type, data, createdAt: at };
}

describe("engine final response separation", () => {
  it("keeps only the last Codex agent message as the final response", () => {
    const parser = new CodexEventParser();
    parser.push(
      `${[
        JSON.stringify({ type: "thread.started", thread_id: "thread" }),
        JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "Plan" } }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "I'll start by reading the tests." },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "command_execution", command: "pnpm test", exit_code: 0 },
        }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "   " } }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Done: the fix is in place and tests pass." },
        }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
      ].join("\n")}\n`,
    );
    parser.finish();
    const result = parser.result();
    expect(result.output).toBe("Done: the fix is in place and tests pass.");
    expect(result.progress).toEqual(["I'll start by reading the tests."]);
    expect(result.model).toBeUndefined();
  });

  it("uses the Claude result as the final response and reports the model", () => {
    const parser = new ClaudeEventParser();
    parser.push(
      `${[
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "session",
          model: "claude-opus-4-8",
        }),
        JSON.stringify({
          type: "assistant",
          message: { model: "claude-opus-4-8", content: [{ type: "text", text: "Looking" }] },
        }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "a.ts" } }] },
        }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "All good." }] },
        }),
        JSON.stringify({ type: "result", session_id: "session", result: "All good." }),
      ].join("\n")}\n`,
    );
    parser.finish();
    const result = parser.result();
    expect(result.output).toBe("All good.");
    expect(result.progress).toEqual(["Looking"]);
    expect(result.model).toBe("claude-opus-4-8");
  });

  it("falls back to the last assistant text when Claude emits no result", () => {
    const parser = new ClaudeEventParser();
    parser.push(
      `${[
        JSON.stringify({ type: "system", subtype: "init", session_id: "session" }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "One" }] },
        }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "Two" }] },
        }),
      ].join("\n")}\n`,
    );
    parser.finish();
    expect(parser.result()).toMatchObject({ output: "Two", progress: ["One"] });
  });

  it("separates an explicit final response without counting its trailing duplicate", () => {
    expect(separateFinalResponse(["a", "b"], "b")).toEqual({ output: "b", progress: ["a"] });
    expect(separateFinalResponse(["a", "b"], "c")).toEqual({ output: "c", progress: ["a", "b"] });
    expect(separateFinalResponse([])).toEqual({ output: "", progress: [] });
    expect(separateFinalResponse(["only"])).toEqual({ output: "only", progress: [] });
  });
});

describe("turn activity presentation", () => {
  it("describes Codex items by kind", () => {
    expect(
      presentTurnEvent(
        event("engine.item.completed", {
          item: {
            type: "command_execution",
            command: "pnpm test",
            exit_code: 1,
            aggregated_output: "1 failed",
          },
        }),
      ),
    ).toMatchObject({ kind: "error", title: "Command exit 1", text: "pnpm test\n\n1 failed" });
    expect(
      presentTurnEvent(
        event("engine.item.started", { item: { type: "command_execution", command: "ls" } }),
      ),
    ).toMatchObject({ kind: "command", title: "Running command", text: "ls" });
    expect(
      presentTurnEvent(
        event("engine.item.completed", {
          item: { type: "file_change", changes: [{ path: "src/a.ts", kind: "update" }] },
        }),
      ),
    ).toMatchObject({ kind: "file_change", title: "Changed 1 file", text: "update src/a.ts" });
    expect(
      presentTurnEvent(
        event("engine.item.completed", { item: { type: "reasoning", text: "Think" } }),
      ),
    ).toMatchObject({ kind: "reasoning", title: "Reasoning summary", text: "Think" });
    expect(
      presentTurnEvent(
        event("engine.item.completed", { item: { type: "agent_message", text: "Hi" } }),
      ),
    ).toMatchObject({ kind: "message", title: "Agent message", text: "Hi" });
    expect(
      presentTurnEvent(event("engine.turn.failed", { error: { message: "quota" } })),
    ).toMatchObject({ kind: "error", text: "quota" });
  });

  it("describes Claude blocks, tool results, and the final result", () => {
    expect(
      presentTurnEvent(
        event("engine.assistant", {
          message: {
            content: [
              { type: "text", text: "Reading" },
              { type: "tool_use", name: "Read", input: { file_path: "src/a.ts" } },
            ],
          },
        }),
      ),
    ).toMatchObject({ kind: "tool", title: "Used Read", text: "Reading\n\nsrc/a.ts" });
    expect(
      presentTurnEvent(
        event("engine.user", {
          message: { content: [{ type: "tool_result", is_error: true, content: "ENOENT" }] },
        }),
      ),
    ).toMatchObject({ kind: "error", title: "Tool reported an error", text: "ENOENT" });
    expect(
      presentTurnEvent(event("engine.result", { subtype: "success", result: "Shipped." })),
    ).toMatchObject({ kind: "result", title: "Final response", text: "Shipped." });
    expect(
      presentTurnEvent(event("engine.result", { subtype: "error_max_turns", is_error: true })),
    ).toMatchObject({ kind: "error", title: "Engine finished with an error (error_max_turns)" });
    expect(
      presentTurnEvent(event("engine.system", { subtype: "init", model: "claude-opus-4-8" })),
    ).toMatchObject({ kind: "session", text: "Model claude-opus-4-8" });
  });

  it("describes Facility lifecycle events", () => {
    expect(presentTurnEvent(event("turn.started", {}))).toMatchObject({
      kind: "lifecycle",
      title: "Run started",
      text: null,
    });
    expect(presentTurnEvent(event("turn.failed", { error: "boom" }))).toMatchObject({
      kind: "error",
      title: "Run failed",
      text: "boom",
    });
    expect(presentTurnEvent(event("turn.succeeded", { durationMs: 65_000 }))).toMatchObject({
      kind: "lifecycle",
      text: "Duration 1 min 5 s",
    });
    expect(presentTurnEvent(event("some.unknown_type", {}))).toMatchObject({
      kind: "other",
      title: "some unknown type",
    });
  });

  it("bounds long text and reports the stored size", () => {
    const long = "x".repeat(ACTIVITY_TEXT_LIMIT + 500);
    const item = presentTurnEvent(
      event("engine.item.completed", { item: { type: "agent_message", text: long } }),
    );
    expect(item.truncated).toBe(true);
    expect(item.text?.length).toBe(ACTIVITY_TEXT_LIMIT + 1);
    expect(item.size_bytes).toBeGreaterThan(ACTIVITY_TEXT_LIMIT);
    const stored = presentTurnEvent(event("engine.assistant", { truncated: true, payload: "{…" }));
    expect(stored).toMatchObject({ truncated: true, title: "engine assistant (stored truncated)" });
  });
});
