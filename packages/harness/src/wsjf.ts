export type WsjfInput = {
  value: number;
  time: number;
  risk: number;
  effort: number;
};

export type RankedWsjf<T> = T & { wsjf: WsjfInput & { score: number }; rank: number };

export function wsjfScore(input: WsjfInput, decimals = 2): number {
  if (!Number.isFinite(input.effort) || input.effort <= 0) {
    throw new Error("wsjf_effort_must_be_positive");
  }
  const score = (input.value + input.time + input.risk) / input.effort;
  const factor = 10 ** decimals;
  return Math.round(score * factor) / factor;
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
 * their score, or null when the body carries no parseable `## Value` section —
 * malformed blocks are treated as unscored, never as errors.
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
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const value = finiteNumber(record.value);
  const time = finiteNumber(record.time);
  const risk = finiteNumber(record.risk);
  const effort = finiteNumber(record.effort);
  if (value === null || time === null || risk === null || effort === null || effort <= 0) {
    return null;
  }
  return withWsjfScore({ value, time, risk, effort });
}

function finiteNumber(candidate: unknown): number | null {
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}
