import type { AgentManifest } from "@facility/agents";
import type { WorkspaceLocator, WorkspaceRuntime } from "../workspaces/runtime.js";

export type AgentTurnRequest = {
  turnId: string;
  manifest: AgentManifest;
  workspace: WorkspaceLocator;
  prompt: string;
  cwd: string;
  nativeSessionId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  environment?: Record<string, string>;
};

export type AgentTurnEvent = {
  engine: "claude_code" | "codex";
  type: string;
  data: Record<string, unknown>;
};

export type AgentTurnResult = {
  nativeSessionId: string;
  output: string;
  events: AgentTurnEvent[];
  exitCode: number;
  stderr: string;
  durationMs: number;
};

export interface AgentEngine {
  readonly name: "claude_code" | "codex";
  run(request: AgentTurnRequest): Promise<AgentTurnResult>;
}

export class AgentEngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AgentEngineError";
  }
}

abstract class CliAgentEngine implements AgentEngine {
  abstract readonly name: "claude_code" | "codex";
  abstract run(request: AgentTurnRequest): Promise<AgentTurnResult>;

  constructor(protected readonly runtime: WorkspaceRuntime) {}

  protected async execute(
    request: AgentTurnRequest,
    command: string,
    args: string[],
    parser: EngineEventParser,
  ): Promise<AgentTurnResult> {
    const result = await this.runtime.exec(request.workspace, {
      command: "sh",
      args: ["-c", ENGINE_PROCESS_WRAPPER, "facility-engine", command, ...args],
      cwd: request.cwd,
      env: { ...(request.environment ?? {}), FACILITY_TURN_ID: request.turnId },
      timeoutMs: request.timeoutMs ?? 24 * 60 * 60 * 1_000,
      signal: request.signal,
      onOutput: ({ stream, data }) => {
        if (stream === "stdout") parser.push(data);
      },
    });
    parser.finish(result.stdout);
    const parsed = parser.result();
    if (result.exitCode !== 0) {
      const message = result.stderr.trim() || `${this.name} exited with status ${result.exitCode}`;
      const corruptSession =
        request.nativeSessionId &&
        /(?:session|thread).*(?:corrupt|invalid|not found|missing|unreadable|cannot resume)/i.test(
          message,
        );
      throw new AgentEngineError(
        corruptSession ? "agent_session_corrupt" : "agent_engine_failed",
        message,
        { engine: this.name, exitCode: result.exitCode, events: parsed.events },
      );
    }
    if (!parsed.sessionId) {
      throw new AgentEngineError(
        "agent_session_missing",
        `${this.name} did not return a session id`,
        {
          engine: this.name,
        },
      );
    }
    return {
      nativeSessionId: parsed.sessionId,
      output: parsed.output,
      events: parsed.events,
      exitCode: result.exitCode,
      stderr: result.stderr,
      durationMs: result.durationMs,
    };
  }
}

const ENGINE_PROCESS_WRAPPER = `set -eu
case "$FACILITY_TURN_ID" in *[!A-Za-z0-9_-]*|'') exit 64 ;; esac
marker_dir="$(dirname "$HOME")/engine-processes"
marker="$marker_dir/$FACILITY_TURN_ID.pid"
mkdir -p "$marker_dir"
"$@" &
child=$!
printf '%s' "$child" > "$marker"
forward() { kill -TERM "$child" 2>/dev/null || true; }
cleanup() { rm -f "$marker"; }
trap forward TERM INT HUP
trap cleanup EXIT
set +e
wait "$child"
status=$?
set -e
exit "$status"`;

export class ClaudeCodeEngine extends CliAgentEngine {
  readonly name = "claude_code" as const;

  async run(request: AgentTurnRequest): Promise<AgentTurnResult> {
    const args = [
      "-p",
      request.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--model",
      request.manifest.model,
    ];
    if (request.nativeSessionId) args.push("--resume", request.nativeSessionId);
    return this.execute(request, "claude", args, new ClaudeEventParser());
  }
}

export class CodexEngine extends CliAgentEngine {
  readonly name = "codex" as const;

  async run(request: AgentTurnRequest): Promise<AgentTurnResult> {
    const shared = [
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      request.manifest.model,
    ];
    const effort = request.manifest.options.reasoning_effort;
    if (effort) shared.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
    const args = request.nativeSessionId
      ? ["exec", "resume", ...shared, request.nativeSessionId, request.prompt]
      : ["exec", ...shared, request.prompt];
    return this.execute(request, "codex", args, new CodexEventParser());
  }
}

export class AgentEngineRegistry {
  private readonly engines: Map<string, AgentEngine>;

  constructor(engines: AgentEngine[]) {
    this.engines = new Map(engines.map((engine) => [engine.name, engine]));
  }

