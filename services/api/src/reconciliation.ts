import { type FacilityDb, reconciliationCursors } from "@facility/db";
import { eq, sql } from "drizzle-orm";

/** Claim a bounded scan page durably; unresolved records cannot pin every future tick. */
export async function reconciliationPage<T extends { id: string }>(
  db: FacilityDb,
  name: string,
  selectPage: (tx: FacilityDb, after: string | null) => Promise<T[]>,
) {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as FacilityDb;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`facility:reconciliation:${name}`}))`,
    );
    const [cursor] = await tx
      .select()
      .from(reconciliationCursors)
      .where(eq(reconciliationCursors.name, name));
    let rows = await selectPage(tx, cursor?.lastId ?? null);
    if (rows.length === 0 && cursor?.lastId) rows = await selectPage(tx, null);
    const lastId = rows.at(-1)?.id ?? null;
    await tx
      .insert(reconciliationCursors)
      .values({ name, lastId })
      .onConflictDoUpdate({
        target: reconciliationCursors.name,
        set: { lastId, updatedAt: new Date() },
      });
    return rows;
  });
}
