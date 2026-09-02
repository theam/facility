import { parseAgentManifest } from "@facility/agents";
import { describe, expect, it } from "vitest";
import {
  AgentEngineError,
  ClaudeCodeEngine,
  ClaudeEventParser,
  CodexEngine,
  CodexEventParser,
} from "../src/turns/engines.js";
import type {
  WorkspaceCommand,
  WorkspaceCommandResult,
  WorkspaceLocator,
  WorkspaceRuntime,
} from "../src/workspaces/runtime.js";

const workspace: WorkspaceLocator = {
  id: "ws_0123456789abcdef",
  image: "facility-runner:test",
  externalRef: "ws_0123456789abcdef",
  volumeRef: "volume",
};

function manifest(engine: "claude_code" | "codex") {
  const name = engine === "codex" ? "builder" : "architect";
  return parseAgentManifest(
    `---
name: ${name}
description: Test agent.
engine: ${engine}
model: ${engine === "codex" ? "gpt-5.5" : "claude-opus-4-8"}
enabled: true
options:
  reasoning_effort: high
  max_turns: 12
triggers:
  - type: manual
---
Test prompt.
`,
    `${name}.md`,
  );
}

class EngineRuntime implements WorkspaceRuntime {
  readonly provider = "fake" as const;
  command?: WorkspaceCommand;

  constructor(private readonly result: WorkspaceCommandResult) {}

  async exec(_workspace: WorkspaceLocator, command: WorkspaceCommand) {
    this.command = command;
    for (const chunk of split(this.result.stdout)) {
      command.onOutput?.({ stream: "stdout", data: chunk });
    }
    return this.result;
  }

  create(): never {
    throw new Error("not used");
  }
  wake(): never {
    throw new Error("not used");
  }
  expose(): never {
    throw new Error("not used");
  }
  inspect(): never {
    throw new Error("not used");
  }
  suspend(): never {
    throw new Error("not used");
  }
  destroy(): never {
    throw new Error("not used");
  }
}

describe("native agent engines", () => {
  it("parses chunked Claude stream-json and resumes with full access", async () => {
    const stdout = `${[
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session" }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "working" }] },
      }),
      JSON.stringify({ type: "result", session_id: "claude-session", result: "done" }),
    ].join("\n")}\n`;
    const runtime = new EngineRuntime({ exitCode: 0, stdout, stderr: "", durationMs: 12 });
    const result = await new ClaudeCodeEngine(runtime).run({
      manifest: manifest("claude_code"),
      workspace,
      prompt: "continue",
      cwd: "repos/app",
      nativeSessionId: "claude-session",
    });
    expect(result).toMatchObject({ nativeSessionId: "claude-session", output: "done" });
    expect(runtime.command).toMatchObject({ command: "claude", cwd: "repos/app" });
    expect(runtime.command?.args).toEqual(
      expect.arrayContaining([
        "--permission-mode",
        "bypassPermissions",
        "--resume",
        "claude-session",
      ]),
    );
  });

  it("parses chunked Codex JSONL and resumes the native thread with no sandbox", async () => {
    const stdout = `${[
      JSON.stringify({ type: "thread.started", thread_id: "codex-thread" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "implemented" },
      }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 2, output_tokens: 3 } }),
    ].join("\n")}\n`;
    const runtime = new EngineRuntime({ exitCode: 0, stdout, stderr: "", durationMs: 15 });
    const result = await new CodexEngine(runtime).run({
      manifest: manifest("codex"),
      workspace,
      prompt: "continue",
      cwd: "repos/app",
      nativeSessionId: "codex-thread",
    });
    expect(result).toMatchObject({ nativeSessionId: "codex-thread", output: "implemented" });
    expect(runtime.command?.args?.slice(0, 3)).toEqual(["exec", "resume", "--json"]);
    expect(runtime.command?.args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(runtime.command?.args).toEqual(expect.arrayContaining(["codex-thread", "continue"]));
  });

  it("rejects malformed engine output and non-zero exits", async () => {
    const claude = new ClaudeEventParser();
    expect(() => claude.push("not-json\n")).toThrowError(AgentEngineError);

    const codex = new CodexEventParser();
    codex.push(`${JSON.stringify({ type: "thread.started", thread_id: "thread" })}\n`);
    codex.finish();
    expect(codex.result().sessionId).toBe("thread");

    const runtime = new EngineRuntime({
      exitCode: 1,
      stdout: "",
      stderr: "auth failed",
      durationMs: 1,
    });
    await expect(
      new CodexEngine(runtime).run({
        manifest: manifest("codex"),
        workspace,
        prompt: "work",
        cwd: ".",
      }),
    ).rejects.toMatchObject({ code: "agent_engine_failed", message: "auth failed" });
  });
});

function split(value: string) {
  const middle = Math.floor(value.length / 2);
  return [value.slice(0, middle), value.slice(middle)];
}
