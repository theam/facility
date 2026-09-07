import { parseAgentManifest } from "@facility/agents";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sandboxApi = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@vercel/sandbox", () => ({ Sandbox: sandboxApi }));

import { ClaudeCodeEngine, CodexEngine } from "../src/turns/engines.js";
import { VercelWorkspaceRuntime } from "../src/workspaces/vercel.js";

const workspace = {
  id: "ws_0123456789abcdef",
  externalRef: "ws_0123456789abcdef",
  volumeRef: "snap_retained",
  image: "facility-runner:test",
};

function provider(engine: "claude_code" | "codex", exitCode = 0, onLog?: () => void) {
  const kill = vi.fn().mockResolvedValue(undefined);
  const events =
    engine === "claude_code"
      ? [{ type: "result", session_id: "native-session", result: "ready" }]
      : [
          { type: "thread.started", thread_id: "native-session" },
          { type: "item.completed", item: { type: "agent_message", text: "ready" } },
          { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
        ];
  const runCommand = vi.fn(async (params: { timeoutMs?: number; detached?: boolean }) => {
    // Reproduce the provider contract that rejected the real default engine request.
    if ((params.timeoutMs ?? 0) > 18_000_000) {
      throw new Error("Invalid request: `timeout` should be <= 18000000.");
    }
    return {
      kill,
      logs: async function* () {
        onLog?.();
        for (const event of events) yield { stream: "stdout", data: `${JSON.stringify(event)}\n` };
        if (exitCode) yield { stream: "stderr", data: "command terminated" };
      },
      wait: async () => ({ exitCode, durationMs: 10 }),
    };
  });
  sandboxApi.get.mockResolvedValue({ asUser: () => ({ runCommand }) });
  return { runCommand, kill };
}

function request(engine: "claude_code" | "codex") {
  return {
    turnId: "turn_provider_contract",
    workspace,
    cwd: "/workspace/repos/app",
    prompt: "Continue the accepted work",
    nativeSessionId: "native-session",
    manifest: parseAgentManifest(
      `---
name: agent
description: Provider contract test.
engine: ${engine}
model: ${engine === "codex" ? "gpt-5.5" : "claude-opus-4-8"}
enabled: true
triggers:
  - type: manual
---
Continue the accepted work.
`,
      "agent.md",
    ),
  };
}

describe.each(["claude_code", "codex"] as const)("%s through the Vercel runtime", (engine) => {
  beforeEach(() => vi.clearAllMocks());
  const createEngine = () => {
    const runtime = new VercelWorkspaceRuntime();
    return engine === "codex" ? new CodexEngine(runtime) : new ClaudeCodeEngine(runtime);
  };

  it("starts the default agent command and resumes its native session within the provider ceiling", async () => {
    const { runCommand, kill } = provider(engine);
    await expect(createEngine().run(request(engine))).resolves.toMatchObject({
      nativeSessionId: "native-session",
      output: "ready",
      exitCode: 0,
    });
    expect(runCommand).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 18_000_000,
        detached: true,
        cwd: "/workspace/repos/app",
        args: expect.arrayContaining([engine === "codex" ? "codex" : "claude", "native-session"]),
      }),
    );
    expect(kill).not.toHaveBeenCalled();
  });

  it("reports a provider-terminated command as a failed turn", async () => {
    provider(engine, 137);
    await expect(createEngine().run(request(engine))).rejects.toMatchObject({
      code: "agent_engine_failed",
      message: "command terminated",
      details: { exitCode: 137 },
    });
  });

  it("still terminates the running command when the turn is canceled", async () => {
    const controller = new AbortController();
    const { kill } = provider(engine, 0, () => controller.abort());
    await expect(
      createEngine().run({ ...request(engine), signal: controller.signal }),
    ).rejects.toMatchObject({ code: "workspace_command_canceled" });
    expect(kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  });
});
