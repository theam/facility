import { agentDefs, type FacilityDb, type repos } from "@facility/db";
import { and, eq } from "drizzle-orm";

export function laneFor(repo: typeof repos.$inferSelect, command: string): "repo" | "platform" {
  const answers = repo.renderAnswers as { execution_lane?: Record<string, string> } | null;
  const lane = answers?.execution_lane?.[command] ?? answers?.execution_lane?.[`/${command}`];
  return lane === "platform" ? "platform" : "repo";
}

export function agentHandlesCommand(
  agent: Pick<typeof agentDefs.$inferSelect, "name" | "triggers">,
  command: string,
) {
  const triggers = agent.triggers as unknown;
  if (!Array.isArray(triggers)) return agent.name === command;

  const boundCommands = triggers.flatMap((trigger): string[] => {
    if (!trigger || typeof trigger !== "object") return [];
    const value =
      (trigger as { command?: unknown; handle?: unknown }).command ??
      (trigger as { handle?: unknown }).handle;
    return typeof value === "string" ? [value] : [];
  });

  // Older seeded agents can contain only their manual trigger. The web UI
  // still promises that every enabled agent is available on demand by name,
  // so retain that compatibility unless an explicit command binding remaps it.
  if (boundCommands.length === 0) return agent.name === command;
  return boundCommands.some((value) => value === command || value === `/${command}`);
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
  return rows.find((row) => agentHandlesCommand(row, command));
}
