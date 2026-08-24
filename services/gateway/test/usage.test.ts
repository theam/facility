import { describe, expect, it } from "vitest";
import { UsageTee } from "../src/usage.js";

const MESSAGE_START =
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1000,"cache_read_input_tokens":40,"cache_creation_input_tokens":25}}}\n\n';
const CONTENT_DELTA =
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"ok"}}\n\n';
const MESSAGE_DELTA =
  'event: message_delta\ndata: {"type":"message_delta","delta":{"usage":{"output_tokens":700}}}\n\n';

describe("UsageTee anthropic streaming usage", () => {
  it("meters input and cache tokens reported by message_start", async () => {
    const tee = new UsageTee("anthropic");
    await feed(tee, [MESSAGE_START, CONTENT_DELTA, MESSAGE_DELTA]);

    expect(tee.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 700,
      cacheReadTokens: 40,
      cacheWriteTokens: 25,
    });
  });

  it("keeps message_start input tokens when message_delta reports only output", async () => {
    const tee = new UsageTee("anthropic");
    await feed(tee, [MESSAGE_START, MESSAGE_DELTA]);

    // The output-only frame arrives last; it must not erase the earlier fields.
    expect(tee.usage.inputTokens).toBe(1000);
    expect(tee.usage.cacheReadTokens).toBe(40);
    expect(tee.usage.outputTokens).toBe(700);
  });

  it("meters usage from frames split across chunk boundaries", async () => {
    const tee = new UsageTee("anthropic");
    const stream = MESSAGE_START + CONTENT_DELTA + MESSAGE_DELTA;
    // Single-byte chunks split every frame, including the "\n\n" terminator.
    const passthrough = await feed(tee, [...stream]);

    expect(passthrough).toBe(stream);
    expect(tee.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 700,
      cacheReadTokens: 40,
      cacheWriteTokens: 25,
    });
  });

  it("passes malformed frames through and still meters the valid ones", async () => {
    const tee = new UsageTee("anthropic");
    const malformed = 'event: message_start\ndata: {"type":"message_start","message":\n\n';
    const stream = malformed + MESSAGE_START + MESSAGE_DELTA;
    const passthrough = await feed(tee, [stream]);

    expect(passthrough).toBe(stream);
    expect(tee.usage.inputTokens).toBe(1000);
    expect(tee.usage.outputTokens).toBe(700);
  });

  it("still meters a non-streamed body reporting a top-level usage", async () => {
    const tee = new UsageTee("anthropic");
    await feed(tee, [JSON.stringify({ usage: { input_tokens: 12, output_tokens: 34 } })]);

    expect(tee.usage.inputTokens).toBe(12);
    expect(tee.usage.outputTokens).toBe(34);
  });
});

async function feed(tee: UsageTee, chunks: string[]): Promise<string> {
  const seen: Buffer[] = [];
  tee.on("data", (chunk: Buffer) => seen.push(chunk));
  for (const chunk of chunks) tee.write(Buffer.from(chunk, "utf8"));
  tee.end();
  await new Promise((resolve) => tee.once("end", resolve));
  return Buffer.concat(seen).toString("utf8");
}
