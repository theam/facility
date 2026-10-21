import { randomUUID } from "node:crypto";
import { costCents, newId, reservationCents } from "@facility/core";
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
  turnUsage,
} from "@facility/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CostBudgetService } from "../src/insights/costs.js";
import { StoryWorkspaceService } from "../src/stories/service.js";
import { FakeWorkspaceRuntime } from "../src/workspaces/fake.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";
const { db, client } = createDb(databaseUrl);
const costs = new CostBudgetService(db);
const orgId = newId("org");
const otherOrgId = newId("org");
const model = "gpt-5.5";
const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 };

beforeAll(async () => {
  await migrate(databaseUrl);
  await db.insert(orgs).values([
    { id: orgId, name: "Budget composition", slug: randomUUID() },
    { id: otherOrgId, name: "Other organization", slug: randomUUID() },
  ]);
});
afterAll(async () => client.end());

async function fixture(fixtureOrgId = orgId) {
  const orgId = fixtureOrgId;
  const projectId = newId("proj");
  const storyId = newId("story");
  const conversationId = newId("sess");
  await db.insert(projects).values({ id: projectId, orgId, name: "Budget", slug: projectId });
  await db.insert(projectBudgets).values({
    id: newId("bud"),
    orgId,
    projectId,
    monthlyLimitCents: 100_000,
    enabled: true,
  });
  await db.insert(stories).values({
    id: storyId,
    orgId,
    projectId,
    provider: "manual",
    externalId: storyId,
    title: "Budget composition",
    createdBy: { type: "user", id: "test" },
  });
  await db.insert(storyConversations).values({ id: conversationId, orgId, projectId, storyId });
  const input = { orgId, projectId, storyId, conversationId, model };
  return { ...input, turnId: await turn(input, "queued") };
}

async function turn(
  input: {
    orgId: string;
    projectId: string;
    storyId: string;
    conversationId: string;
  },
  state: "queued" | "failed" = "failed",
) {
  const id = newId("turn");
  await db.insert(turns).values({
    id,
    ...input,
    agentName: "builder",
    manifestHash: "test",
    manifest: {},
    engine: "codex",
    model,
    state,
    triggerType: "manual",
    createdBy: { type: "user", id: "test" },
  });
  return id;
}

async function reserve(input: Awaited<ReturnType<typeof fixture>>) {
  return db.transaction((rawTx) => costs.reserveTurn(rawTx as unknown as typeof db, input));
}

function bill(input: Awaited<ReturnType<typeof fixture>>) {
  return {
    ...input,
    agentName: "builder",
    engine: "codex",
    durationMs: 10,
    status: "failed" as const,
  };
}

