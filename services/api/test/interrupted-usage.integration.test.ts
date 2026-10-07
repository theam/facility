import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId } from "@facility/core";
import {
  createDb,
  migrate,
  orgs,
  projectBudgets,
  projects,
  stories,
  storyConversations,
  turnGitEvidence,
  turns,
  turnUsage,
  workspaces,
} from "@facility/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CostBudgetService } from "../src/insights/costs.js";
import { StoryWorkspaceService } from "../src/stories/service.js";
import { StoryTitleService } from "../src/stories/titles.js";
import { appendTurnEvent } from "../src/turns/events.js";
import { ENGINE_USAGE_PROCESS } from "../src/turns/usage-journal.js";
import { recoverInterruptedTurns } from "../src/worker.js";
import { FakeWorkspaceRuntime } from "../src/workspaces/fake.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";
const { db, client } = createDb(databaseUrl);
const orgId = newId("org");
const otherOrgId = newId("org");
let root: string;
let runtime: FakeWorkspaceRuntime;
let service: StoryWorkspaceService;
const costs = new CostBudgetService(db);
const now = new Date();
const stale = new Date(now.getTime() - 300_000);
const counters = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 };

beforeAll(async () => {
  await migrate(databaseUrl); // A missing local database fails; these financial regressions never skip.
  root = await mkdtemp(join(tmpdir(), "facility-interrupted-usage-"));
  runtime = new FakeWorkspaceRuntime(root);
  service = new StoryWorkspaceService(db, runtime);
  await db.insert(orgs).values([
    { id: orgId, name: "Recovery usage", slug: `recovery-${randomUUID()}`, settings: {} },
    { id: otherOrgId, name: "Other", slug: `recovery-other-${randomUUID()}`, settings: {} },
  ]);
});
afterAll(async () => {
  await client.end();
  if (root) await rm(root, { recursive: true, force: true });
});

