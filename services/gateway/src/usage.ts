import { Transform, type TransformCallback } from "node:stream";
import type { Provider, Usage } from "./types.js";

const MAX_RETAINED_RESPONSE_BYTES = 256 * 1024;
const TRUNCATED_MARKER = "\n[facility:response_truncated]\n";

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function mergeUsage(target: Usage, usage: Partial<Usage>) {
  target.inputTokens = usage.inputTokens ?? target.inputTokens;
  target.outputTokens = usage.outputTokens ?? target.outputTokens;
  target.cacheReadTokens = usage.cacheReadTokens ?? target.cacheReadTokens;
  target.cacheWriteTokens = usage.cacheWriteTokens ?? target.cacheWriteTokens;
}

export function usageFromJson(provider: Provider, body: unknown): Partial<Usage> {
  if (!body || typeof body !== "object") return {};
  const usage = (body as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return {};
  const row = usage as Record<string, unknown>;
  if (provider === "anthropic") {
    return {
      inputTokens: numberValue(row.input_tokens),
      outputTokens: numberValue(row.output_tokens),
      cacheReadTokens: numberValue(row.cache_read_input_tokens),
      cacheWriteTokens: numberValue(row.cache_creation_input_tokens),
    };
  }
  // OpenAI's two APIs name usage differently: Responses reports
  // input_tokens/output_tokens (details under input_tokens_details), Chat
  // Completions prompt_tokens/completion_tokens (prompt_tokens_details).
  // Both report input INCLUSIVE of cached tokens, while costCents sums the
  // buckets additively in the Anthropic convention - so cached tokens are
  // subtracted from input here, or they would be billed twice.
  const inputInclusive = numberValue(row.input_tokens) ?? numberValue(row.prompt_tokens);
  const cacheRead =
    nestedNumber(row.input_tokens_details, "cached_tokens") ??
    nestedNumber(row.prompt_tokens_details, "cached_tokens");
  return {
    inputTokens:
      inputInclusive !== undefined && cacheRead !== undefined
        ? Math.max(0, inputInclusive - cacheRead)
        : inputInclusive,
    outputTokens: numberValue(row.output_tokens) ?? numberValue(row.completion_tokens),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: nestedNumber(row.input_tokens_details, "cache_creation_tokens"),
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nestedNumber(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  return numberValue((value as Record<string, unknown>)[key]);
}

export class UsageTee extends Transform {
  readonly usage = emptyUsage();
  usageComplete = false;
  readonly textParts: string[] = [];
  private pending = "";
  private retainedBytes = 0;
  private retainedTruncated = false;

  constructor(private provider: Provider) {
    super();
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    const text = chunk.toString("utf8");
    this.retainText(chunk);
    this.appendPending(text);
    this.parsePending();
    this.push(chunk);
    callback();
  }

  _flush(callback: TransformCallback) {
    this.parsePending(true);
    callback();
  }

  responseBody(contentType: string | undefined): unknown {
    const text = this.textParts.join("");
    if (contentType?.includes("application/json")) {
      try {
        return JSON.parse(text);
      } catch {
        return { raw: text };
      }
    }
    return { raw: text, usage: this.usage };
  }

  private parsePending(force = false) {
    while (true) {
      const index = this.pending.indexOf("\n\n");
      if (index === -1) break;
      const frame = this.pending.slice(0, index);
      this.pending = this.pending.slice(index + 2);
      this.parseSseFrame(frame);
    }
    if (force && this.pending.trim()) {
      this.parseJsonText(this.pending);
      this.pending = "";
    }
  }

  private parseSseFrame(frame: string) {
    const dataLines = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart());
    for (const data of dataLines) {
      if (!data || data === "[DONE]") continue;
      this.parseJsonText(data);
    }
  }

  private parseJsonText(text: string) {
    try {
      const parsed = JSON.parse(text);
      this.noteTerminalUsage(parsed);
      if (this.provider === "anthropic") {
        // Anthropic splits streamed usage across frames: `message_start` carries
        // input and cache tokens under `message.usage`, and `message_delta`
        // reports output tokens in a top-level `usage` — a sibling of `delta`,
        // which itself carries only the stop fields. A non-streamed body also
        // reports everything under a top-level `usage`. Merge each source
        // separately rather than spreading them into one object: a spread
        // copies absent keys as `undefined` and would drop an earlier frame's
        // input tokens when the later frame reports only output. The
        // `parsed.delta` source stays as tolerance for relays that nest usage
        // inside the delta.
        for (const source of [parsed, parsed?.message, parsed?.delta]) {
          mergeUsage(this.usage, usageFromJson("anthropic", source));
        }
      } else {
        // OpenAI streamed shapes: Chat Completions puts usage on the final
        // chunk's top level (requested via stream_options.include_usage),
        // while the Responses API - the wire Codex speaks - nests it inside
        // the response.completed envelope ({"type":"response.completed",
        // "response":{"usage":{...}}}) and never at the frame's top level.
        for (const source of [parsed, (parsed as { response?: unknown })?.response]) {
          mergeUsage(this.usage, usageFromJson("openai", source));
        }
      }
    } catch {
      // Provider bytes are still passed through; malformed telemetry frames only affect metering.
    }
  }

  private noteTerminalUsage(parsed: unknown) {
    if (!parsed || typeof parsed !== "object") return;
    const row = parsed as Record<string, unknown>;
    if (this.provider === "anthropic" && row.type === "message_delta") {
      const usage = row.usage;
      if (usage && typeof usage === "object") {
        const output = (usage as Record<string, unknown>).output_tokens;
        if (typeof output === "number" && Number.isFinite(output)) {
          this.usageComplete = true;
        }
      }
      return;
    }
    const usage = row.usage;
    if (!usage || typeof usage !== "object") return;
    const output = (usage as Record<string, unknown>).output_tokens;
    if (typeof output === "number" && Number.isFinite(output)) {
      this.usageComplete = true;
    }
  }

  private retainText(chunk: Buffer) {
    if (this.retainedTruncated) return;
    const remaining = MAX_RETAINED_RESPONSE_BYTES - this.retainedBytes;
    if (chunk.byteLength <= remaining) {
      this.textParts.push(chunk.toString("utf8"));
      this.retainedBytes += chunk.byteLength;
      return;
    }
    if (remaining > 0) {
      this.textParts.push(chunk.subarray(0, remaining).toString("utf8"));
      this.retainedBytes += remaining;
    }
    this.textParts.push(TRUNCATED_MARKER);
    this.retainedTruncated = true;
  }

  private appendPending(text: string) {
    if (this.pending.length > MAX_RETAINED_RESPONSE_BYTES) return;
    this.pending += text;
    if (Buffer.byteLength(this.pending, "utf8") > MAX_RETAINED_RESPONSE_BYTES) {
      this.pending = this.pending.slice(0, MAX_RETAINED_RESPONSE_BYTES);
    }
  }
}
