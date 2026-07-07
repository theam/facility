import type { SessionRow } from "@/components/sessions/session-table";
import type { Run } from "@/lib/api";

function costOf(receipt: unknown): number | null {
  const usage =
    receipt && typeof receipt === "object" ? (receipt as { usage?: unknown }).usage : null;
  const cents =
    usage && typeof usage === "object" ? (usage as { cost_cents?: unknown }).cost_cents : null;
  return typeof cents === "number" ? cents : null;
}

function prOf(gh: unknown): string | null {
  const pr = gh && typeof gh === "object" ? (gh as { pr?: unknown }).pr : null;
  if (typeof pr === "string") return pr;
  if (pr && typeof pr === "object" && typeof (pr as { url?: unknown }).url === "string") {
    return (pr as { url: string }).url;
  }
  return null;
}

/** Flatten runs into the session-table view model (server-side). */
export function toSessionRows(
  runs: Array<Run & { project?: { id: string; slug: string } }>,
  agentNames: Map<string, string> = new Map(),
): SessionRow[] {
  return runs.map((run) => ({
    id: run.id,
    projectId: run.project?.id ?? run.projectId,
    projectSlug: run.project?.slug,
    mode: run.mode,
    agentName: run.agentDefId ? (agentNames.get(run.agentDefId) ?? null) : null,
    engine: run.engine,
    status: run.status,
    queuedAt: run.queuedAt,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    costCents: costOf(run.receipt),
    prUrl: prOf(run.gh),
  }));
}