describe("reservation and interrupted-usage composition", () => {
  it("treats an open hold on a terminal turn as unresolved spending", async () => {
    const input = await fixture();
    await reserve(input);
    const [hold] = await db
      .select()
      .from(budgetReservations)
      .where(eq(budgetReservations.turnId, input.turnId));
    if (!hold) throw new Error("missing hold");
    await db.update(turns).set({ state: "canceled" }).where(eq(turns.id, input.turnId));
    expect((await costs.budgetState(orgId, input.projectId)).state).toBe("unconfirmed");
    expect(await costs.reserveTitle(input)).toEqual({ outcome: "unconfirmed" });
    const next = await turn(input);
    await expect(reserve({ ...input, turnId: next })).rejects.toMatchObject({
      code: "budget_usage_unconfirmed",
    });
    await costs.record({ ...bill(input), usage });
    // A legacy stranded hold must not keep a known final bill blocked forever.
    await db.insert(budgetReservations).values({ ...hold, id: newId("evt") });
    const runtime = new FakeWorkspaceRuntime("/tmp/facility-budget-recovery-unused");
    const execution = vi.spyOn(runtime, "exec");
    await new StoryWorkspaceService(db, runtime).reconcileInterruptedUsage(input);
    expect(execution).not.toHaveBeenCalled();
    expect((await costs.budgetState(orgId, input.projectId)).state).toBe("ok");
    expect(
      await db.select().from(budgetReservations).where(eq(budgetReservations.turnId, input.turnId)),
    ).toEqual([]);
  });
  it.each([
    model,
    "unpriced-custom-model",
  ])("denies a %s reservation on an old unknown bill", async (requestedModel) => {
    const input = await fixture();
    await costs.record({ ...bill(input), complete: false });
    const oldMonth = new Date(Date.UTC(2020, 0, 1));
    await db
      .update(turnUsage)
      .set({ createdAt: oldMonth })
      .where(eq(turnUsage.turnId, input.turnId));
    await db
      .update(projectBudgets)
      .set({ monthlyLimitCents: 1_000_000 })
      .where(eq(projectBudgets.projectId, input.projectId));
    await expect(reserve({ ...input, model: requestedModel })).rejects.toMatchObject({
      code: "budget_usage_unconfirmed",
    });
    expect(
      await db
        .select()
        .from(budgetReservations)
        .where(eq(budgetReservations.projectId, input.projectId)),
    ).toEqual([]);
  });

  it("checks uncertainty before reusing a title hold, then allows reuse after final settlement", async () => {
    const input = await fixture();
    const first = await costs.reserveTitle(input);
    expect(first.outcome).toBe("admitted");
    await costs.record({ ...bill(input), complete: false });
    expect(await costs.reserveTitle(input)).toEqual({ outcome: "unconfirmed" });
    const held = await db
      .select()
      .from(budgetReservations)
      .where(eq(budgetReservations.projectId, input.projectId));
    expect(held).toHaveLength(1);
    if (first.outcome !== "admitted") throw new Error("title was not admitted");
    expect(held[0]?.id).toBe(first.reservationId);
    await costs.record({ ...bill(input), usage });
    expect(await costs.reserveTitle(input)).toEqual(first);
  });

  it("counts measured usage, open turn holds and settled title charges together", async () => {
    const input = await fixture();
    await reserve(input);
    const second = await turn(input);
    await costs.record({ ...bill(input), turnId: second, usage });
    const title = await costs.reserveTitle(input);
    if (title.outcome !== "admitted") throw new Error("title was not admitted");
    const claimToken = await costs.claimModelCall({ ...input, callId: title.callId });
    if (!claimToken) throw new Error("title was not claimed");
    await costs.settleTitle({
      ...input,
      callId: title.callId,
      claimToken,
      reservationId: title.reservationId,
      certainty: "confirmed",
      cents: 3.75,
    });
    expect((await costs.budgetState(orgId, input.projectId)).spentCents).toBeCloseTo(
      (costCents({ model, ...usage }) ?? 0) + (reservationCents(model, "turn") ?? 0) + 3.75,
      8,
    );
    expect(
      (await costs.usage(orgId, input.projectId, new Date(0), new Date("2100-01-01"))).summary
        .turns,
    ).toBe(1);
  });

  it("rolls back the final bill if deleting its hold fails, then settles both exactly once", async () => {
    const input = await fixture();
    await reserve(input);
    // Preserve a pending bill and its hold to expose a split settlement transaction.
    await db.insert(turnUsage).values({
      id: newId("evt"),
      ...bill(input),
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costCents: null,
      priced: false,
      source: "unpriced",
    });
    const functionName = `budget_failure_${randomUUID().replaceAll("-", "")}`;
    await db.execute(
      sql.raw(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.turn_id = '${input.turnId}' THEN RAISE EXCEPTION 'simulated hold delete failure'; END IF; RETURN OLD; END $$`),
    );
    await db.execute(
      sql.raw(
        `CREATE TRIGGER ${functionName} BEFORE DELETE ON budget_reservations FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
      ),
    );
    try {
      await expect(costs.record({ ...bill(input), usage })).rejects.toThrow();
      expect(
        (await db.select().from(turnUsage).where(eq(turnUsage.turnId, input.turnId)))[0],
      ).toMatchObject({ priced: false, costCents: null });
      expect(
        await db
          .select()
          .from(budgetReservations)
          .where(eq(budgetReservations.turnId, input.turnId)),
      ).toHaveLength(1);
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER ${functionName} ON budget_reservations`));
      await db.execute(sql.raw(`DROP FUNCTION ${functionName}()`));
    }
    expect(await costs.record({ ...bill(input), usage })).toMatchObject({ priced: true });
    expect(
      await costs.record({ ...bill(input), usage: { ...usage, outputTokens: 99 } }),
    ).toBeNull();
    expect(
      await db.select().from(budgetReservations).where(eq(budgetReservations.turnId, input.turnId)),
    ).toEqual([]);
  });

  it.each([
    orgId,
    otherOrgId,
  ])("does not settle or release a title hold outside the supplied scope (%s)", async (scopedOrgId) => {
    const owner = await fixture();
    const other = await fixture(scopedOrgId);
    const title = await costs.reserveTitle(owner);
    if (title.outcome !== "admitted" || !title.reservationId) throw new Error("missing title hold");
    const claimToken = await costs.claimModelCall({ ...owner, callId: title.callId });
    if (!claimToken) throw new Error("title was not claimed");
    const before = await db
      .select()
      .from(budgetReservations)
      .where(eq(budgetReservations.id, title.reservationId));
    await expect(
      costs.settleTitle({
        ...other,
        callId: title.callId,
        claimToken,
        reservationId: title.reservationId,
        certainty: "confirmed",
        cents: 4,
      }),
    ).rejects.toMatchObject({ code: "budget_reservation_not_found" });
    await costs.releaseReservation(title.reservationId, other);
    expect(
      await db
        .select()
        .from(budgetReservations)
        .where(eq(budgetReservations.id, title.reservationId)),
    ).toEqual(before);
    await costs.releaseReservation(title.reservationId, owner);
    expect(
      await db
        .select()
        .from(budgetReservations)
        .where(eq(budgetReservations.id, title.reservationId)),
    ).toEqual([]);
  });
});