async function seed(engine: "codex" | "claude_code" = "codex", startedAt = stale) {
  const projectId = newId("proj"),
    storyId = newId("story"),
    conversationId = newId("sess"),
    turnId = newId("turn"),
    workspaceId = newId("ws");
  await db
    .insert(projects)
    .values({ id: projectId, orgId, name: "Recovery", slug: `usage-${projectId}`, settings: {} });
  await db
    .insert(projectBudgets)
    .values({ id: newId("bud"), orgId, projectId, monthlyLimitCents: 100_000, enabled: true });
  await db.insert(stories).values({
    id: storyId,
    orgId,
    projectId,
    provider: "manual",
    externalId: storyId,
    title: "Interrupted",
    titleSource: "pending",
    status: "working",
    createdBy: { type: "user", id: "test" },
  });
  await db.insert(storyConversations).values({ id: conversationId, orgId, projectId, storyId });
  const workspace = await runtime.create({ id: workspaceId, image: "fake" });
  await db.insert(workspaces).values({
    id: workspaceId,
    orgId,
    projectId,
    storyId,
    provider: "fake",
    volumeRef: workspace.volumeRef,
    externalRef: workspace.externalRef,
    environment: { image: "fake", ports: [] },
    state: "running",
  });
  await db.insert(turns).values({
    id: turnId,
    orgId,
    projectId,
    storyId,
    conversationId,
    agentName: "builder",
    manifestHash: "hash",
    manifest: {},
    engine,
    model: "gpt-5.5",
    state: "running",
    triggerType: "manual",
    createdBy: { type: "user", id: "test" },
    startedAt,
    updatedAt: startedAt,
  });
  return {
    orgId,
    projectId,
    storyId,
    turnId,
    workspace,
    engine,
    staleBefore: new Date(now.getTime() - 60_000),
  };
}
async function journal(input: Awaited<ReturnType<typeof seed>>, data: unknown) {
  const dir = join(input.workspace.volumeRef, ".facility", "engine-usage");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${input.turnId}.json`),
    typeof data === "string" ? data : JSON.stringify(data),
  );
}
function evidence(input: Awaited<ReturnType<typeof seed>>, complete = true) {
  return { version: 1, turnId: input.turnId, engine: input.engine, usage: counters, complete };
}

describe("dead worker accounting", () => {
  it("recovers a native CLI's durable final usage into the monthly budget exactly once", async () => {
    const input = await seed();
    // No live provider: a real workspace process emits deterministic native CLI JSONL.
    await runtime.exec(input.workspace, {
      command: process.execPath,
      args: [
        "-e",
        ENGINE_USAGE_PROCESS,
        process.execPath,
        "-e",
        `console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,output_tokens:20}}))`,
      ],
      env: { FACILITY_TURN_ID: input.turnId, FACILITY_ENGINE: input.engine },
    });
    expect(await service.recoverInterruptedTurn(input)).toBe(true);
    const recorded = await db.select().from(turnUsage).where(eq(turnUsage.turnId, input.turnId));
    expect(recorded).toEqual([
      expect.objectContaining({ ...counters, status: "failed", priced: true }),
    ]);
    expect((await costs.budgetState(orgId, input.projectId)).spentCents).toBeGreaterThan(0);
    expect(await service.recoverInterruptedTurn(input)).toBe(false);
    expect(await db.select().from(turnUsage).where(eq(turnUsage.turnId, input.turnId))).toEqual(
      recorded,
    );
    await expect(costs.assertTurnAllowed(orgId, input.projectId, "gpt-5.5")).resolves.toMatchObject(
      { state: "ok" },
    );
    await db
      .update(projectBudgets)
      .set({ monthlyLimitCents: 0 })
      .where(eq(projectBudgets.projectId, input.projectId));
    await expect(costs.assertTurnAllowed(orgId, input.projectId, "gpt-5.5")).rejects.toMatchObject({
      code: "budget_exceeded",
    });
  });
  it("books a partial lower bound but blocks new calls even after raising the budget", async () => {
    const input = await seed();
    await journal(input, evidence(input, false));
    await service.recoverInterruptedTurn(input);
    expect(await db.select().from(turnUsage).where(eq(turnUsage.turnId, input.turnId))).toEqual([
      expect.objectContaining({ ...counters, priced: false, source: "unpriced" }),
    ]);
    expect((await costs.budgetState(orgId, input.projectId)).spentCents).toBeGreaterThan(0);
    await db
      .update(projectBudgets)
      .set({ monthlyLimitCents: 2_000_000_000 })
      .where(eq(projectBudgets.projectId, input.projectId));
    await expect(costs.assertTurnAllowed(orgId, input.projectId, "gpt-5.5")).rejects.toMatchObject({
      code: "budget_usage_unconfirmed",
    });
    expect(await costs.budgetState(otherOrgId, input.projectId)).toMatchObject({
      spentCents: 0,
      state: "not_configured",
    });
    await db
      .update(projectBudgets)
      .set({ enabled: false })
      .where(eq(projectBudgets.projectId, input.projectId));
    await expect(costs.assertTurnAllowed(orgId, input.projectId, "gpt-5.5")).resolves.toMatchObject(
      { state: "disabled" },
    );
  });
  it("does not consume a newer workspace's usage when the recorded workspace was destroyed", async () => {
    const input = await seed();
    await journal(input, evidence(input));
    await db.insert(turnGitEvidence).values({
      orgId,
      projectId: input.projectId,
      storyId: input.storyId,
      turnId: input.turnId,
      workspaceId: input.workspace.id,
      engineSessionId: newId("esess"),
      initialSha: "a".repeat(40),
    });
    await runtime.destroy(input.workspace);
    await db
      .update(workspaces)
      .set({ state: "destroyed", destroyedAt: new Date() })
      .where(eq(workspaces.id, input.workspace.id));
    const newer = await runtime.create({ id: newId("ws"), image: "fake" });
    await db.insert(workspaces).values({
      id: newer.id,
      orgId,
      projectId: input.projectId,
      storyId: input.storyId,
      provider: "fake",
      externalRef: newer.externalRef,
      volumeRef: newer.volumeRef,
      environment: { image: "fake", ports: [] },
      state: "running",
      createdAt: new Date(now.getTime() + 1000),
    });
    await journal(
      { ...input, workspace: newer },
      { ...evidence(input), usage: { ...counters, inputTokens: 9999 } },
    );
    await service.recoverInterruptedTurn(input);
    expect(await db.select().from(turnUsage).where(eq(turnUsage.turnId, input.turnId))).toEqual([
      expect.objectContaining({ inputTokens: 0, costCents: null, priced: false }),
    ]);
  });
  it.each([
    "absent",
    "malformed",
    "wrong-turn",
    "wrong-engine",
    "negative",
    "oversized",
    "unavailable",
  ])("keeps %s evidence unknown and fails closed", async (kind) => {
    const input = await seed();
    if (kind === "malformed") await journal(input, "{");
    if (kind === "wrong-turn") await journal(input, { ...evidence(input), turnId: "turn_other" });
    if (kind === "wrong-engine")
      await journal(input, { ...evidence(input), engine: "claude_code" });
    if (kind === "negative")
      await journal(input, { ...evidence(input), usage: { ...counters, inputTokens: -1 } });
    if (kind === "oversized") await journal(input, "x".repeat(5000));
    if (kind === "unavailable") await runtime.suspend(input.workspace);
    await service.recoverInterruptedTurn(input);
    expect(await db.select().from(turnUsage).where(eq(turnUsage.turnId, input.turnId))).toEqual([
      expect.objectContaining({ costCents: null, priced: false }),
    ]);
    await expect(costs.assertTurnAllowed(orgId, input.projectId, "gpt-5.5")).rejects.toMatchObject({
      code: "budget_usage_unconfirmed",
    });
  });
  it("rejects cross-tenant and cross-project recovery before touching a journal", async () => {
    const input = await seed();
    await journal(input, evidence(input));
    await expect(
      service.recoverInterruptedTurn({ ...input, orgId: otherOrgId }),
    ).rejects.toMatchObject({ code: "turn_not_found" });
    const other = await seed();
    await expect(
      service.recoverInterruptedTurn({ ...input, projectId: other.projectId }),
    ).rejects.toMatchObject({ code: "turn_not_found" });
    expect(await db.select().from(turnUsage).where(eq(turnUsage.turnId, input.turnId))).toEqual([]);
    await db.update(turns).set({ state: "failed" }).where(eq(turns.id, other.turnId));
  });
  it("leaves a live lease alone and does not book an old or replayed journal", async () => {
    const input = await seed("codex", now);
    await journal(input, evidence(input));
    expect(await service.recoverInterruptedTurn(input)).toBe(false);
    expect(await db.select().from(turnUsage).where(eq(turnUsage.turnId, input.turnId))).toEqual([]);
  });
  it("does not block for an interrupted preparation phase that never reached the engine", async () => {
    const input = await seed();
    await appendTurnEvent(db, {
      orgId,
      projectId: input.projectId,
      storyId: input.storyId,
      turnId: input.turnId,
      type: "turn.phase",
      data: { phase: "environment" },
    });
    await service.recoverInterruptedTurn(input);
    expect(await db.select().from(turnUsage).where(eq(turnUsage.turnId, input.turnId))).toEqual([]);
    expect((await costs.budgetState(orgId, input.projectId)).state).toBe("ok");
  });
  it.each([
    {},
    { phase: "unknown-stage" },
  ])("does not infer zero spend from malformed or unknown phase evidence %#", async (data) => {
    const input = await seed();
    await appendTurnEvent(db, {
      orgId,
      projectId: input.projectId,
      storyId: input.storyId,
      turnId: input.turnId,
      type: "turn.phase",
      data,
    });
    await service.recoverInterruptedTurn(input);
    await expect(costs.assertTurnAllowed(orgId, input.projectId, "gpt-5.5")).rejects.toMatchObject({
      code: "budget_usage_unconfirmed",
    });
  });
  it("keeps an already settled charge when recovery sees an incomplete journal", async () => {
    const input = await seed();
    await costs.record({
      ...input,
      agentName: "builder",
      model: "gpt-5.5",
      usage: counters,
      durationMs: 10,
      status: "failed",
    });
    const before = await db.select().from(turnUsage).where(eq(turnUsage.turnId, input.turnId));
    await journal(input, evidence(input, false));
    await service.recoverInterruptedTurn(input);
    expect(await db.select().from(turnUsage).where(eq(turnUsage.turnId, input.turnId))).toEqual(
      before,
    );
  });
  it("bookmarks uncertainty before the worker activates a queued successor", async () => {
    const input = await seed();
    const callback = vi.fn(async ({ projectId }: { projectId: string }) => {
      if (projectId === input.projectId)
        await expect(costs.assertTurnAllowed(orgId, projectId, "gpt-5.5")).rejects.toMatchObject({
          code: "budget_usage_unconfirmed",
        });
    });
    await recoverInterruptedTurns(db, service, now, 60_000, callback);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ turnId: input.turnId }));
  });
  it("prevents title generation from making a model call while spending is unconfirmed", async () => {
    const input = await seed();
    await service.recoverInterruptedTurn(input);
    const complete = vi.fn(async () => ({
      title: "Must not call",
      inputTokens: 1,
      outputTokens: 1,
    }));
    const titleService = new StoryTitleService(db, {
      credentials: async () => ({ openai: "local-fake" }),
      budget: costs,
      complete,
    });
    // The title service must see a stored request before consulting the budget.
    const { storyMessages } = await import("@facility/db");
    const turn = (await db.select().from(turns).where(eq(turns.id, input.turnId)))[0];
    if (!turn) throw new Error("fixture turn missing");
    await db.insert(storyMessages).values({
      id: newId("msg"),
      orgId,
      projectId: input.projectId,
      storyId: input.storyId,
      conversationId: turn.conversationId,
      seq: 1,
      role: "user",
      body: "Generate a title",
      actor: { type: "user", id: "test" },
    });
    expect(await titleService.generate(input)).toMatchObject({
      reason: "budget_usage_unconfirmed",
    });
    expect(complete).not.toHaveBeenCalled();
  });
  it("does not clear unknown spending when the month rolls over", async () => {
    const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 12));
    const input = await seed("codex", previous);
    await service.recoverInterruptedTurn(input);
    expect((await costs.budgetState(orgId, input.projectId, now)).spentCents).toBe(0);
    await expect(
      costs.assertTurnAllowed(
        orgId,
        input.projectId,
        "gpt-5.5",
        new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
      ),
    ).rejects.toMatchObject({ code: "budget_usage_unconfirmed" });
  });
  it("settles later durable evidence on a recovery pass without rerunning or waking compute", async () => {
    const input = await seed();
    await service.recoverInterruptedTurn(input);
    await journal(input, evidence(input));
    const wake = vi.spyOn(runtime, "wake");
    await recoverInterruptedTurns(db, service, now, 60_000);
    expect(wake).not.toHaveBeenCalled();
    wake.mockRestore();
    await expect(costs.assertTurnAllowed(orgId, input.projectId, "gpt-5.5")).resolves.toMatchObject(
      { state: "ok" },
    );
    const before = await db.select().from(turnUsage).where(eq(turnUsage.turnId, input.turnId));
    await journal(input, evidence(input, false));
    expect(await service.reconcileInterruptedUsage(input)).toBe(false);
    expect(await db.select().from(turnUsage).where(eq(turnUsage.turnId, input.turnId))).toEqual(
      before,
    );
  });
  it("marks a pre-upgrade failed worker's missing bill unknown during recovery", async () => {
    const input = await seed();
    await db
      .update(turns)
      .set({
        state: "failed",
        endedAt: now,
        error: "Worker heartbeat expired before the agent turn completed.",
      })
      .where(eq(turns.id, input.turnId));
    await recoverInterruptedTurns(db, service, now, 60_000);
    expect(await db.select().from(turnUsage).where(eq(turnUsage.turnId, input.turnId))).toEqual([
      expect.objectContaining({ priced: false, costCents: null }),
    ]);
    await expect(costs.assertTurnAllowed(orgId, input.projectId, "gpt-5.5")).rejects.toMatchObject({
      code: "budget_usage_unconfirmed",
    });
  });
  it("allows a late live dispatcher to settle an unknown row exactly once", async () => {
    const input = await seed();
    await service.recoverInterruptedTurn(input);
    const request = {
      ...input,
      agentName: "builder",
      model: "gpt-5.5",
      usage: counters,
      durationMs: 10,
      status: "failed" as const,
    };
    expect(await costs.record(request)).toMatchObject({ priced: true });
    expect(await costs.record(request)).toBeNull();
    expect((await costs.budgetState(orgId, input.projectId)).state).toBe("ok");
  });
  it("keeps the project blocked until every interrupted turn is settled", async () => {
    const input = await seed();
    const secondId = newId("turn");
    const original = (await db.select().from(turns).where(eq(turns.id, input.turnId)))[0];
    if (!original) throw new Error("fixture turn missing");
    await service.recoverInterruptedTurn(input);
    await db.insert(turns).values({ ...original, id: secondId });
    await service.recoverInterruptedTurn({ ...input, turnId: secondId });
    const request = {
      ...input,
      agentName: "builder",
      model: "gpt-5.5",
      usage: counters,
      durationMs: 10,
      status: "failed" as const,
    };
    await costs.record(request);
    await expect(costs.assertTurnAllowed(orgId, input.projectId, "gpt-5.5")).rejects.toMatchObject({
      code: "budget_usage_unconfirmed",
    });
    await costs.record({ ...request, turnId: secondId });
    expect((await costs.budgetState(orgId, input.projectId)).state).toBe("ok");
    const rows = await db.select().from(turnUsage).where(eq(turnUsage.projectId, input.projectId));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.priced)).toBe(true);
  });
  it("settles competing final reports once without allowing a replay to change the charge", async () => {
    const input = await seed();
    await service.recoverInterruptedTurn(input);
    const request = {
      ...input,
      agentName: "builder",
      model: "gpt-5.5",
      durationMs: 10,
      status: "failed" as const,
    };
    const results = await Promise.all([
      costs.record({ ...request, usage: { ...counters, reportedCostCents: 11 } }),
      costs.record({ ...request, usage: { ...counters, reportedCostCents: 17 } }),
    ]);
    const written = results.filter((row) => row !== null);
    expect(written).toHaveLength(1);
    const before = await db.select().from(turnUsage).where(eq(turnUsage.turnId, input.turnId));
    expect(before).toHaveLength(1);
    expect([11, 17]).toContain(before[0]?.costCents);
    expect((await costs.budgetState(orgId, input.projectId)).spentCents).toBe(before[0]?.costCents);
    expect(
      await costs.record({ ...request, usage: { ...counters, reportedCostCents: 0 } }),
    ).toBeNull();
    expect(await db.select().from(turnUsage).where(eq(turnUsage.turnId, input.turnId))).toEqual(
      before,
    );
  });
  it("counts a previous-month worker's recovered charge when it is actually settled", async () => {
    const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 12));
    const input = await seed("codex", previous);
    await journal(input, evidence(input));
    await service.recoverInterruptedTurn(input);
    expect((await costs.budgetState(orgId, input.projectId, previous)).spentCents).toBe(0);
    expect((await costs.budgetState(orgId, input.projectId, now)).spentCents).toBeGreaterThan(0);
  });
  it("charges this month's budget when an old unknown placeholder is finally settled", async () => {
    const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 12));
    const input = await seed("codex", previous);
    await service.recoverInterruptedTurn(input);
    await db
      .update(turnUsage)
      .set({ createdAt: previous })
      .where(eq(turnUsage.turnId, input.turnId));
    await journal(input, evidence(input));
    await service.reconcileInterruptedUsage(input);
    expect((await costs.budgetState(orgId, input.projectId, now)).spentCents).toBeGreaterThan(0);
    expect((await costs.budgetState(orgId, input.projectId, previous)).spentCents).toBe(0);
    await db
      .update(projectBudgets)
      .set({ monthlyLimitCents: 0 })
      .where(eq(projectBudgets.projectId, input.projectId));
    await expect(
      costs.assertTurnAllowed(orgId, input.projectId, "gpt-5.5", now),
    ).rejects.toMatchObject({ code: "budget_exceeded" });
  });
});
