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
