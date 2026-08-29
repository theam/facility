import { z } from "zod";

/**
 * The canonical WSJF judgement — the only shape allowed to carry a score.
 * Components are non-negative integers and effort is strictly positive; the
 * same schema validates PO task frontmatter in chain.ts, so a judgement is
 * either canonical everywhere or scored nowhere.
 */
export const WsjfSchema = z.object({
  value: z.number().int().min(0),
  time: z.number().int().min(0),
  risk: z.number().int().min(0),
  effort: z.number().positive(),
});

export type WsjfInput = z.infer<typeof WsjfSchema>;

export type RankedWsjf<T> = T & { wsjf: WsjfInput & { score: number }; rank: number };

export function wsjfScore(input: WsjfInput, decimals = 2): number {
  if (!Number.isFinite(input.effort) || input.effort <= 0) {
    throw new Error("wsjf_effort_must_be_positive");
  }
  const score = (input.value + input.time + input.risk) / input.effort;
  const factor = 10 ** decimals;
  const rounded = Math.round(score * factor) / factor;
  // Canonical components can still overflow — huge numerators or a subnormal
  // effort divide to Infinity, which no response schema accepts.
  if (!Number.isFinite(rounded)) {
    throw new Error("wsjf_score_must_be_finite");
  }
  return rounded;
}

export function withWsjfScore(input: WsjfInput) {
  return { ...input, score: wsjfScore(input) };
}

export function rankByWsjf<T extends { wsjf: WsjfInput }>(items: T[]): Array<RankedWsjf<T>> {
  return items
    .map((item) => ({ ...item, wsjf: withWsjfScore(item.wsjf) }))
    .sort((a, b) => b.wsjf.score - a.wsjf.score)
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

/**
 * Score an untrusted candidate. Returns the canonical components with their
 * score, or null when the candidate fails the canonical schema or its score
 * is not finite — never an error, and never a value a ranking cannot hold.
 */
export function validateWsjf(candidate: unknown): (WsjfInput & { score: number }) | null {
  const parsed = WsjfSchema.safeParse(candidate);
  if (!parsed.success) return null;
  try {
    return withWsjfScore(parsed.data);
  } catch {
    return null;
  }
}

/**
 * The `## Value` section written into a GitHub issue body when a PO task is
 * accepted. This is the canonical serialisation; `parseWsjfValueSection` is its
 * inverse, so the score survives the round trip through the GitHub mirror.
 */
export function wsjfValueSection(wsjf: unknown): string {
  return `## Value

\`\`\`json
${JSON.stringify(wsjf, null, 2)}
\`\`\``;
}

const VALUE_HEADING = /^##\s+Value\s*$/m;
const NEXT_HEADING = /^##\s/m;
const FENCED_JSON = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/;

/**
 * Read a WSJF judgement back out of an issue body. Returns the components with
 * their score, or null when the body carries no `## Value` section that
 * survives the canonical schema — malformed, forged, or overflowing blocks are
 * treated as unscored, never as errors. Issue bodies are world-writable, so a
 * parsed judgement identifies what the block claims; it is not provenance.
 * Anything that ranks stories must bind to the task record Facility itself
 * wrote (see the API's pipeline assembly).
 */
export function parseWsjfValueSection(
  body: string | null | undefined,
): (WsjfInput & { score: number }) | null {
  if (!body) return null;
  const heading = VALUE_HEADING.exec(body);
  if (!heading) return null;
  let section = body.slice(heading.index + heading[0].length);
  const next = NEXT_HEADING.exec(section);
  if (next) section = section.slice(0, next.index);
  const fence = FENCED_JSON.exec(section);
  if (!fence?.[1]) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fence[1]);
  } catch {
    return null;
  }
  return validateWsjf(parsed);
}
