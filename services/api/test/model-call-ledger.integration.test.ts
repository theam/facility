import { randomUUID } from "node:crypto";
import { costCents, newId, reservationCents } from "@facility/core";
import {
  budgetReservations,
  createDb,
  migrate,
  modelCalls,
  orgs,
  projectBudgets,
  projects,
  stories,
  storyConversations,
  storyMessages,
  turns,
} from "@facility/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CostBudgetService } from "../src/insights/costs.js";
import { modelCallFingerprint } from "../src/insights/model-calls.js";
import { StoryTitleService, type TitleCompletion } from "../src/stories/titles.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";
const { db, client } = createDb(databaseUrl);
const costs = new CostBudgetService(db);
const orgId = newId("org"),
  otherOrgId = newId("org");
const model = "gpt-5.5-mini";
const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 0 };
const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

beforeAll(async () => {
  await migrate(databaseUrl);
  await db.insert(orgs).values([
    { id: orgId, name: "Model ledger", slug: randomUUID() },
    { id: otherOrgId, name: "Other tenant", slug: randomUUID() },
  ]);
});
afterAll(async () => client.end());

async function fixture(budget = true) {
  const projectId = newId("proj");
  await db.insert(projects).values({ id: projectId, orgId, name: "Billing", slug: projectId });
  if (budget)
    await db.insert(projectBudgets).values({
      id: newId("bud"),
      orgId,
      projectId,
      monthlyLimitCents: 100_000,
      enabled: true,
    });
  return story(projectId);
}

async function story(projectId: string) {
  const storyId = newId("story"),
    conversationId = newId("sess");
  await db.insert(stories).values({
    id: storyId,
    orgId,
    projectId,
    provider: "manual",
    externalId: storyId,
    title: "Provisional title",
    titleSource: "pending",
    createdBy: { type: "user", id: "test" },
  });
  await db.insert(storyConversations).values({ id: conversationId, orgId, projectId, storyId });
  await db.insert(storyMessages).values({
    id: newId("msg"),
    orgId,
    projectId,
    storyId,
    conversationId,
    seq: 1,
    role: "user",
    body: "Synthetic request for a title",
    actor: { type: "user", id: "test" },
  });
  return { orgId, projectId, storyId, conversationId, model };
}

async function admitted(input: Awaited<ReturnType<typeof fixture>>, now?: Date) {
  const admission = await costs.reserveTitle(input, now);
  expect(admission.outcome).toBe("admitted");
  if (admission.outcome !== "admitted") throw new Error("Expected an admitted model call");
  return { ...input, callId: admission.callId, reservationId: admission.reservationId };
}
async function claimed(input: Awaited<ReturnType<typeof fixture>>, now?: Date) {
  const call = await admitted(input, now);
  const claimToken = await costs.claimModelCall(call, now);
  if (!claimToken) throw new Error("Expected a unique claim");
  return { ...call, claimToken };
}
async function row(callId: string) {
  return (await db.select().from(modelCalls).where(eq(modelCalls.id, callId)))[0];
}
async function holds(storyId: string) {
  return db.select().from(budgetReservations).where(eq(budgetReservations.storyId, storyId));
}
function titles(complete: () => Promise<TitleCompletion>) {
  return new StoryTitleService(db, {
    budget: costs,
    credentials: async () => ({ openai: "synthetic-secret" }),
    complete,
  });
}

