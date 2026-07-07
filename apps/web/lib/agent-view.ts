import type { Semantic } from "@facility/ui";
import type { AgentStatus } from "@/lib/api";
import { cronToWords } from "@/lib/schedule";

/** Pure view derivations shared by server (loop) and client (table/detail) surfaces. */

export function agentHealth(status: AgentStatus): { tone: Semantic; pulse: boolean; word: string } {
  if (!status.enabled) return { tone: "machine", pulse: false, word: "off" };
  if (status.liveRun) {
    // Queued is not working — never show the yellow pulse for a session
    // that hasn't started.
    if (status.liveRun.status === "awaiting_human")
      return { tone: "human", pulse: false, word: "waiting on you" };
    if (status.liveRun.status === "queued") return { tone: "info", pulse: false, word: "queued" };
    return { tone: "agent", pulse: true, word: "working now" };
  }
  if (status.lastRun?.status === "failed") return { tone: "bad", pulse: false, word: "failing" };
  if (status.lastRun?.status === "awaiting_human")
    return { tone: "human", pulse: false, word: "waiting on you" };
  if (status.counts14d.failed > 0) return { tone: "info", pulse: false, word: "mixed" };
  return { tone: "ok", pulse: false, word: "healthy" };
}

export function triggerSummary(status: AgentStatus): string {
  const parts: string[] = [];
  if (status.schedule) parts.push(cronToWords(status.schedule.cron, status.schedule.timezone));
  const liveBindings = status.eventBindings.filter((b) => b.enabled && b.dispatchesRuns);
  if (liveBindings.length > 0) {
    parts.push(
      liveBindings.length === 1
        ? `on ${liveBindings[0]?.name} events`
        : `${liveBindings.length} event sources`,
    );
  }
  if (parts.length === 0) parts.push("on demand");
  return parts.join(" · ");
}
