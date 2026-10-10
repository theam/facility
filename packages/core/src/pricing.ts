export type ModelPrice = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
};

export const MODEL_PRICES_USD_PER_1M = {
  // Standard global API rates, with 5-minute cache writes (verified 2026-09-29).
  // https://platform.claude.com/docs/en/about-claude/pricing
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-fable-5": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-opus-4-8": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-sonnet-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  "gpt-5.5": { input: 10, output: 30, cacheRead: 1, cacheWrite: 10 },
  "gpt-5.5-mini": { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.25 },
  "gpt-5.6-sol": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
  "gpt-5.6-terra": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 },
  "gpt-5.6-luna": { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 },
  custom: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as const satisfies Record<string, ModelPrice>;

export type CostInput = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

const MODEL_ALIASES: Record<string, keyof typeof MODEL_PRICES_USD_PER_1M> = {
  "claude-3-5-haiku": "claude-haiku-4-5",
  "gpt-5.6": "gpt-5.6-sol",
};

/** Resolve aliases and provider date suffixes to a price-book entry. */
export function normalizeModel(model: string): keyof typeof MODEL_PRICES_USD_PER_1M | null {
  if (model in MODEL_PRICES_USD_PER_1M) {
    return model as keyof typeof MODEL_PRICES_USD_PER_1M;
  }
  if (model in MODEL_ALIASES) return MODEL_ALIASES[model] ?? null;
  const undated = model.replace(/-\d{8}$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
  return undated in MODEL_PRICES_USD_PER_1M
    ? (undated as keyof typeof MODEL_PRICES_USD_PER_1M)
    : null;
}

/**
 * Tokens held against the monthly budget before measured usage replaces them.
 * Cache writes are included because the first turn of a session pays them;
 * later turns are usually cheaper, so this estimate blocks work that cannot
 * afford a full turn rather than a short follow-up.
 */
export const TURN_RESERVATION_TOKENS = {
  inputTokens: 100_000,
  outputTokens: 8_000,
  cacheWriteTokens: 100_000,
} as const;

/** Title calls send a short excerpt and expect a single line back. */
export const TITLE_RESERVATION_TOKENS = {
  inputTokens: 8_000,
  outputTokens: 256,
} as const;

export function reservationCents(model: string, purpose: "turn" | "title"): number | null {
  const tokens = purpose === "turn" ? TURN_RESERVATION_TOKENS : TITLE_RESERVATION_TOKENS;
  return costCents({ model, ...tokens });
}

/** Calculate cents with six decimal places so low-token turns are not rounded away. */
export function costCents(input: CostInput): number | null {
  const key = normalizeModel(input.model);
  const price = key ? MODEL_PRICES_USD_PER_1M[key] : undefined;
  if (!price) return null;
  const usd =
    (input.inputTokens / 1_000_000) * price.input +
    (input.outputTokens / 1_000_000) * price.output +
    ((input.cacheReadTokens ?? 0) / 1_000_000) * (price.cacheRead ?? 0) +
    ((input.cacheWriteTokens ?? 0) / 1_000_000) * (price.cacheWrite ?? 0);
  return Math.round(usd * 100_000_000) / 1_000_000;
}

export function displayCents(cents: number): number {
  return Math.floor(cents + 0.5);
}
