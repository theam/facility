import { randomUUID } from "node:crypto";
import { newId, reservationCents } from "@facility/core";
import type { FacilityDb } from "@facility/db";
import {
  budgetReservations,
  createDb,
  migrate,
  orgs,
  projectBudgets,
  projects,
  stories,
  storyConversations,
  turns,
} from "@facility/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BudgetPolicyError } from "../src/insights/budget-policy.js";
import { CostBudgetService, committedCents } from "../src/insights/costs.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";
const { db, client } = createDb(databaseUrl);
const model = "gpt-5.5";
const estimate = reservationCents(model, "turn");

beforeAll(async () => {
  await migrate(databaseUrl);
});
afterAll(async () => client.end());

if (estimate === null) throw new Error(`Model ${model} must carry a turn reservation price`);

async function queuedTurn(input: {
  orgId: string;
  projectId: string;
  storyId: string;
  conversationId: string;
}) {
  const id = newId("turn");
  await db.insert(turns).values({
    id,
    ...input,
    agentName: "builder",
    manifestHash: "test",
    manifest: {},
    engine: "codex",
    model,
    state: "queued",
    triggerType: "manual",
    createdBy: { type: "user", id: "test" },
  });
  return id;
}

/** One project with `storyCount` independent stories — the reported shape of parallel work. */
async function fixture(storyCount: number, limitCents: number) {
  const orgId = newId("org");
  const projectId = newId("proj");
  await db
    .insert(orgs)
    .values({ id: orgId, name: `Admission ${randomUUID()}`, slug: randomUUID() });
  await db.insert(projects).values({ id: projectId, orgId, name: "Admission", slug: projectId });
  await db.insert(projectBudgets).values({
    id: newId("bud"),
    orgId,
    projectId,
    monthlyLimitCents: limitCents,
    enabled: true,
  });
  const admissions: { orgId: string; projectId: string; storyId: string; turnId: string }[] = [];
  for (let index = 0; index < storyCount; index += 1) {
    const storyId = newId("story");
    const conversationId = newId("sess");
    await db.insert(stories).values({
      id: storyId,
      orgId,
      projectId,
      provider: "manual",
      externalId: storyId,
      title: `Concurrent admission ${index}`,
      createdBy: { type: "user", id: "test" },
    });
    await db.insert(storyConversations).values({ id: conversationId, orgId, projectId, storyId });
    admissions.push({
      orgId,
      projectId,
      storyId,
      turnId: await queuedTurn({ orgId, projectId, storyId, conversationId }),
    });
  }
  return { orgId, projectId, admissions };
}

type Admission = Awaited<ReturnType<typeof fixture>>["admissions"][number];

/**
 * The dispatcher's real admission transaction — claim the turn, then hold its
 * estimate inside the same transaction through CostBudgetService.reserveTurn.
 * Each sibling runs on its own connection, like a separate worker process.
 */
async function admitOnce(admission: Admission) {
  const session = createDb(databaseUrl);
  try {
    const costs = new CostBudgetService(session.db);
    return await session.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as FacilityDb;
      const [claimed] = await tx
        .update(turns)
        .set({ state: "running", startedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(turns.id, admission.turnId), eq(turns.state, "queued")))
        .returning({ id: turns.id });
      if (!claimed) throw Error(`turn was not claimable from queued: ${admission.turnId}`);
      return costs.reserveTurn(tx, { ...admission, model });
    });
  } catch (error) {
    if (error instanceof BudgetPolicyError) return error;
    throw error;
  } finally {
    await session.client.end();
  }
}

function heldHolds(projectId: string) {
  return db
    .select({ id: budgetReservations.id })
    .from(budgetReservations)
    .where(eq(budgetReservations.projectId, projectId));
}

describe("concurrent budget admission (issue #401)", () => {
  it("never lets two concurrent admissions cross a cap that fits only one estimate", async () => {
    const input = await fixture(2, estimate);
    // Fire both admissions at once. Whichever loses the race to the advisory
    // lock reads the winner's committed hold and is denied; the cap holds in
    // every ordering, so no assertion depends on which sibling wins.
    const outcomes = await Promise.all(input.admissions.map((admission) => admitOnce(admission)));
    const denied = outcomes.filter((outcome) => outcome instanceof Error);
    const admitted = outcomes.filter((outcome) => !(outcome instanceof Error));
    expect(denied.length + admitted.length).toBe(2);
    expect(admitted.length).toBeGreaterThanOrEqual(1);
    expect(await heldHolds(input.projectId)).toHaveLength(admitted.length);
    expect(await committedCents(db, input.orgId, input.projectId)).toBeLessThanOrEqual(estimate);
    if (denied.length > 0) {
      expect((denied[0] as { code?: string }).code).toBe("budget_exceeded");
      // A denial rolls back its whole transaction, claim included, so the turn
      // stays queued instead of running unbilled.
      const losingIndex = outcomes.findIndex((outcome) => outcome instanceof Error);
      const loserId = input.admissions[losingIndex]?.turnId;
      if (!loserId) throw Error("Missing denied admission");
      const [loser] = await db.select().from(turns).where(eq(turns.id, loserId));
      expect(loser?.state).toBe("queued");
    }
  }, 30_000);

  it("admits every concurrent turn while their estimates still fit under the cap", async () => {
    const input = await fixture(3, estimate * 3);
    const outcomes = await Promise.all(input.admissions.map((admission) => admitOnce(admission)));
    for (const outcome of outcomes) expect(outcome instanceof Error).toBe(false);
    expect(await heldHolds(input.projectId)).toHaveLength(3);
    expect(await committedCents(db, input.orgId, input.projectId)).toBeCloseTo(estimate * 3, 8);
  }, 30_000);
});
