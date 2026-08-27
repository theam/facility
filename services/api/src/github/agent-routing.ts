import { agentDefs, type FacilityDb, type repos } from "@facility/db";
import { and, eq } from "drizzle-orm";

export function laneFor(repo: typeof repos.$inferSelect, command: string): "repo" | "platform" {
  const answers = repo.renderAnswers as { execution_lane?: Record<string, string> } | null;
  const lane = answers?.execution_lane?.[command] ?? answers?.execution_lane?.[`/${command}`];
  return lane === "platform" ? "platform" : "repo";
}

export async function findAgentDef(
  db: FacilityDb,
  orgId: string,
  projectId: string,
  command: string,
) {
  const rows = await db
    .select()
    .from(agentDefs)
    .where(
      and(
        eq(agentDefs.orgId, orgId),
        eq(agentDefs.projectId, projectId),
        eq(agentDefs.enabled, true),
      ),
    );
  return rows.find((row) => {
    const triggers = row.triggers as unknown;
    if (!Array.isArray(triggers)) return row.name === command;
    return triggers.some((trigger) => {
      if (!trigger || typeof trigger !== "object") return false;
      const value =
        (trigger as { command?: unknown; handle?: unknown }).command ??
        (trigger as { handle?: unknown }).handle;
      return value === command || value === `/${command}`;
    });
  });
}
