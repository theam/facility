import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentManifest } from "@facility/agents";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentEngineError,
  CLAUDE_READ_ONLY_TOOLS,
  ClaudeCodeEngine,
  ClaudeEventParser,
  CodexEngine,
  CodexEventParser,
  nativeSessionFromEvent,
  observationFailureEvidence,
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
  retireCompute(): never {
    throw new Error("not used");
  }
  destroy(): never {
    throw new Error("not used");
  }
}

describe("native agent engines", () => {
  it.each([
    [{ OPENAI_API_KEY: "project-key" }, "project-key"],
    [{ OPENAI_API_KEY: "project-key", CODEX_API_KEY: "explicit-key" }, "explicit-key"],
    [{ OPENAI_API_KEY: "project-key", CODEX_API_KEY: "" }, ""],
    [{}, undefined],
  ])("passes only the current request's Codex credential without mutating it", async (environment, expected) => {
    const original = { ...environment };
    const runtime = new EngineRuntime({
      exitCode: 0,
      stdout: '{"type":"thread.started","thread_id":"native"}\n',
      stderr: "",
      durationMs: 1,
    });
    await new CodexEngine(runtime).run({
      turnId: "turn_credentials",
      manifest: manifest("codex"),
      workspace,
      prompt: "work",
      cwd: ".",
      environment,
    });
    expect(runtime.command?.env?.CODEX_API_KEY).toBe(expected);
    expect(environment).toEqual(original);
    if (expected) expect(JSON.stringify(runtime.command?.args)).not.toContain(expected);
  });

  it("parses chunked Claude stream-json and resumes with a budget when supplied", async () => {
    const stdout = `${[
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session" }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "working" }] },
      }),
      JSON.stringify({
        type: "result",
        session_id: "claude-session",
        result: "done",
        total_cost_usd: 0.0123,
        usage: {
          input_tokens: 20,
          output_tokens: 5,
          cache_read_input_tokens: 7,
          cache_creation_input_tokens: 3,
        },
      }),
    ].join("\n")}\n`;
    const runtime = new EngineRuntime({ exitCode: 0, stdout, stderr: "", durationMs: 12 });
    const result = await new ClaudeCodeEngine(runtime).run({
      turnId: "turn_claude",
      manifest: manifest("claude_code"),
      workspace,
      prompt: "continue",
      cwd: "repos/app",
      nativeSessionId: "claude-session",
      maxBudgetUsd: 0.85,
    });
    expect(result).toMatchObject({
      nativeSessionId: "claude-session",
      output: "done",
      usage: {
        inputTokens: 20,
        outputTokens: 5,
        cacheReadTokens: 7,
        cacheWriteTokens: 3,
        reportedCostCents: 1.23,
      },
    });
    expect(runtime.command).toMatchObject({
      command: "sh",
      cwd: "repos/app",
      env: { FACILITY_TURN_ID: "turn_claude" },
    });
    expect(runtime.command?.args).toContain("claude");
    expect(runtime.command?.args).toContain("--max-budget-usd");
    expect(runtime.command?.args).toContain("0.850000");
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
    expect(result).toMatchObject({
      nativeSessionId: "codex-thread",
      output: "implemented",
      usage: {
        inputTokens: 2,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    });
    const codexIndex = runtime.command?.args?.indexOf("codex") ?? -1;
    expect(runtime.command?.args?.slice(codexIndex + 1, codexIndex + 4)).toEqual([
      "exec",
      "resume",
      "--json",
    ]);
    expect(runtime.command?.args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(runtime.command?.args).toEqual(expect.arrayContaining(["codex-thread", "continue"]));
  });

  it("fails a Claude Code turn stopped at its per-turn limit and keeps the reported cost", async () => {
    // Recorded from Claude Code print mode with --max-budget-usd: exit status 1, no stderr.
    const stdout = `${[
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-limited" }),
      JSON.stringify({
        type: "result",
        subtype: "error_max_budget_usd",
        is_error: true,
        session_id: "claude-limited",
        total_cost_usd: 0.6275,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        errors: ["Reached maximum budget ($0.6)"],
      }),
    ].join("\n")}\n`;
    const runtime = new EngineRuntime({ exitCode: 1, stdout, stderr: "", durationMs: 9 });
    const stopped = new ClaudeCodeEngine(runtime).run({
      turnId: "turn_limited",
      manifest: manifest("claude_code"),
      workspace,
      prompt: "continue",
      cwd: "repos/app",
      maxBudgetUsd: 0.6,
    });
    await expect(stopped).rejects.toMatchObject({
      code: "agent_turn_limit_reached",
      message: expect.stringContaining("per-turn limit of $0.60"),
      details: {
        engine: "claude_code",
        exitCode: 1,
        usage: { inputTokens: 0, outputTokens: 0, reportedCostCents: expect.closeTo(62.75, 6) },
      },
    });
    expect(runtime.command?.args).toEqual(expect.arrayContaining(["--max-budget-usd", "0.600000"]));

    // An ordinary engine failure keeps its own code.
    const failed = new EngineRuntime({
      exitCode: 1,
      stdout: `${JSON.stringify({ type: "result", subtype: "error_during_execution" })}\n`,
      stderr: "boom",
      durationMs: 3,
    });
    await expect(
      new ClaudeCodeEngine(failed).run({
        turnId: "turn_failed",
        manifest: manifest("claude_code"),
        workspace,
        prompt: "continue",
        cwd: "repos/app",
        maxBudgetUsd: 0.6,
      }),
    ).rejects.toMatchObject({ code: "agent_engine_failed", message: "boom" });
  });

  it("never passes a per-turn limit to Codex, which cannot stop mid-turn", async () => {
    const stdout = `${[
      JSON.stringify({ type: "thread.started", thread_id: "codex-limited" }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 2, output_tokens: 3 } }),
    ].join("\n")}\n`;
    const runtime = new EngineRuntime({ exitCode: 0, stdout, stderr: "", durationMs: 4 });
    await expect(
      new CodexEngine(runtime).run({
        turnId: "turn_codex_limited",
        manifest: manifest("codex"),
        workspace,
        prompt: "continue",
        cwd: "repos/app",
        maxBudgetUsd: 0.01,
      }),
    ).resolves.toMatchObject({ nativeSessionId: "codex-limited" });
    expect(runtime.command?.args).not.toContain("--max-budget-usd");
    expect(runtime.command?.args?.join(" ")).not.toMatch(/budget/i);
  });

  it("restricts read-only turns to reading tools and Codex's read-only sandbox", async () => {
    const claudeOutput = `${JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "claude-review",
      result: "reviewed",
    })}\n`;
    const claudeRuntime = new EngineRuntime({
      exitCode: 0,
      stdout: claudeOutput,
      stderr: "",
      durationMs: 5,
    });
    await new ClaudeCodeEngine(claudeRuntime).run({
      turnId: "turn_review",
      manifest: manifest("claude_code"),
      workspace,
      prompt: "review",
      cwd: "repos/app",
      readOnly: true,
    });
    const claudeArgs = claudeRuntime.command?.args ?? [];
    expect(claudeArgs).not.toContain("bypassPermissions");
    expect(claudeArgs).toEqual(expect.arrayContaining(["--permission-mode", "default"]));
    const allowed = claudeArgs[claudeArgs.indexOf("--allowedTools") + 1] ?? "";
    expect(allowed.split(",")).toEqual(CLAUDE_READ_ONLY_TOOLS);
    expect(allowed).not.toMatch(/Edit|Write|git push|git commit|gh api/);
    expect(claudeArgs[claudeArgs.indexOf("--disallowedTools") + 1]).toBe("Edit,Write,NotebookEdit");

    const codexOutput = `${JSON.stringify({ type: "thread.started", thread_id: "codex-review" })}\n`;
    const codexRuntime = new EngineRuntime({
      exitCode: 0,
      stdout: codexOutput,
      stderr: "",
      durationMs: 5,
    });
    await new CodexEngine(codexRuntime)
      .run({
        turnId: "turn_review",
        manifest: manifest("codex"),
        workspace,
        prompt: "review",
        cwd: "repos/app",
        readOnly: true,
      })
      .catch(() => undefined);
    const codexArgs = codexRuntime.command?.args ?? [];
    expect(codexArgs).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(codexArgs).toEqual(expect.arrayContaining(["--sandbox", "read-only"]));
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

describe("recovery evidence validation", () => {
  it.each([
    "../../private",
    "secret\nvalue",
    "x".repeat(201),
    {},
    null,
  ])("rejects malformed native session identities", (thread_id) => {
    expect(
      nativeSessionFromEvent({ engine: "codex", type: "thread.started", data: { thread_id } }),
    ).toBeUndefined();
  });
  it("excludes arbitrary provider payloads from structured evidence", () => {
    expect(
      observationFailureEvidence({
        category: "workspace_session_lost",
        httpStatus: 410,
        headers: { authorization: "secret" },
      }),
    ).toEqual({ category: "workspace_session_lost", httpStatus: 410 });
    expect(
      observationFailureEvidence({ category: "private provider message", httpStatus: "secret" }),
    ).toBeUndefined();
  });
});
