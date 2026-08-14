import { createDb, type FacilityDb, proposalEvents, proposals } from "@facility/db";
import { and, desc, eq, lt } from "drizzle-orm";
import type { AppConfig } from "../types.js";

export async function runHitlExpire(config: AppConfig) {
  const { db, client } = createDb(config.databaseUrl);
  try {
    await expireHitlProposals(db);
  } finally {
    await client.end();
  }
}

export async function expireHitlProposals(db: FacilityDb) {
  const overdue = await db
    .select()
    .from(proposals)
    .where(and(eq(proposals.state, "open"), lt(proposals.expiresAt, new Date())));
  for (const proposal of overdue) {
    await db
      .update(proposals)
      .set({ state: "expired", updatedAt: new Date() })
      .where(and(eq(proposals.orgId, proposal.orgId), eq(proposals.id, proposal.id)));
    const last = (
      await db
        .select()
        .from(proposalEvents)
        .where(
          and(eq(proposalEvents.orgId, proposal.orgId), eq(proposalEvents.proposalId, proposal.id)),
        )
        .orderBy(desc(proposalEvents.seq))
        .limit(1)
    )[0];
    await db.insert(proposalEvents).values({
      orgId: proposal.orgId,
      proposalId: proposal.id,
      seq: (last?.seq ?? 0) + 1,
      type: "expired",
      actor: { type: "system", name: "hitl.expire" },
      data: {},
    });
  }
  return overdue.length;
}
