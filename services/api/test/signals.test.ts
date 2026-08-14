import { newId } from "@facility/core";
import {
  createDb,
  inboundEvents,
  integrations,
  migrate,
  orgs,
  platformIssues,
  projects,
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
});
