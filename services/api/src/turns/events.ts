import type { FacilityDb } from "@facility/db";
import { turnEvents, turns } from "@facility/db";
import { and, eq, sql } from "drizzle-orm";
import { AgentEngineError } from "./engines.js";

export async function appendTurnEvent(
  db: FacilityDb,
  input: {
    orgId: string;
    projectId: string;
    storyId: string;
    turnId: string;
    type: string;
    data: Record<string, unknown>;
  },
) {
  const allocated = (
    await db
      .update(turns)
      .set({ nextEventSeq: sql`${turns.nextEventSeq} + 1`, updatedAt: new Date() })
      .where(
        and(
          eq(turns.orgId, input.orgId),
          eq(turns.projectId, input.projectId),
          eq(turns.storyId, input.storyId),
          eq(turns.id, input.turnId),
        ),
      )
      .returning({ nextEventSeq: turns.nextEventSeq })
  )[0];
  if (!allocated) throw new AgentEngineError("turn_not_found", "turn not found");
  await db.insert(turnEvents).values({
    orgId: input.orgId,
    projectId: input.projectId,
    storyId: input.storyId,
    turnId: input.turnId,
    seq: allocated.nextEventSeq - 1,
    type: input.type,
    data: input.data,
  });
}