describe("durable API model-call ledger", () => {
  it("deduplicates concurrent admission and grants only one provider claim", async () => {
    const input = await fixture();
    const [first, second] = await Promise.all([admitted(input), admitted(input)]);
    expect(first.callId).toBe(second.callId);
    expect(first.reservationId).toBe(second.reservationId);
    const claims = await Promise.all([costs.claimModelCall(first), costs.claimModelCall(second)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await holds(input.storyId)).toHaveLength(1);
    expect((await costs.budgetState(orgId, input.projectId)).spentCents).toBeCloseTo(
      reservationCents(model, "title") ?? -1,
      8,
    );
  });

  it("runs one provider request when duplicate title jobs overlap", async () => {
    const input = await fixture();
    let finish!: (value: TitleCompletion) => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const complete = vi.fn(async () => {
      signalStarted();
      return new Promise<TitleCompletion>((resolve) => {
        finish = resolve;
      });
    });
    const service = titles(complete);
    const first = service.generate(input);
    await started;
    expect(await service.generate(input)).toEqual({
      outcome: "skipped",
      reason: "title_in_progress",
    });
    finish({ title: "Generated title", inputTokens: 100, outputTokens: 20 });
    expect(await first).toEqual({ outcome: "generated", title: "Generated title" });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(
      await db.select().from(modelCalls).where(eq(modelCalls.storyId, input.storyId)),
    ).toHaveLength(1);
    expect((await costs.budgetState(orgId, input.projectId)).spentCents).toBeCloseTo(
      costCents({ model, ...usage, cacheReadTokens: 0 }) ?? -1,
      8,
    );
  });

  it("keeps missing usage unknown, accepts a fenced late receipt, and charges it once", async () => {
    const input = await fixture();
    const call = await claimed(input);
    expect((await costs.settleTitle({ ...call, certainty: "confirmed" })).receipt).toEqual({
      state: "unconfirmed",
      costCents: null,
    });
    expect(await holds(input.storyId)).toEqual([]);
    expect((await costs.budgetState(orgId, input.projectId)).state).toBe("unconfirmed");
    expect(await costs.reserveTitle({ ...input, requestKey: "another-attempt" })).toEqual({
      outcome: "unconfirmed",
    });
    await expect(costs.assertTurnAllowed(orgId, input.projectId, model)).rejects.toMatchObject({
      code: "budget_usage_unconfirmed",
    });
    await expect(
      costs.settleTitle({ ...call, claimToken: randomUUID(), certainty: "confirmed", usage }),
    ).rejects.toMatchObject({ code: "model_call_not_owned" });
    const final = await costs.settleTitle({ ...call, certainty: "confirmed", usage });
    expect(final.receipt).toEqual({
      state: "confirmed",
      costCents: costCents({ model, ...usage }),
    });
    const publish = vi.fn();
    expect(
      await costs.settleTitle({ ...call, certainty: "confirmed", usage: zero }, publish),
    ).toMatchObject({ replayed: true, receipt: final.receipt });
    expect(publish).not.toHaveBeenCalled();
    expect((await costs.budgetState(orgId, input.projectId)).spentCents).toBeCloseTo(
      costCents({ model, ...usage }) ?? -1,
      8,
    );
    expect((await costs.budgetState(orgId, input.projectId)).state).toBe("ok");
  });

  it("confirms explicitly measured zero without confusing it with missing counters", async () => {
    const input = await fixture();
    const call = await claimed(input);
    expect(
      (await costs.settleTitle({ ...call, certainty: "confirmed", usage: zero })).receipt,
    ).toEqual({ state: "confirmed", costCents: 0 });
    expect(await row(call.callId)).toMatchObject({ state: "confirmed", costCents: 0, ...zero });
    expect((await costs.budgetState(orgId, input.projectId)).state).toBe("ok");
  });

  it("expires unstarted attempts as unbilled and started attempts as uncertain without replay", async () => {
    const past = new Date(Date.now() - 180_000);
    const untouched = await admitted(await fixture(), past);
    const started = await claimed(await fixture(), past);
    await costs.recoverModelCalls();
    expect(await row(untouched.callId)).toMatchObject({
      state: "unbilled",
      costCents: 0,
      claimToken: null,
    });
    expect(await row(started.callId)).toMatchObject({ state: "unconfirmed", costCents: null });
    expect(await holds(untouched.storyId)).toEqual([]);
    expect(await holds(started.storyId)).toEqual([]);
    expect(await costs.claimModelCall(untouched)).toBeNull();
    expect(await costs.claimModelCall(started)).toBeNull();
    expect(await costs.reserveTitle(untouched)).toEqual({ outcome: "unbilled" });
    expect(await costs.reserveTitle(started)).toEqual({ outcome: "unconfirmed" });
    await costs.settleTitle({ ...started, certainty: "confirmed", usage });
    expect(await row(started.callId)).toMatchObject({ state: "confirmed" });
  });

  it("rejects expired, malformed, conflicting and foreign attempt identities", async () => {
    const input = await fixture(),
      other = await fixture();
    const call = await claimed(input);
    for (const foreign of [
      { ...call, orgId: otherOrgId },
      { ...call, projectId: other.projectId },
      { ...call, storyId: other.storyId },
    ])
      await expect(
        costs.settleTitle({ ...foreign, certainty: "confirmed", usage }),
      ).rejects.toMatchObject({ code: "budget_reservation_not_found" });
    await expect(
      costs.settleTitle({ ...call, reservationId: newId("evt"), certainty: "confirmed", usage }),
    ).rejects.toMatchObject({ code: "budget_reservation_not_found" });
    await expect(
      costs.reserveTitle({ ...input, fingerprint: modelCallFingerprint("changed prompt") }),
    ).rejects.toMatchObject({ code: "model_call_conflict" });
    await expect(
      costs.reserveTitle({ ...input, requestKey: "x".repeat(201) }),
    ).rejects.toMatchObject({ code: "model_call_invalid" });
    await expect(costs.reserveTitle({ ...input, fingerprint: "malformed" })).rejects.toMatchObject({
      code: "model_call_invalid",
    });
    const expired = await admitted(other, new Date(Date.now() - 180_000));
    expect(await costs.claimModelCall(expired)).toBeNull();
    expect(await row(expired.callId)).toMatchObject({ state: "unbilled" });
    expect(await row(call.callId)).toMatchObject({ state: "started", costCents: null });
  });

  it("rolls publication and its bill back together and never repeats the paid call", async () => {
    const input = await fixture();
    const complete = vi.fn(async () => ({
      title: "Generated title",
      inputTokens: 100,
      outputTokens: 20,
    }));
    const service = titles(complete);
    const functionName = `title_failure_${randomUUID().replaceAll("-", "")}`;
    await db.execute(
      sql.raw(
        `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${input.storyId}' AND NEW.title_source = 'generated' THEN RAISE EXCEPTION 'simulated title publication failure'; END IF; RETURN NEW; END $$`,
      ),
    );
    await db.execute(
      sql.raw(
        `CREATE TRIGGER ${functionName} BEFORE UPDATE ON stories FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
      ),
    );
    try {
      await expect(service.generate(input)).rejects.toThrow();
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER ${functionName} ON stories`));
      await db.execute(sql.raw(`DROP FUNCTION ${functionName}()`));
    }
    const [call] = await db.select().from(modelCalls).where(eq(modelCalls.storyId, input.storyId));
    expect(call).toMatchObject({ state: "started", costCents: null });
    expect(await holds(input.storyId)).toMatchObject([{ state: "open" }]);
    expect((await db.select().from(stories).where(eq(stories.id, input.storyId)))[0]).toMatchObject(
      { titleSource: "pending", title: "Provisional title" },
    );
    expect(await service.generate(input)).toEqual({
      outcome: "skipped",
      reason: "title_in_progress",
    });
    expect(complete).toHaveBeenCalledTimes(1);
    if (!call) throw new Error("Missing retained attempt");
    const publish = vi.fn(async (tx: typeof db) => {
      await tx
        .update(stories)
        .set({ title: "Generated title", titleSource: "generated" })
        .where(eq(stories.id, input.storyId));
      return "published";
    });
    expect(
      await costs.settleTitle(
        {
          ...input,
          callId: call.id,
          reservationId: call.reservationId,
          claimToken: call.claimToken,
          certainty: "confirmed",
          usage,
        },
        publish,
      ),
    ).toMatchObject({ published: "published" });
    expect(publish).toHaveBeenCalledTimes(1);
    expect((await costs.budgetState(orgId, input.projectId)).spentCents).toBeCloseTo(
      costCents({ model, ...usage }) ?? -1,
      8,
    );
  });

  it("includes calls made before enforcement was enabled and does not double-count settled holds", async () => {
    const input = await fixture(false);
    const call = await claimed(input);
    await costs.settleTitle({ ...call, certainty: "confirmed", cents: 4.75 });
    expect(await holds(input.storyId)).toMatchObject([{ state: "settled", reservedCents: 4.75 }]);
    expect((await costs.budgetState(orgId, input.projectId)).spentCents).toBe(4.75);
    await db.insert(projectBudgets).values({
      id: newId("bud"),
      orgId,
      projectId: input.projectId,
      enabled: true,
      monthlyLimitCents: 4,
    });
    expect(await costs.reserveTitle({ ...input, requestKey: "later" })).toEqual({
      outcome: "exceeded",
    });
    await costs.releaseReservation(call.reservationId, input);
    expect((await costs.budgetState(orgId, input.projectId)).spentCents).toBe(4.75);
  });

  it("serializes native-turn and API-call admissions against the same project budget", async () => {
    const native = await fixture(),
      api = await story(native.projectId);
    const turnId = newId("turn"),
      nativeModel = "gpt-5.5";
    await db.insert(turns).values({
      id: turnId,
      orgId,
      projectId: native.projectId,
      storyId: native.storyId,
      conversationId: native.conversationId,
      agentName: "builder",
      manifestHash: "test",
      manifest: {},
      engine: "codex",
      model: nativeModel,
      state: "queued",
      triggerType: "manual",
      createdBy: { type: "user", id: "test" },
    });
    const nativeEstimate = reservationCents(nativeModel, "turn"),
      apiEstimate = reservationCents(model, "title");
    if (nativeEstimate === null || apiEstimate === null)
      throw new Error("Expected priced fixtures");
    await db
      .update(projectBudgets)
      .set({ monthlyLimitCents: Math.ceil(nativeEstimate) })
      .where(eq(projectBudgets.projectId, native.projectId));
    const [nativeResult, apiResult] = await Promise.allSettled([
      db.transaction((tx) =>
        costs.reserveTurn(tx as unknown as typeof db, { ...native, turnId, model: nativeModel }),
      ),
      costs.reserveTitle(api),
    ]);
    expect(apiResult.status).toBe("fulfilled");
    if (apiResult.status !== "fulfilled") throw apiResult.reason;
    const nativeAdmitted = nativeResult.status === "fulfilled";
    expect(Number(nativeAdmitted) + Number(apiResult.value.outcome === "admitted")).toBe(1);
    if (nativeResult.status === "rejected")
      expect(nativeResult.reason).toMatchObject({ code: "budget_exceeded" });
    else expect(apiResult.value).toEqual({ outcome: "exceeded" });
    expect(
      await db
        .select()
        .from(budgetReservations)
        .where(eq(budgetReservations.projectId, native.projectId)),
    ).toHaveLength(1);
  });

  it("retains uncertainty across calendar rollover and an explicit enforcement escape", async () => {
    const input = await fixture();
    const call = await claimed(input);
    await costs.settleTitle({ ...call, certainty: "unconfirmed", usage });
    expect((await costs.settleTitle({ ...call, certainty: "confirmed" })).receipt.state).toBe(
      "unconfirmed",
    );
    await expect(
      costs.settleTitle({ ...call, certainty: "confirmed", usage: zero }),
    ).rejects.toMatchObject({ code: "model_call_conflict" });
    await db
      .update(modelCalls)
      .set({ settledAt: new Date("2020-01-01") })
      .where(eq(modelCalls.id, call.callId));
    await db
      .update(projectBudgets)
      .set({ monthlyLimitCents: 1_000_000 })
      .where(eq(projectBudgets.projectId, input.projectId));
    expect((await costs.budgetState(orgId, input.projectId)).state).toBe("unconfirmed");
    await db
      .update(projectBudgets)
      .set({ enabled: false })
      .where(eq(projectBudgets.projectId, input.projectId));
    expect(
      await costs.reserveTitle({ ...input, requestKey: "explicit-unenforced-attempt" }),
    ).toMatchObject({ outcome: "admitted" });
    expect(await costs.reserveTitle(input)).toEqual({ outcome: "unconfirmed" });
    expect(await row(call.callId)).toMatchObject({ state: "unconfirmed", ...usage });
    await db
      .update(projectBudgets)
      .set({ enabled: true })
      .where(eq(projectBudgets.projectId, input.projectId));
    expect(await costs.reserveTitle({ ...input, requestKey: "another" })).toEqual({
      outcome: "unconfirmed",
    });
  });

  it("rejects contradictory or malformed settlements without clearing observed usage", async () => {
    const input = await fixture();
    const call = await claimed(input);
    for (const cents of [-1, NaN, Infinity])
      await expect(
        costs.settleTitle({ ...call, certainty: "confirmed", cents }),
      ).rejects.toMatchObject({ code: "model_call_invalid" });
    await expect(
      costs.settleTitle({ ...call, certainty: "unbilled", cents: 1 }),
    ).rejects.toMatchObject({ code: "model_call_conflict" });
    await costs.settleTitle({ ...call, certainty: "unconfirmed", usage });
    await expect(costs.settleTitle({ ...call, certainty: "unbilled" })).rejects.toMatchObject({
      code: "model_call_conflict",
    });
    expect(await row(call.callId)).toMatchObject({ state: "unconfirmed", ...usage });
  });

  it("enforces billing phase and tenant invariants in PostgreSQL as well as the service", async () => {
    const input = await fixture();
    const call = await admitted(input);
    for (const invalid of [
      { state: "confirmed", costCents: 0, settledAt: new Date() },
      { state: "unbilled", costCents: 1, settledAt: new Date() },
      { inputTokens: -1 },
      { costCents: Infinity },
      { orgId: otherOrgId },
    ])
      await expect(
        db.update(modelCalls).set(invalid).where(eq(modelCalls.id, call.callId)),
      ).rejects.toThrow();
    expect(await row(call.callId)).toMatchObject({ state: "reserved", costCents: null, orgId });
    const persisted = await row(call.callId);
    expect(persisted).not.toHaveProperty("prompt");
    expect(persisted).not.toHaveProperty("apiKey");
    expect(JSON.stringify(persisted)).not.toContain("Synthetic request");
  });
});
