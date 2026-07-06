import type { RunEvent } from "./types.js";

export function parseClaudeStreamJsonLine(line: string): RunEvent | null {
  const parsed = parseJson(line);
  if (!parsed) return null;
  const type = stringField(parsed, "type");
  if (type === "assistant" || type === "assistant_message") {
    const text = extractText(parsed);
    return text ? { type: "assistant", data: { text } } : null;
  }
  if (type === "tool_use") {
    return { type: "tool", data: toolData(parsed) };
  }
  if (type === "result") {
    return { type: "engine_result", data: parsed };
  }
  if (type === "system") {
    return { type: "system", data: parsed };
  }
  return { type: "engine", data: parsed };
}

export function parseCodexJsonlLine(line: string): RunEvent | null {
  const parsed = parseJson(line);
  if (!parsed) return null;
  const type = stringField(parsed, "type") ?? stringField(parsed, "event");
  if (type === "assistant_message" || type === "assistant") {
    const text = extractText(parsed);
    return text ? { type: "assistant", data: { text } } : null;
  }
  if (type === "tool_call" || type === "tool_use") {
    return { type: "tool", data: toolData(parsed) };
  }
  if (type === "task_complete" || type === "result") {
    return { type: "engine_result", data: parsed };
  }
  return { type: "engine", data: parsed };
}

export function parseClaudeSessionId(line: string): string | null {
  const parsed = parseJson(line);
  if (!parsed) return null;
  const type = stringField(parsed, "type");
  if (type !== "system" && type !== "init" && type !== "result") return null;
  return stringField(parsed, "session_id") ?? stringField(parsed, "sessionId");
}

export function parseCodexSessionId(line: string): string | null {
  const parsed = parseJson(line);
  if (!parsed) return null;
  return (
    stringField(parsed, "session_id") ??
    stringField(parsed, "sessionId") ??
    stringField(parsed, "thread_id") ??
    stringField(parsed, "threadId") ??
    stringField(parsed, "conversation_id") ??
    stringField(parsed, "conversationId")
  );
}

function toolData(value: Record<string, unknown>) {
  const input = value.input ?? value.arguments ?? value.args ?? {};
  return {
    name: stringField(value, "name") ?? stringField(value, "tool") ?? "unknown",
    input: truncate(JSON.stringify(input)),
  };
}

function extractText(value: Record<string, unknown>): string | null {
  const nested = value.message;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return extractText(nested as Record<string, unknown>);
  }
  const direct = value.text ?? value.message ?? value.content;
  if (typeof direct === "string") return direct;
  if (Array.isArray(direct)) {
    const text = direct
      .map((item) =>
        item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
          ? (item as { text: string }).text
          : "",
      )
      .filter(Boolean)
      .join("\n");
    return text || null;
  }
  return null;
}

function truncate(value: string) {
  return value.length > 500 ? `${value.slice(0, 500)}...` : value;
}

function stringField(value: Record<string, unknown>, key: string) {
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : null;
}

function parseJson(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
