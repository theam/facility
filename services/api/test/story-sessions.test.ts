import { parseAgentManifest } from "@facility/agents";
import type { FacilityDb } from "@facility/db";
import { describe, expect, it } from "vitest";
import {
  emptyUsage,
  hasNativeUsage,
  interactiveArguments,
  messagesForNativeResume,
  nativeAgentState,
  nativeCost,
  nativeMessage,
  nativeUsage,
  usageSince,
} from "../src/sessions/native.js";
import { assertSessionPrincipal } from "../src/sessions/service.js";
import type { Principal } from "../src/types.js";

const actor: Principal = {
  type: "user",
  id: "user",
  userId: "user",
  orgId: "org",
  permissions: ["sessions:control"],
};
function membership(permissions: string[], active = true) {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: async () => (active ? [{ permissions }] : []),
  };
  return { select: () => chain } as unknown as FacilityDb;
}

describe("session authorization", () => {
  it("requires a user principal even when an API key has wildcard permission", async () => {
    await expect(
      assertSessionPrincipal(
        membership(["*"]),
        { ...actor, type: "key", userId: undefined, permissions: ["*"] },
        "sessions:control",
      ),
    ).rejects.toMatchObject({ code: "session_user_required" });
  });
  it("allows current membership permissions intersected with the authenticated grants", async () => {
    await expect(
      assertSessionPrincipal(membership(["sessions:control"]), actor, "sessions:control"),
    ).resolves.toBeUndefined();
    await expect(
      assertSessionPrincipal(membership(["sessions:observe"]), actor, "sessions:control"),
    ).rejects.toMatchObject({ code: "session_forbidden" });
    await expect(
      assertSessionPrincipal(membership(["*"]), { ...actor, permissions: [] }, "sessions:control"),
    ).rejects.toMatchObject({ code: "session_forbidden" });
  });
  it("denies revoked membership and suspended accounts", async () => {
    await expect(
      assertSessionPrincipal(membership(["*"], false), actor, "sessions:control"),
    ).rejects.toMatchObject({ code: "session_forbidden" });
  });
});

