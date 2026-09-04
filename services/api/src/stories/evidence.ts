import { newId } from "@facility/core";
import { type FacilityDb, storyEvidenceEvents } from "@facility/db";

export type StoryEvidenceInput = {
  orgId: string;
  projectId: string;
  storyId: string;
  turnId?: string;
  source: "facility" | "workspace" | "github";
  type: string;
  externalKey?: string;
  data: Record<string, unknown>;
  occurredAt?: Date;
};

/** Appends one immutable fact. Stable external keys make webhook and reconciliation retries safe. */
export async function appendStoryEvidence(db: FacilityDb, input: StoryEvidenceInput) {
  const inserted = await db
    .insert(storyEvidenceEvents)
    .values({
      id: newId("evid"),
      orgId: input.orgId,
      projectId: input.projectId,
      storyId: input.storyId,
      turnId: input.turnId,
      source: input.source,
      type: input.type,
      externalKey: input.externalKey,
      data: input.data,
      occurredAt: input.occurredAt ?? new Date(),
    })
    .onConflictDoNothing()
    .returning();
  return inserted[0] ?? null;
}
