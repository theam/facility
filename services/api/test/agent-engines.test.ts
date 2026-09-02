import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentManifest } from "@facility/agents";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentEngineError,
  ClaudeCodeEngine,
  ClaudeEventParser,
  CodexEngine,
  CodexEventParser,
} from "../src/turns/engines.js";
import { FakeWorkspaceRuntime } from "../src/workspaces/fake.js";
import type {
  WorkspaceCommand,
  WorkspaceCommandResult,
  WorkspaceLocator,
  WorkspaceRuntime,
} from "../src/workspaces/runtime.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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
      turnId: "turn_claude",
      manifest: manifest("claude_code"),
      workspace,
      prompt: "continue",
      cwd: "repos/app",
      nativeSessionId: "claude-session",
    });
    expect(result).toMatchObject({ nativeSessionId: "claude-session", output: "done" });
    expect(runtime.command).toMatchObject({
      command: "sh",
      cwd: "repos/app",
      env: { FACILITY_TURN_ID: "turn_claude" },
    });
    expect(runtime.command?.args).toContain("claude");
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
      turnId: "turn_codex",
      manifest: manifest("codex"),
      workspace,
      prompt: "continue",
      cwd: "repos/app",
      nativeSessionId: "codex-thread",
    });
    expect(result).toMatchObject({ nativeSessionId: "codex-thread", output: "implemented" });
    const codexIndex = runtime.command?.args?.indexOf("codex") ?? -1;
    expect(runtime.command?.args?.slice(codexIndex + 1, codexIndex + 4)).toEqual([
      "exec",
      "resume",
      "--json",
    ]);
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
        turnId: "turn_failed",
        manifest: manifest("codex"),
        workspace,
        prompt: "work",
        cwd: ".",
      }),
    ).rejects.toMatchObject({ code: "agent_engine_failed", message: "auth failed" });
  });

  it("classifies an invalid native session separately so dispatch can recover", async () => {
    const runtime = new EngineRuntime({
      exitCode: 1,
      stdout: "",
      stderr: "thread not found; cannot resume",
      durationMs: 1,
    });
    await expect(
      new CodexEngine(runtime).run({
        turnId: "turn_corrupt",
        manifest: manifest("codex"),
        workspace,
        prompt: "continue",
        cwd: ".",
        nativeSessionId: "lost-thread",
      }),
    ).rejects.toMatchObject({ code: "agent_session_corrupt" });
  });

  it("runs deterministic native CLI fakes, resumes them, and cancels only their process", async () => {
    const root = await mkdtemp(join(tmpdir(), "facility-native-engines-"));
    roots.push(root);
    const runtime = new FakeWorkspaceRuntime(join(root, "workspaces"));
    const created = await runtime.create({
      id: "ws_1234567890abcdef",
      image: "facility-runner:test",
    });
    await mkdir(join(created.volumeRef, "repo"), { recursive: true });
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(bin, "claude"),
      [
        "#!/bin/sh",
        'printf \'%s\\n\' "$*" > "$CLAUDE_CONFIG_DIR/last-args"',
        'printf \'%s\\n\' \'{"type":"system","subtype":"init","session_id":"claude-session"}\'',
        'printf \'%s\\n\' \'{"type":"result","session_id":"claude-session","result":"claude complete"}\'',
      ].join("\n"),
    );
    await writeFile(
      join(bin, "codex"),
      [
        "#!/bin/sh",
        'printf \'%s\\n\' "$*" > "$CODEX_HOME/last-args"',
        "case \"$*\" in *lost-thread*) printf '%s\\n' 'thread lost-thread not found; cannot resume' >&2; exit 7 ;; esac",
        'if test "$FACILITY_FAKE_BLOCK" = 1; then printf started > "$CODEX_HOME/blocking"; sleep 30; fi',
        'printf \'%s\\n\' \'{"type":"thread.started","thread_id":"codex-thread"}\'',
        'printf \'%s\\n\' \'{"type":"item.completed","item":{"type":"agent_message","text":"codex complete"}}\'',
      ].join("\n"),
    );
    await Promise.all([chmod(join(bin, "claude"), 0o755), chmod(join(bin, "codex"), 0o755)]);
    const environment = { PATH: [bin, process.env.PATH].filter(Boolean).join(":") };

    await expect(
      new ClaudeCodeEngine(runtime).run({
        turnId: "turn_native_claude",
        manifest: manifest("claude_code"),
        workspace: created,
        prompt: "plan this story",
        cwd: "repo",
        environment,
      }),
    ).resolves.toMatchObject({ nativeSessionId: "claude-session", output: "claude complete" });
    expect(await runtime.read(created, ".facility/claude/last-args")).toContain(
      "--model claude-opus-4-8",
    );

    const codex = new CodexEngine(runtime);
    await expect(
      codex.run({
        turnId: "turn_native_codex",
        manifest: manifest("codex"),
        workspace: created,
        prompt: "build this story",
        cwd: "repo",
        environment,
      }),
    ).resolves.toMatchObject({ nativeSessionId: "codex-thread", output: "codex complete" });
    expect(await runtime.read(created, ".facility/codex/last-args")).toContain("--model gpt-5.5");
    await expect(
      codex.run({
        turnId: "turn_native_resume",
        manifest: manifest("codex"),
        workspace: created,
        prompt: "continue",
        cwd: "repo",
        nativeSessionId: "codex-thread",
        environment,
      }),
    ).resolves.toMatchObject({ nativeSessionId: "codex-thread" });
    expect(await runtime.read(created, ".facility/codex/last-args")).toContain(
      "exec resume --json",
    );
    await expect(
      codex.run({
        turnId: "turn_native_corrupt",
        manifest: manifest("codex"),
        workspace: created,
        prompt: "continue",
        cwd: "repo",
        nativeSessionId: "lost-thread",
        environment,
      }),
    ).rejects.toMatchObject({ code: "agent_session_corrupt" });

    const controller = new AbortController();
    const blocked = codex.run({
      turnId: "turn_native_cancel",
      manifest: manifest("codex"),
      workspace: created,
      prompt: "wait",
      cwd: "repo",
      environment: { ...environment, FACILITY_FAKE_BLOCK: "1" },
      signal: controller.signal,
    });
    await waitForFile(runtime, created, ".facility/codex/blocking", true);
    controller.abort();
    await expect(blocked).rejects.toMatchObject({ code: "workspace_command_canceled" });
    await waitForFile(runtime, created, ".facility/engine-processes/turn_native_cancel.pid", false);
    await expect(runtime.inspect(created)).resolves.toMatchObject({ state: "running" });
  });
});

function split(value: string) {
  const middle = Math.floor(value.length / 2);
  return [value.slice(0, middle), value.slice(middle)];
}

async function waitForFile(
  runtime: FakeWorkspaceRuntime,
  workspace: WorkspaceLocator,
  path: string,
  present: boolean,
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    let found = false;
    try {
      await runtime.read(workspace, path);
      found = true;
    } catch {
      found = false;
    }
    if (found === present) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`expected ${path} to be ${present ? "present" : "absent"}`);
}
