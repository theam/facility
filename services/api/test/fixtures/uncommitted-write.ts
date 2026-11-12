import { setTimeout as sleep } from "node:timers/promises";
import postgres from "postgres";

/**
 * Runs `read` while another connection holds an uncommitted update on the rows
 * `touch` changes, then rolls that update back. A read that takes row locks on
 * those rows waits for the writer, so it settles as "blocked" after `timeoutMs`.
 */
export async function readDuringUncommittedWrite<T>(
  databaseUrl: string,
  touch: (sql: postgres.TransactionSql) => Promise<unknown>,
  read: () => Promise<T>,
  timeoutMs = 3_000,
): Promise<{ settled: "read"; value: T } | { settled: "blocked" }> {
  const writer = postgres(databaseUrl, { max: 1 });
  const rollback = new Error("rollback");
  let pending: Promise<T> | undefined;
  let outcome: { settled: "read"; value: T } | { settled: "blocked" } = { settled: "blocked" };
  try {
    await writer.begin(async (sql) => {
      await touch(sql);
      pending = read();
      outcome = await Promise.race([
        pending.then((value) => ({ settled: "read" as const, value })),
        sleep(timeoutMs).then(() => ({ settled: "blocked" as const })),
      ]);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    await writer.end();
  }
  // A blocked read resumes once the writer rolls back; settle it before returning.
  await pending?.catch(() => undefined);
  return outcome;
}
