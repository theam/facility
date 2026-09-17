import type PgBoss from "pg-boss";

// pg-boss requires an expiration below 24 hours. Its 15-minute default detaches
// the callback without canceling the remote agent, allowing more jobs to arrive
// while the worker is still occupied. Durable turn leases still recover crashes
// in minutes; this queue timeout must accommodate long agent execution.
export const TURN_JOB_EXPIRATION_SECONDS = 23 * 60 * 60;

export async function configureTurnQueue(
  boss: Pick<PgBoss, "updateQueue">,
  name = "turns.dispatch",
) {
  await boss.updateQueue(name, { name, expireInSeconds: TURN_JOB_EXPIRATION_SECONDS });
}
