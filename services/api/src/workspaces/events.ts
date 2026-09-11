import type { FacilityDb } from "@facility/db";
import { workspaceEvents, workspaces } from "@facility/db";
import { and, eq, sql } from "drizzle-orm";
import { WorkspaceRuntimeError } from "./runtime.js";

export async function appendWorkspaceEvent(
  db: FacilityDb,
  workspaceId: string,
  orgId: string,
  type: string,
  data: Record<string, unknown>,
) {
  const allocated = (
    await db
      .update(workspaces)
      .set({ nextEventSeq: sql`${workspaces.nextEventSeq} + 1` })
      .where(and(eq(workspaces.orgId, orgId), eq(workspaces.id, workspaceId)))
      .returning({ nextEventSeq: workspaces.nextEventSeq })
  )[0];
  if (!allocated) throw new WorkspaceRuntimeError("workspace_not_found", "workspace not found");
  await db.insert(workspaceEvents).values({
    orgId,
    workspaceId,
    seq: allocated.nextEventSeq - 1,
    type,
    data,
  });
}
