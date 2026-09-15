/**
 * Readable projection of a stored turn event. The raw event stays available on
 * its own endpoint; this projection is what conversation and timeline surfaces
 * page through, so every item is bounded regardless of the stored payload size.
 *
 * Only activity the engine exposes legitimately is described here: progress
 * messages, tool and command use, reasoning summaries, results and lifecycle
 * events. Nothing is inferred or reconstructed from missing data.
 */

export const ACTIVITY_TEXT_LIMIT = 2_000;

/** Stored event types that carry no standalone information for readers. */
export const ACTIVITY_NOISE_TYPES = ["engine.item.updated", "engine.stream_event"] as const;

export type ActivityKind =
  | "message"
  | "reasoning"
  | "tool"
  | "command"
  | "file_change"
  | "result"
  | "lifecycle"
  | "error"
  | "session"
  | "other";

export type ActivityItem = {
  seq: number;
  turn_id: string;
  type: string;
  kind: ActivityKind;
  title: string;
  text: string | null;
  truncated: boolean;
  size_bytes: number;
  created_at: Date;
};

type StoredTurnEvent = {
  turnId: string;
  seq: number;
  type: string;
  data: unknown;
  createdAt: Date;
};

export function presentTurnEvent(event: StoredTurnEvent): ActivityItem {
  const data = record(event.data);
  const sizeBytes = Buffer.byteLength(JSON.stringify(event.data ?? {}), "utf8");
  const described = describe(event.type, data);
  const bounded = bound(described.text);
  return {
    seq: event.seq,
    turn_id: event.turnId,
    type: event.type,
    kind: described.kind,
    title: described.title,
    text: bounded.text,
    truncated: bounded.truncated || data.truncated === true,
    size_bytes: sizeBytes,
    created_at: event.createdAt,
  };
}

function describe(
  type: string,
  data: Record<string, unknown>,
): {
  kind: ActivityKind;
  title: string;
  text: string | null;
} {
  if (data.truncated === true && typeof data.payload === "string") {
    return {
      kind: "other",
      title: `${humanType(type)} (stored truncated)`,
      text: data.payload,
    };
  }
  switch (type) {
    case "turn.started":
      return { kind: "lifecycle", title: "Run started", text: null };
    case "turn.succeeded":
      return {
        kind: "lifecycle",
        title: "Run completed",
        text: typeof data.durationMs === "number" ? `Duration ${duration(data.durationMs)}` : null,
      };
    case "turn.failed":
      return { kind: "error", title: "Run failed", text: text(data.error) };
    case "turn.canceled":
      return { kind: "lifecycle", title: "Run canceled", text: null };
    case "turn.cancel_requested":
      return { kind: "lifecycle", title: "Cancellation requested", text: text(data.reason) };
    case "turn.worker_interrupted":
      return {
        kind: "error",
        title: "Worker interrupted",
        text: text(data.reason) ?? text(data.error),
      };
    case "queue.activation_failed":
      return {
        kind: "error",
        title: `Could not start the queued ${text(data.agentName) ?? "agent"} run`,
        text: text(data.error),
      };
    case "engine.session_corrupt":
      return {
        kind: "session",
        title: "Native session could not be resumed",
        text: text(data.sessionId) ? `Session ${text(data.sessionId)}` : null,
      };
    default:
      break;
  }
  if (type.startsWith("engine.")) return describeEngineEvent(type.slice("engine.".length), data);
  return { kind: "other", title: humanType(type), text: null };
}

function describeEngineEvent(
  type: string,
  data: Record<string, unknown>,
): { kind: ActivityKind; title: string; text: string | null } {
  // Claude Code stream-json
  if (type === "system") {
    const model = text(data.model);
    return {
      kind: "session",
      title: text(data.subtype) === "init" ? "Session started" : "Engine notice",
      text: model ? `Model ${model}` : null,
    };
  }
  if (type === "assistant") {
    const blocks = Array.isArray(record(data.message).content)
      ? (record(data.message).content as unknown[])
      : [];
    const tools = blocks.map(record).filter((block) => block.type === "tool_use");
    const texts = blocks
      .map(record)
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => String(block.text));
    if (tools.length > 0) {
      const names = tools.map((tool) => text(tool.name) ?? "tool");
      const input = tools.length === 1 ? summarizeToolInput(record(tools[0]?.input)) : null;
      return {
        kind: "tool",
        title: names.length === 1 ? `Used ${names[0]}` : `Used ${names.join(", ")}`,
        text: [texts.join("\n\n"), input].filter(Boolean).join("\n\n") || null,
      };
    }
    return { kind: "message", title: "Agent message", text: texts.join("\n\n") || null };
  }
  if (type === "user") {
    const blocks = Array.isArray(record(data.message).content)
      ? (record(data.message).content as unknown[])
      : [];
    const results = blocks.map(record).filter((block) => block.type === "tool_result");
    if (results.length === 0) return { kind: "other", title: "Engine input", text: null };
    const errored = results.some((result) => result.is_error === true);
    return {
      kind: errored ? "error" : "tool",
      title: errored ? "Tool reported an error" : "Tool result",
      text:
        results
          .map((result) => contentText(result.content))
          .filter(Boolean)
          .join("\n\n") || null,
    };
  }
  if (type === "result") {
    const isError = data.is_error === true;
    const subtype = text(data.subtype);
    return {
      kind: isError ? "error" : "result",
      title: isError
        ? `Engine finished with an error${subtype ? ` (${subtype})` : ""}`
        : "Final response",
      text: text(data.result),
    };
  }
  // Codex JSONL
  if (type === "thread.started") {
    return {
      kind: "session",
      title: "Session started",
      text: text(data.thread_id) ? `Thread ${text(data.thread_id)}` : null,
    };
  }
  if (type === "turn.started")
    return { kind: "lifecycle", title: "Engine turn started", text: null };
  if (type === "turn.completed")
    return { kind: "lifecycle", title: "Engine turn completed", text: null };
  if (type === "turn.failed" || type === "error") {
    const error = record(data.error);
    return {
      kind: "error",
      title: "Engine reported an error",
      text: text(error.message) ?? text(data.message),
    };
  }
  if (type === "item.started" || type === "item.completed") {
    return describeCodexItem(type === "item.started", record(data.item));
  }
  return { kind: "other", title: humanType(type), text: null };
}

