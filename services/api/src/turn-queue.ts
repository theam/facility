import type PgBoss from "pg-boss";

// pg-boss requires an expiration below 24 hours. Its 15-minute default detaches
// the callback without canceling the remote agent, allowing more jobs to arrive
// while the worker is still occupied. Durable turn leases still recover crashes
// in minutes; this queue timeout must accommodate long agent execution.
export const TURN_JOB_EXPIRATION_SECONDS = 23 * 60 * 60;

/**
 * Turns this process may run at once. pg-boss 10 fetches one batch per worker
 * and waits for it, so the pool is several workers on the same queue. Each job
 * still passes through the per-story claim and the budget hold.
 */
export const TURN_POOL_SIZE = 2;

export async function configureTurnQueue(
  boss: Pick<PgBoss, "updateQueue">,
  name = "turns.dispatch",
) {
  await boss.updateQueue(name, { name, expireInSeconds: TURN_JOB_EXPIRATION_SECONDS });
}

export function registerTurnPool(
  boss: Pick<PgBoss, "work">,
  handler: PgBoss.WorkHandler<unknown>,
  name = "turns.dispatch",
) {
  return Promise.all(
    Array.from({ length: TURN_POOL_SIZE }, () => boss.work(name, { batchSize: 1 }, handler)),
  );
}
