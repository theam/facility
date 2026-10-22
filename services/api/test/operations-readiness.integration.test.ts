import { newId } from "@facility/core";
import {
  createDb,
  migrate,
  mirrorSyncs,
  orgs,
  projectBudgets,
  projects,
  stories,
  storyConversations,
  turns,
  turnUsage,
} from "@facility/db";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readWorkerReadiness } from "../src/operations/readiness.js";
import {
  beatWorker,
  operationSample,
  recordMirrorSync,
  recordWebhookRejection,
} from "../src/operations/signals.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility_test";

async function canConnect() {
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 2 });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end().catch(() => undefined);
  }
}

describe("operations readiness signals", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    const databaseExpectation = process.env.CI ? it : it.skip;
    databaseExpectation("Postgres is reachable at DATABASE_URL", () =>
      expect(reachable).toBe(true),
    );
    return;
  }

  const { db, client } = createDb(databaseUrl);
  const suffix = crypto.randomUUID().slice(0, 8);
  const transcript = `do not leak this transcript ${suffix}`;

  beforeAll(async () => {
    await migrate(databaseUrl);
  });

  afterAll(async () => {
    await client.end();
  });

  it("sees a worker heartbeat and does not treat a future retry as the oldest ready turn", async () => {
    const now = new Date();
    const workerId = `worker-${suffix}`;
    await beatWorker(db, workerId, now);
    const orgId = newId("org");
    const projectId = newId("proj");
    const dueStoryId = newId("story");
    const waitingStoryId = newId("story");
    const dueConversationId = newId("story");
    const waitingConversationId = newId("story");
    const dueTurnId = newId("turn");
    const waitingTurnId = newId("turn");
    const dueAt = new Date("2020-01-02T00:00:00.000Z");
    const waitingAt = new Date("2010-06-15T03:33:33.000Z");
    await db.insert(orgs).values({ id: orgId, name: suffix, slug: `ops-${suffix}` });
    await db.insert(projects).values({
      id: projectId,
      orgId,
      name: suffix,
      slug: suffix,
    });
    await db.insert(stories).values([
      {
        id: dueStoryId,
        orgId,
        projectId,
        provider: "manual",
        externalId: `${suffix}-due`,
        title: "operations",
        createdBy: { id: "test" },
      },
      {
        id: waitingStoryId,
        orgId,
        projectId,
        provider: "manual",
        externalId: `${suffix}-wait`,
        title: "operations",
        createdBy: { id: "test" },
      },
    ]);
    await db.insert(storyConversations).values([
      { id: dueConversationId, orgId, projectId, storyId: dueStoryId },
      { id: waitingConversationId, orgId, projectId, storyId: waitingStoryId },
    ]);
    const turnBase = {
      orgId,
      projectId,
      agentName: "builder",
      manifestHash: "hash",
      manifest: {},
      engine: "claude_code" as const,
      model: "test",
      state: "queued",
      triggerType: "manual",
      error: transcript,
      createdBy: { id: "test" },
    };
    await db.insert(turns).values([
      {
        ...turnBase,
        id: dueTurnId,
        storyId: dueStoryId,
        conversationId: dueConversationId,
        createdAt: dueAt,
      },
      {
        ...turnBase,
        id: waitingTurnId,
        storyId: waitingStoryId,
        conversationId: waitingConversationId,
        retryAfter: new Date(now.getTime() + 60 * 60 * 1_000),
        createdAt: waitingAt,
      },
    ]);

    const snapshot = await readWorkerReadiness(db, now);
    expect(snapshot.newestHeartbeatAt?.toISOString()).toBe(now.toISOString());
    expect(snapshot.oldestReadyAt).toBeInstanceOf(Date);
    expect(snapshot.oldestReadyAt?.getTime()).not.toBe(waitingAt.getTime());
    expect(snapshot.oldestReadyAt?.getTime()).toBeLessThanOrEqual(dueAt.getTime());
    expect(JSON.stringify(snapshot)).not.toContain(transcript);

    const before = await operationSample(db, now);
    await recordWebhookRejection(db, "signature", now);
    await db.insert(projectBudgets).values({
      id: newId("bud"),
      orgId,
      projectId,
      monthlyLimitCents: 1,
      enabled: true,
    });
    await db.insert(turnUsage).values({
      id: newId("evt"),
      orgId,
      projectId,
      storyId: dueStoryId,
      turnId: dueTurnId,
      agentName: "builder",
      engine: "claude_code",
      model: "test",
      costCents: 10,
      priced: true,
      source: "price_book",
      status: "failed",
      createdAt: now,
    });
    await db.update(turns).set({ state: "failed", endedAt: now }).where(eq(turns.id, dueTurnId));
    await recordMirrorSync(db, { orgId, projectId }, now);

    const after = await operationSample(db, now);
    expect(Object.keys(after).sort()).toEqual(
      [
        "budgetsExceeded",
        "failedTurns",
        "mirrorLagSeconds",
        "queueAgeSeconds",
        "webhookRejections",
      ].sort(),
    );
    expect(after.webhookRejections).toBe(before.webhookRejections + 1);
    expect(after.failedTurns).toBe(before.failedTurns + 1);
    expect(after.budgetsExceeded).toBe(before.budgetsExceeded + 1);
    expect(JSON.stringify(after)).not.toContain(transcript);
    const sync = await db.select().from(mirrorSyncs);
    expect(sync.some((row) => row.projectId === projectId)).toBe(true);
    expect(JSON.stringify(sync.find((row) => row.projectId === projectId))).not.toContain(
      transcript,
    );
  });
});