function describeCodexItem(
  started: boolean,
  item: Record<string, unknown>,
): { kind: ActivityKind; title: string; text: string | null } {
  const itemType = text(item.type) ?? "item";
  switch (itemType) {
    case "agent_message":
      return { kind: "message", title: "Agent message", text: text(item.text) };
    case "reasoning":
      return { kind: "reasoning", title: "Reasoning summary", text: text(item.text) };
    case "command_execution": {
      const command = text(item.command) ?? "command";
      if (started) return { kind: "command", title: "Running command", text: command };
      const exitCode = typeof item.exit_code === "number" ? item.exit_code : null;
      const status = text(item.status);
      const outcome =
        exitCode === null ? (status ?? "finished") : exitCode === 0 ? "exit 0" : `exit ${exitCode}`;
      return {
        kind: exitCode !== null && exitCode !== 0 ? "error" : "command",
        title: `Command ${outcome}`,
        text: [command, text(item.aggregated_output)].filter(Boolean).join("\n\n") || null,
      };
    }
    case "file_change": {
      const changes = Array.isArray(item.changes) ? item.changes.map(record) : [];
      const lines = changes
        .map((change) => `${text(change.kind) ?? "changed"} ${text(change.path) ?? ""}`.trim())
        .filter(Boolean);
      return {
        kind: "file_change",
        title: started
          ? "Changing files"
          : `Changed ${changes.length} file${changes.length === 1 ? "" : "s"}`,
        text: lines.join("\n") || null,
      };
    }
    case "mcp_tool_call": {
      const name = [text(item.server), text(item.tool)].filter(Boolean).join(" · ") || "tool";
      return {
        kind: "tool",
        title: started ? `Calling ${name}` : `Called ${name}`,
        text: text(item.status) ? `Status ${text(item.status)}` : null,
      };
    }
    case "web_search":
      return { kind: "tool", title: "Web search", text: text(item.query) };
    case "todo_list": {
      const items = Array.isArray(item.items) ? item.items.map(record) : [];
      return {
        kind: "other",
        title: "Plan updated",
        text:
          items
            .map((entry) => `${entry.completed === true ? "[x]" : "[ ]"} ${text(entry.text) ?? ""}`)
            .join("\n") || null,
      };
    }
    case "error":
      return { kind: "error", title: "Engine reported an error", text: text(item.message) };
    default:
      return {
        kind: "other",
        title: `${started ? "Started" : "Completed"} ${itemType.replaceAll("_", " ")}`,
        text: null,
      };
  }
}

function summarizeToolInput(input: Record<string, unknown>) {
  const preferred = ["command", "file_path", "path", "pattern", "query", "url", "description"];
  for (const key of preferred) {
    const value = text(input[key]);
    if (value) return value;
  }
  const keys = Object.keys(input);
  return keys.length > 0 ? JSON.stringify(input) : null;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map(record)
      .map((block) => (block.type === "text" ? text(block.text) : null))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function bound(value: string | null): { text: string | null; truncated: boolean } {
  if (value === null) return { text: null, truncated: false };
  if (value.length <= ACTIVITY_TEXT_LIMIT) return { text: value, truncated: false };
  return { text: `${value.slice(0, ACTIVITY_TEXT_LIMIT)}…`, truncated: true };
}

function humanType(type: string) {
  return type.replaceAll(".", " ").replaceAll("_", " ");
}

function duration(ms: number) {
  if (ms < 1_000) return `${ms} ms`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${seconds % 60} s`;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
