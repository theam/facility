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
  const now = new Date();
  const overdue = await db
    .select()
    .from(proposals)
    .where(and(eq(proposals.state, "open"), lt(proposals.expiresAt, now)));
  let expired = 0;
  for (const proposal of overdue) {
    const claimed = await db.transaction(async (transaction) => {
      const tx = transaction as unknown as FacilityDb;
      const updated = (
        await tx
          .update(proposals)
          .set({ state: "expired", updatedAt: now })
          .where(
            and(
              eq(proposals.orgId, proposal.orgId),
              eq(proposals.id, proposal.id),
              eq(proposals.state, "open"),
              lt(proposals.expiresAt, now),
            ),
          )
          .returning()
      )[0];
      if (!updated) return false;
      const last = (
        await tx
          .select()
          .from(proposalEvents)
          .where(
            and(
              eq(proposalEvents.orgId, proposal.orgId),
              eq(proposalEvents.proposalId, proposal.id),
            ),
          )
          .orderBy(desc(proposalEvents.seq))
          .limit(1)
      )[0];
      await tx.insert(proposalEvents).values({
        orgId: proposal.orgId,
        proposalId: proposal.id,
        seq: (last?.seq ?? 0) + 1,
        type: "expired",
        actor: { type: "system", name: "hitl.expire" },
        data: {},
      });
      return true;
    });
    if (claimed) expired += 1;
  }
  return expired;
}
