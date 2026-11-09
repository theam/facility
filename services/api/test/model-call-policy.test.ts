import { describe, expect, it, vi } from "vitest";
import { modelCallFingerprint, validModelUsage } from "../src/insights/model-calls.js";
import { callTitleProvider } from "../src/stories/titles.js";

const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const request = {
  provider: "openai" as const,
  model: "gpt-5.5-mini",
  apiKey: "synthetic-secret",
  request: "Synthetic request",
};

describe("API model-call billing policy", () => {
  it("distinguishes measured zero from absent, fractional, negative or unsafe counters", () => {
    expect(validModelUsage(zero)).toBe(true);
    for (const invalid of [undefined, null, {}, { inputTokens: 0, outputTokens: 0 }])
      expect(validModelUsage(invalid)).toBe(false);
    for (const key of Object.keys(zero))
      for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "0", null])
        expect(validModelUsage({ ...zero, [key]: value })).toBe(false);
  });

  it("binds a durable request identity to the model and exact prompt without retaining plaintext", () => {
    const identity = { model: request.model, instructions: "Name work", request: request.request };
    const fingerprint = modelCallFingerprint(identity);
    expect(fingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(modelCallFingerprint(identity)).toBe(fingerprint);
    expect(modelCallFingerprint({ ...identity, model: "another-model" })).not.toBe(fingerprint);
    expect(modelCallFingerprint({ ...identity, request: "A correction" })).not.toBe(fingerprint);
    expect(fingerprint).not.toContain(request.request);
  });

  it("keeps real zero usage and subtracts cached OpenAI input exactly once", async () => {
    const complete = (usage: object) =>
      callTitleProvider(request, async () =>
        Response.json({ choices: [{ message: { content: "Title" } }], usage }),
      );
    await expect(complete({ prompt_tokens: 0, completion_tokens: 0 })).resolves.toEqual({
      title: "Title",
      inputTokens: 0,
      outputTokens: 0,
    });
    await expect(
      complete({
        prompt_tokens: 100,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 40 },
      }),
    ).resolves.toEqual({ title: "Title", inputTokens: 60, outputTokens: 10, cacheReadTokens: 40 });
  });

  it("preserves Anthropic's separate fresh, cache-read and cache-write counters", async () => {
    await expect(
      callTitleProvider(
        { ...request, provider: "anthropic", model: "claude-haiku-4-5" },
        async () =>
          Response.json({
            content: [{ type: "text", text: "Title" }],
            usage: {
              input_tokens: 12,
              output_tokens: 3,
              cache_read_input_tokens: 40,
              cache_creation_input_tokens: 20,
            },
          }),
      ),
    ).resolves.toEqual({
      title: "Title",
      inputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 40,
      cacheWriteTokens: 20,
    });
  });

  it.each([
    {},
    { prompt_tokens: 1 },
    { prompt_tokens: -1, completion_tokens: 1 },
    { prompt_tokens: "1", completion_tokens: 1 },
    { prompt_tokens: 1, completion_tokens: 0.5 },
    { prompt_tokens: 1, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 2 } },
  ])("retains uncertainty for malformed usage %j", async (usage) => {
    await expect(
      callTitleProvider(request, async () =>
        Response.json({ choices: [{ message: { content: "Title" } }], usage }),
      ),
    ).rejects.toMatchObject({
      code: "provider_response_invalid",
      billing: { certainty: "unconfirmed" },
    });
  });

  it("retains a measured charge even when the provider produces no usable title", async () => {
    await expect(
      callTitleProvider(request, async () =>
        Response.json({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 10 } }),
      ),
    ).rejects.toMatchObject({
      code: "provider_response_invalid",
      billing: {
        certainty: "confirmed",
        usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    });
  });

  it.each([
    401, 403, 429, 500, 503,
  ])("does not repeat HTTP %i and records its billing certainty", async (status) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("synthetic-secret", { status }));
    const error = await callTitleProvider(request, fetchImpl).catch((error: unknown) => error);
    expect(error).toMatchObject({
      billing: { certainty: status === 401 || status === 403 ? "unbilled" : "unconfirmed" },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("synthetic-secret");
  });

  it("treats network loss and invalid JSON as potentially billed attempts", async () => {
    for (const fetchImpl of [
      async () => {
        throw new DOMException("synthetic-secret", "AbortError");
      },
      async () => new Response("invalid JSON"),
    ])
      await expect(callTitleProvider(request, fetchImpl)).rejects.toMatchObject({
        billing: { certainty: "unconfirmed" },
      });
  });
});
