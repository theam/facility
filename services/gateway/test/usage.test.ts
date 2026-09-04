import { describe, expect, it } from "vitest";
import { UsageTee } from "../src/usage.js";

const MESSAGE_START =
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1000,"cache_read_input_tokens":40,"cache_creation_input_tokens":25}}}\n\n';
const CONTENT_DELTA =
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"ok"}}\n\n';
const MESSAGE_DELTA =
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":700}}\n\n';

// OpenAI speaks two dialects. Chat Completions names the buckets
// prompt/completion and reports usage on a final chunk requested through
// stream_options.include_usage; the Responses API - the wire Codex speaks -
// names them input/output and nests usage inside the response.completed
// envelope, never at the frame's top level. Both report input INCLUSIVE of
// cached tokens, while costCents sums the buckets additively.
const CHAT_CONTENT_DELTA = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n';
const CHAT_USAGE_FINAL =
  'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":700,"prompt_tokens_details":{"cached_tokens":400}}}\n\n';
const CHAT_DONE = "data: [DONE]\n\n";
const RESPONSES_CREATED = 'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n';
const RESPONSES_COMPLETED =
  'data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":1000,"output_tokens":700,"input_tokens_details":{"cached_tokens":400}}}}\n\n';

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
    expect(tee.usageComplete).toBe(true);
  });

  it("does not mark anthropic streams complete until the terminal message_delta arrives", async () => {
    const tee = new UsageTee("anthropic");
    await feed(tee, [MESSAGE_START]);

    expect(tee.usage.inputTokens).toBe(1000);
    expect(tee.usageComplete).toBe(false);
  });

  it("marks anthropic streams complete once message_delta reports output usage", async () => {
    const tee = new UsageTee("anthropic");
    await feed(tee, [MESSAGE_START, MESSAGE_DELTA]);

    expect(tee.usageComplete).toBe(true);
  });
});

describe("UsageTee openai streaming usage", () => {
  it("meters the chat completions naming and bills cached tokens once", async () => {
    const tee = new UsageTee("openai");
    await feed(tee, [CHAT_CONTENT_DELTA, CHAT_USAGE_FINAL, CHAT_DONE]);

    // Reading only input_tokens/output_tokens meters this stream at zero, which
    // is a hard-budget bypass: nothing accumulates against the reservation.
    // prompt_tokens is inclusive of the 400 cached, so input is the 600 that
    // were actually processed - leaving 1000 bills those 400 at the input rate
    // on top of the cache-read rate.
    expect(tee.usage).toEqual({
      inputTokens: 600,
      outputTokens: 700,
      cacheReadTokens: 400,
      cacheWriteTokens: 0,
    });
  });

  it("meters usage nested in the response.completed envelope", async () => {
    const tee = new UsageTee("openai");
    await feed(tee, [RESPONSES_CREATED, RESPONSES_COMPLETED]);

    // Codex streams here. Usage never appears at the frame's top level, so
    // reading only the frame meters the whole run at zero. The earlier
    // response.created frame carries no usage and must not erase the total.
    expect(tee.usage).toEqual({
      inputTokens: 600,
      outputTokens: 700,
      cacheReadTokens: 400,
      cacheWriteTokens: 0,
    });
  });

  it("still meters a non-streamed body using the chat completions naming", async () => {
    const tee = new UsageTee("openai");
    await feed(tee, [JSON.stringify({ usage: { prompt_tokens: 12, completion_tokens: 34 } })]);

    // No cached details here: input stays as reported rather than becoming
    // undefined, which is what a naive subtraction would produce.
    expect(tee.usage.inputTokens).toBe(12);
    expect(tee.usage.outputTokens).toBe(34);
    expect(tee.usage.cacheReadTokens).toBe(0);
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