describe("native journal accounting", () => {
  it("prices Codex model changes after the entry baseline and keeps missing prices unavailable", () => {
    const tokens = (input: number, output: number) => ({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: input, output_tokens: output } },
      },
    });
    const context = (model: string) => ({ type: "turn_context", payload: { model } });
    const records = [
      context("gpt-5.5"),
      tokens(50, 5),
      context("gpt-5.5"),
      tokens(150, 15),
      context("gpt-5.5-mini"),
      tokens(250, 25),
    ];
    const baseline = nativeUsage("codex", records.slice(0, 2));
    const result = nativeCost("codex", records, 2, baseline, "gpt-5.5");
    expect(result.model).toBe("mixed");
    expect(result.costCents).toBeCloseTo(0.1345, 8);
    expect(
      nativeCost(
        "codex",
        [...records, context("unpriced-model"), tokens(350, 35)],
        2,
        baseline,
        "gpt-5.5",
      ).costCents,
    ).toBeNull();
  });
  it("prices Claude response models once, excluding response usage present before entry", () => {
    const response = (id: string, model: string, input: number, output: number) => ({
      type: "assistant",
      message: { id, model, usage: { input_tokens: input, output_tokens: output } },
    });
    const old = response("old", "claude-haiku-4-5", 50, 5);
    const next = response("next", "claude-opus-5-5", 100, 10);
    const records = [old, next, next, response("last", "claude-haiku-4-5", 100, 10)];
    expect(
      nativeCost("claude_code", records, 1, nativeUsage("claude_code", [old]), "claude-haiku-4-5"),
    ).toMatchObject({ model: "mixed", costCents: expect.closeTo(0.072, 8) });
  });
  it("combines Codex journal starts with notify, attention and permission hook state", () => {
    const records = [
      { type: "event_msg", timestamp: "2026-01-01T00:00:02Z", payload: { type: "task_started" } },
    ];
    const snapshot = {
      records,
      hooks: [{ state: "idle" as const, message: "", at: "2026-01-01T00:00:01Z" }],
      bytes: 0,
      exited: false,
      nativeSessionId: "native",
    };
    expect(nativeAgentState("codex", snapshot)?.state).toBe("working");
    expect(
      nativeAgentState("codex", {
        ...snapshot,
        hooks: [{ state: "blocked", message: "Permission required", at: "2026-01-01T00:00:03Z" }],
      })?.state,
    ).toBe("blocked");
    expect(
      nativeAgentState("codex", {
        ...snapshot,
        hooks: [{ state: "idle", message: "Done", at: "2026-01-01T00:00:03Z" }],
      })?.state,
    ).toBe("idle");
    expect(
      nativeAgentState("codex", {
        ...snapshot,
        hooks: [],
        records: [
          ...records,
          {
            type: "response_item",
            timestamp: "2026-01-01T00:00:03Z",
            payload: {
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "<facility-needs-attention>Which option?</facility-needs-attention>",
                },
              ],
            },
          },
        ],
      }),
    ).toMatchObject({ state: "blocked", message: "Which option?" });
  });
  it.each([
    "claude_code",
    "codex",
  ])("keeps %s attention after an empty stop hook until a person answers", (engine) => {
    const message = (role: string, content: string, timestamp: string) =>
      engine === "codex"
        ? { type: "response_item", timestamp, payload: { type: "message", role, content } }
        : { type: role, timestamp, message: { role, content } };
    const records = [
      message(
        "assistant",
        "<facility-needs-attention>Which option?</facility-needs-attention>",
        "2026-01-01T00:00:02Z",
      ),
    ];
    const snapshot = {
      records,
      hooks: [{ state: "idle" as const, message: "", at: "2026-01-01T00:00:03Z" }],
      bytes: 0,
      exited: false,
      nativeSessionId: "native",
    };
    expect(nativeAgentState(engine, snapshot)).toMatchObject({
      state: "blocked",
      message: "Which option?",
    });
    expect(
      nativeAgentState(engine, {
        ...snapshot,
        records: [...records, message("user", "The first", "2026-01-01T00:00:04Z")],
      })?.state,
    ).toBe(engine === "codex" ? "working" : "idle");
  });
  it("distinguishes unavailable usage from an explicitly reported zero", () => {
    expect(
      hasNativeUsage("codex", [
        { type: "response_item", payload: { type: "message", role: "assistant" } },
      ]),
    ).toBe(false);
    expect(
      hasNativeUsage("claude_code", [
        { type: "assistant", message: { usage: { input_tokens: 0, output_tokens: 0 } } },
      ]),
    ).toBe(true);
    expect(
      hasNativeUsage("codex", [
        {
          type: "event_msg",
          payload: {
            type: "token_count",
            info: { total_token_usage: { input_tokens: -1, output_tokens: 0 } },
          },
        },
      ]),
    ).toBe(false);
  });
  it("does not duplicate imported native conversation in a resumed Facility prompt", () => {
    const messages = [
      { metadata: { nativeSessionId: "current" }, body: "Already in native history" },
      { metadata: {}, body: "New web message" },
    ];
    expect(messagesForNativeResume(messages, "current").map((message) => message.body)).toEqual([
      "New web message",
    ]);
    expect(messagesForNativeResume(messages)).toEqual(messages);
  });
  it("does not count repeated Claude response usage twice", () => {
    const record = {
      type: "assistant",
      message: {
        id: "response",
        usage: {
          input_tokens: 10,
          output_tokens: 3,
          cache_read_input_tokens: 8,
          cache_creation_input_tokens: 2,
        },
      },
    };
    expect(nativeUsage("claude_code", [record, record])).toEqual({
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 8,
      cacheWriteTokens: 2,
    });
  });
  it("uses Codex cumulative usage and excludes cached input from regular input", () => {
    const event = (input: number) => ({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: input, cached_input_tokens: 20, output_tokens: 10 },
        },
      },
    });
    expect(nativeUsage("codex", [event(100), event(120)])).toEqual({
      inputTokens: 100,
      cacheReadTokens: 20,
      outputTokens: 10,
      cacheWriteTokens: 0,
    });
  });
  it("subtracts the committed entry baseline and refuses regressing counters", () => {
    expect(
      usageSince({ ...emptyUsage(), inputTokens: 100 }, { ...emptyUsage(), inputTokens: 40 })
        .inputTokens,
    ).toBe(60);
    expect(() => usageSince(emptyUsage(), { ...emptyUsage(), inputTokens: 1 })).toThrow(
      "regressed",
    );
  });
  it("extracts text without turning tools and subagents into user messages", () => {
    expect(
      nativeMessage("codex", {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "A correction" }],
        },
      }),
    ).toEqual({ role: "user", body: "A correction" });
    expect(
      nativeMessage("claude_code", {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Done" },
            { type: "tool_use", name: "Bash" },
          ],
        },
      }),
    ).toEqual({ role: "assistant", body: "Done" });
    expect(
      nativeMessage("claude_code", {
        type: "user",
        isSidechain: true,
        message: { content: "child context" },
      }),
    ).toBeNull();
    expect(
      nativeMessage("codex", {
        type: "response_item",
        payload: { type: "function_call", role: "assistant" },
      }),
    ).toBeNull();
  });
  it("resumes the same native identity with the manifest model and instructions", () => {
    const manifest = parseAgentManifest(
      `---\nname: builder\ndescription: Builds changes\nengine: codex\nmodel: gpt-5.5\ntriggers:\n  - type: manual\n---\nPreserve the story worktree.`,
      "builder.md",
    );
    const args = interactiveArguments(manifest, "native-id");
    expect(args.slice(0, 2)).toEqual(["resume", "native-id"]);
    expect(args).toContain("gpt-5.5");
    expect(args).toContain('notify=["facility-session-hook"]');
    expect(interactiveArguments({ ...manifest, engine: "claude_code" }, "same-id")).toEqual(
      expect.arrayContaining(["--resume", "same-id", "--settings", "bypassPermissions"]),
    );
    for (const engine of ["codex", "claude_code"] as const) {
      const args = interactiveArguments(
        { ...manifest, engine, prompt: "x".repeat(200_000) },
        "same-id",
        "/workspace/.facility/interactive/turn_fixture/instructions.md",
      );
      expect(args.join(" ").length).toBeLessThan(4096);
      expect(args.join(" ")).toContain("instructions.md");
    }
  });
});
