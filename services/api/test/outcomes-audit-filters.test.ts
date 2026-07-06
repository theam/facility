import { newId } from "@facility/core";
import { createDb, insertAuditEvent, migrate, outcomes, projects, seed } from "@facility/db";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/types.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility";
const masterKey = Buffer.alloc(32, 11).toString("base64");

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

describe("outcomes list + audit filters", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres unreachable; outcomes/audit filter tests skipped", () => undefined);
    return;
  }

  const config: AppConfig = {
    databaseUrl,
    secretMasterKey: masterKey,
    port: 4409,
    publicUrl: "http://127.0.0.1:0",
    sandboxApiUrl: "http://127.0.0.1:0",
    sandboxGatewayUrl: "http://127.0.0.1:0",
    sandboxRunnerImage: "facility-runner:dev",
    sandboxDriver: "docker",
    webUrl: "http://localhost:3000",
    facilityInsecureDev: true,
    logLevel: "silent",
  };
  const { db, client } = createDb(databaseUrl);
  const app = await buildApp(config);
  let cookie = "";
  let orgId = "";
  let projectA = "";
  let projectB = "";

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl);
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/auth/dev-login",
      payload: { email: `outcomes-audit-${Date.now()}@example.com` },
    });
    cookie = login.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
    orgId = login.json().orgId;
    const mkProject = async (label: string) =>
      (
        await db
          .insert(projects)
          .values({
            id: newId("proj"),
            orgId,
            name: label,
            slug: `${label}-${Date.now()}`,
            settings: {},
          })
          .returning()
      )[0]?.id ?? "";
    projectA = await mkProject("outcomes-a");
    projectB = await mkProject("outcomes-b");
  });

  afterAll(async () => {
    await app.close();
    await client.end();
  });

  it("lists open outcomes scoped to org and project, newest first", async () => {
    const repo = `theam/mirror-${Date.now()}`;
    const mkOutcome = (projectId: string, prNumber: number, terminal: boolean) =>
      db.insert(outcomes).values({
        id: newId("evt"),
        orgId,
        projectId,
        repo,
        prNumber,
        agentLane: "claude_code",
        openedAt: new Date(Date.now() - prNumber * 1000),
        ...(terminal ? { terminalAt: new Date(), fate: "merged" } : {}),
      });
    await mkOutcome(projectA, 101, false);
    await mkOutcome(projectA, 102, true);
    await mkOutcome(projectB, 103, false);

    const open = await app.inject({
      method: "GET",
      url: `/v1/outcomes?state=open&projectId=${projectA}`,
      headers: { cookie },
    });
    expect(open.statusCode).toBe(200);
    const openRows = open.json() as Array<{ prNumber: number }>;
    expect(openRows.map((r) => r.prNumber)).toEqual([101]);

    const all = await app.inject({
      method: "GET",
      url: `/v1/outcomes?state=all&projectId=${projectA}`,
      headers: { cookie },
    });
    expect((all.json() as unknown[]).length).toBe(2);
  });

  it("filters audit by actionPrefix, projectId, and createdFrom window", async () => {
    await insertAuditEvent(db, {
      orgId,
      projectId: projectA,
      actor: { type: "user", id: "u1" },
      action: "run.triggered",
      target: { type: "run", id: "r1" },
      payload: {},
    });
    await insertAuditEvent(db, {
      orgId,
      projectId: projectB,
      actor: { type: "user", id: "u1" },
      action: "hitl.decided",
      target: { type: "proposal", id: "p1" },
      payload: {},
    });

    const byPrefix = await app.inject({
      method: "GET",
      url: `/v1/audit?actionPrefix=run.&projectId=${projectA}`,
      headers: { cookie },
    });
    expect(byPrefix.statusCode).toBe(200);
    const prefixItems = byPrefix.json().items as Array<{ action: string; projectId: string }>;
    expect(prefixItems.length).toBeGreaterThan(0);
    expect(prefixItems.every((e) => e.action.startsWith("run.") && e.projectId === projectA)).toBe(
      true,
    );

    const future = new Date(Date.now() + 3600_000).toISOString();
    const empty = await app.inject({
      method: "GET",
      url: `/v1/audit?createdFrom=${encodeURIComponent(future)}&projectId=${projectA}`,
      headers: { cookie },
    });
    expect(empty.json().items).toEqual([]);
  });
});
