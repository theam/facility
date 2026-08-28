import type { StoryWsjf } from "@/lib/pipeline";
import { wsjfBreakdown } from "@/lib/pipeline";

/**
 * The score chip discloses the components behind a story's rank. A native
 * details/summary keeps that provenance reachable by keyboard (focus, then
 * Enter or Space), touch (tap), and assistive tech (the summary reports its
 * expanded state) — a title tooltip alone serves only mouse hover.
 */
export function WsjfChip({ wsjf }: { wsjf: StoryWsjf }) {
  return (
    <details className="relative">
      <summary
        aria-label={`WSJF score ${wsjf.score} — show breakdown`}
        className="cursor-pointer list-none border border-(--line) px-1.5 py-0.5 font-mono text-[10px] text-(--mut) select-none [&::-webkit-details-marker]:hidden"
      >
        wsjf {wsjf.score}
      </summary>
      <p className="absolute top-full left-0 z-10 mt-1 border border-(--line) bg-(--card) px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap text-(--mut)">
        {wsjfBreakdown(wsjf)}
      </p>
    </details>
  );
}