  get(name: AgentManifest["engine"]): AgentEngine {
    const engine = this.engines.get(name);
    if (!engine)
      throw new AgentEngineError("agent_engine_unavailable", `engine ${name} is unavailable`);
    return engine;
  }
}

export async function stopInterruptedEngineProcess(
  runtime: WorkspaceRuntime,
  workspace: WorkspaceLocator,
  turnId: string,
) {
  if (!/^turn_[A-Za-z0-9_-]+$/.test(turnId)) {
    throw new AgentEngineError("turn_id_invalid", "interrupted engine turn id is invalid");
  }
  const result = await runtime.exec(workspace, {
    command: "sh",
    args: ["-lc", INTERRUPTED_PROCESS_CLEANUP],
    env: { FACILITY_INTERRUPTED_TURN_ID: turnId },
    timeoutMs: 15_000,
  });
  return result.exitCode === 0 ? result.stdout.trim() || "absent" : "cleanup failed";
}

const INTERRUPTED_PROCESS_CLEANUP = [
  "set -eu",
  'marker_dir="$(dirname "$HOME")/engine-processes"',
  'marker="$marker_dir/$FACILITY_INTERRUPTED_TURN_ID.pid"',
  'if ! test -f "$marker"; then printf absent; exit 0; fi',
  'pid="$(cat "$marker")"',
  'case "$pid" in *[!0-9]*|\'\') rm -f "$marker"; printf stale-marker; exit 0 ;; esac',
  'if test -r "/proc/$pid/environ" && tr \'\\0\' \'\\n\' < "/proc/$pid/environ" | grep -Fqx "FACILITY_TURN_ID=$FACILITY_INTERRUPTED_TURN_ID"; then',
  '  kill -TERM "$pid" 2>/dev/null || true',
  "  attempt=0",
  '  while kill -0 "$pid" 2>/dev/null && test "$attempt" -lt 50; do attempt=$((attempt + 1)); sleep 0.1; done',
  '  if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi',
  "  printf stopped",
  "else",
  "  printf stale-marker",
  "fi",
  'rm -f "$marker"',
].join("\n");

type ParsedEngineEvents = {
  sessionId?: string;
  output: string;
  events: AgentTurnEvent[];
};

abstract class EngineEventParser {
  private buffer = "";
  protected readonly events: AgentTurnEvent[] = [];

  push(chunk: string) {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) this.parseLine(line);
  }

  finish(fallbackStdout = "") {
    if (this.events.length === 0 && !this.buffer && fallbackStdout) this.buffer = fallbackStdout;
    if (this.buffer.trim()) this.parseLine(this.buffer);
    this.buffer = "";
  }

  private parseLine(line: string) {
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new AgentEngineError("agent_output_invalid", "agent CLI emitted invalid JSONL", {
        line: line.slice(0, 500),
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new AgentEngineError("agent_output_invalid", "agent CLI emitted a non-object event");
    }
    this.accept(value as Record<string, unknown>);
  }

  protected abstract accept(value: Record<string, unknown>): void;
  abstract result(): ParsedEngineEvents;
}

export class ClaudeEventParser extends EngineEventParser {
  private sessionId?: string;
  private resultText?: string;
  private readonly assistantText: string[] = [];

  protected accept(value: Record<string, unknown>) {
    const type = stringValue(value.type) ?? "unknown";
    this.events.push({ engine: "claude_code", type, data: value });
    this.sessionId ??= stringValue(value.session_id);
    if (type === "result") this.resultText = stringValue(value.result) ?? this.resultText;
    if (type === "assistant") {
      const message = objectValue(value.message);
      const content = Array.isArray(message?.content) ? message.content : [];
      for (const block of content) {
        const item = objectValue(block);
        if (item?.type === "text" && typeof item.text === "string")
          this.assistantText.push(item.text);
      }
    }
  }

  result(): ParsedEngineEvents {
    return {
      sessionId: this.sessionId,
      output: this.resultText ?? this.assistantText.join("\n\n"),
      events: this.events,
    };
  }
}

export class CodexEventParser extends EngineEventParser {
  private sessionId?: string;
  private readonly messages: string[] = [];

  protected accept(value: Record<string, unknown>) {
    const type = stringValue(value.type) ?? "unknown";
    this.events.push({ engine: "codex", type, data: value });
    if (type === "thread.started") this.sessionId ??= stringValue(value.thread_id);
    if (type === "item.completed") {
      const item = objectValue(value.item);
      if (item?.type === "agent_message" && typeof item.text === "string") {
        this.messages.push(item.text);
      }
    }
  }

  result(): ParsedEngineEvents {
    return { sessionId: this.sessionId, output: this.messages.join("\n\n"), events: this.events };
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
