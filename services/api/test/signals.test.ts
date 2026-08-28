import { newId } from "@facility/core";
import {
  agentDefs,
  auditEvents,
  createDb,
  inboundEvents,
  integrations,
  migrate,
  orgs,
  platformIssues,
  projects,
  registryItems,
  runs,
} from "@facility/db";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { processGenericInboundEvent } from "../src/integrations/inbound.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility_test";

async function canConnect() {
  const sqlClient = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
  try {
    await sqlClient`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sqlClient.end().catch(() => undefined);
  }
}

describe("typed operational signals", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres unreachable; signal tests skipped", () => undefined);
    return;
  }

  await migrate(databaseUrl);
  const { db, client } = createDb(databaseUrl);
  afterAll(async () => client.end());

  it("raises and resolves a standard deployment signal", async () => {
    const suffix = newId("evt");
    const orgId = newId("org");
    const projectId = newId("proj");
    const integrationId = newId("int");
    const fingerprint = `deployment:${suffix}:production`;
    await db.insert(orgs).values({ id: orgId, name: suffix, slug: suffix });
    await db.insert(projects).values({
      id: projectId,
      orgId,
      name: "Signals",
      slug: `signals-${suffix}`,
      settings: {},
    });
    await db.insert(integrations).values({
      id: integrationId,
      orgId,
      projectId,
      kind: "generic_inbound",
      name: "Deployment adapter",
      config: { projectId },
    });

    const deliver = async (status: string) => {
      const id = newId("evt");
      await db.insert(inboundEvents).values({
        id,
        orgId,
        integrationId,
        verified: true,
        eventType: "deployment",
        payload: {
          schema: "facility.signal.v1",
          type: "deployment",
          status,
          projectId,
          fingerprint,
          source: "test-adapter",
          title: `Production ${status}`,
        },
      });
      return processGenericInboundEvent(db, id);
    };

    await expect(deliver("failed")).resolves.toMatchObject({
      issue: { fingerprint, state: "open", severity: "error" },
    });
    await expect(deliver("succeeded")).resolves.toMatchObject({
      issue: { fingerprint, state: "resolved" },
    });
    const issue = (
      await db.select().from(platformIssues).where(eq(platformIssues.fingerprint, fingerprint))
    )[0];
    expect(issue).toMatchObject({ projectId, kind: "deployment_failure", state: "resolved" });
  });

  it("does not create or enqueue an inbound Builder run when plans are required", async () => {
    const suffix = newId("evt");
    const orgId = newId("org");
    const projectId = newId("proj");
    const integrationId = newId("int");
    const inboundEventId = newId("evt");
    await db.insert(orgs).values({ id: orgId, name: suffix, slug: suffix });
    await db.insert(projects).values({
      id: projectId,
      orgId,
      name: "Governed inbound",
      slug: `governed-inbound-${suffix}`,
      builderPlanPolicy: "required",
      settings: {},
    });
    const contract = (
      await db
        .insert(registryItems)
        .values({
          id: newId("item"),
          orgId,
          scope: "project",
          projectId,
          kind: "agent_contract",
          name: `governed-inbound-${suffix}`,
        })
        .returning()
    )[0];
    const agent = (
      await db
        .insert(agentDefs)
        .values({
          id: newId("agent"),
          orgId,
          projectId,
          name: "inbound-delivery",
          engine: "codex",
          model: {},
          contractItemId: contract?.id ?? "",
          triggers: [{ type: "command", handle: "/builder" }],
          enabled: true,
        })
        .returning()
    )[0];
    if (!agent) throw new Error("failed to insert inbound agent");
    await db.insert(integrations).values({
      id: integrationId,
      orgId,
      projectId,
      kind: "generic_inbound",
      name: "Governed inbound adapter",
      config: { projectId, enqueueRun: true, agent: agent.name },
    });
    await db.insert(inboundEvents).values({
      id: inboundEventId,
      orgId,
      integrationId,
      verified: true,
      eventType: "delivery.requested",
      payload: {
        projectId,
        issue: {
          fingerprint: `governed-inbound:${suffix}`,
          title: "Attempt governed delivery",
        },
      },
    });
    const enqueued: Array<{ queue: string; data: Record<string, unknown> }> = [];

    await expect(
      processGenericInboundEvent(db, inboundEventId, async (queue, data) => {
        enqueued.push({ queue, data });
        return null;
      }),
    ).rejects.toMatchObject({ code: "builder_plan_required" });

    expect(await db.select().from(runs).where(eq(runs.agentDefId, agent.id))).toEqual([]);
    expect(enqueued).toEqual([]);
    const storedEvent = (
      await db.select().from(inboundEvents).where(eq(inboundEvents.id, inboundEventId)).limit(1)
    )[0];
    expect(storedEvent).toMatchObject({ processedAt: null });
    expect(storedEvent?.error).toContain("approved Architect plan");
    const denial = (await db.select().from(auditEvents).where(eq(auditEvents.orgId, orgId))).find(
      (event) =>
        event.action === "run.builder_plan_denied" &&
        (event.payload as { source?: unknown }).source === "generic_inbound",
    );
    expect(denial).toMatchObject({
      projectId,
      payload: { code: "builder_plan_required", source: "generic_inbound" },
    });
  });
});
