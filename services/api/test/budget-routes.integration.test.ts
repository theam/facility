import { randomUUID } from "node:crypto";
import { generateApiKey, newId } from "@facility/core";
import { apiKeys, auditEvents, createDb, migrate, projects, seed } from "@facility/db";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/types.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";

async function canConnect() {
  const client = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
  try {
    await client`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

describe("project budget API", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres is unreachable at DATABASE_URL; budget routes skipped", () => undefined);
    return;
  }

  const { db, client } = createDb(databaseUrl);
  const suffix = randomUUID().slice(0, 8);
  const projectId = newId("proj");
  const otherProjectId = newId("proj");
  const config: AppConfig = {
    databaseUrl,
    secretMasterKey: Buffer.alloc(32, 7).toString("base64"),
    port: 4400,
    publicUrl: "http://localhost:4400",
    webUrl: "http://localhost:3400",
    workspaceImage: "facility-runner:test",
    workspaceDriver: "docker",
    facilityInsecureDev: true,
    logLevel: "silent",
  };
  const app = await buildApp(config, { rateLimitMax: 10_000 });
  let ownerCookie = "";
  let viewerSecret = "";
  let scopedOwnerSecret = "";

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl, { includeDemoData: true });
    await db.insert(projects).values([
      { id: projectId, orgId: "org_local", name: "Budget", slug: `budget-${suffix}`, settings: {} },
      {
        id: otherProjectId,
        orgId: "org_local",
        name: "Other",
        slug: `other-budget-${suffix}`,
        settings: {},
      },
    ]);
    const viewer = await generateApiKey("fak");
    const scopedOwner = await generateApiKey("fak");
    viewerSecret = viewer.secret;
    scopedOwnerSecret = scopedOwner.secret;
    await db.insert(apiKeys).values([
      {
        id: viewer.id,
        orgId: "org_local",
        name: "budget viewer",
        prefix: viewer.lookup,
        last4: viewer.last4,
        hash: viewer.hash,
        scopeType: "project",
        projectId,
        roleId: "role_bundled_viewer",
      },
      {
        id: scopedOwner.id,
        orgId: "org_local",
        name: "scoped owner",
        prefix: scopedOwner.lookup,
        last4: scopedOwner.last4,
        hash: scopedOwner.hash,
        scopeType: "project",
        projectId,
        roleId: "role_bundled_owner",
      },
    ]);
    await app.ready();
    const login = await app.inject({ method: "GET", url: "/auth/dev-login" });
    ownerCookie = login.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  });

  afterAll(async () => {
    await app.close();
    await client.end();
  });

  it("lets a maintainer configure and read a monthly budget and persists its audit event", async () => {
    const updated = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectId}/budget`,
      headers: { cookie: ownerCookie, "idempotency-key": `budget-${suffix}` },
      payload: { monthly_limit_cents: 12_500, warning_percent: 75, enabled: true },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      monthly_limit_cents: 12_500,
      warning_percent: 75,
      state: "ok",
      enforcement: "block_new_turns",
    });
    const read = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/budget`,
      headers: { authorization: `Bearer ${viewerSecret}` },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ monthly_limit_cents: 12_500, spent_cents: 0 });
    expect(
      await db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.projectId, projectId), eq(auditEvents.action, "budget.updated"))),
    ).toHaveLength(1);
  });

  it("rejects malformed, unauthorized, and cross-project budget writes", async () => {
    const malformed = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectId}/budget`,
      headers: { cookie: ownerCookie },
      payload: { monthly_limit_cents: -1, warning_percent: 80, enabled: true },
    });
    expect(malformed.statusCode).toBe(400);

    const denied = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectId}/budget`,
      headers: { authorization: `Bearer ${viewerSecret}` },
      payload: { monthly_limit_cents: 10, warning_percent: 80, enabled: true },
    });
    expect(denied.statusCode).toBe(403);

    const crossProject = await app.inject({
      method: "GET",
      url: `/v1/projects/${otherProjectId}/budget`,
      headers: { authorization: `Bearer ${scopedOwnerSecret}` },
    });
    expect(crossProject.statusCode).toBe(404);
  });

  it("exposes project-scoped cost, observability, pipeline, and audit reads", async () => {
    for (const path of ["costs", "observability", "pipeline", "audit"]) {
      const response = await app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/${path}`,
        headers: { authorization: `Bearer ${viewerSecret}` },
      });
      expect(response.statusCode, path).toBe(200);
    }

    const deniedSync = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/github/sync`,
      headers: {
        authorization: `Bearer ${viewerSecret}`,
        "idempotency-key": `sync-denied-${suffix}`,
      },
    });
    expect(deniedSync.statusCode).toBe(403);

    const crossProjectObservability = await app.inject({
      method: "GET",
      url: `/v1/projects/${otherProjectId}/observability`,
      headers: { authorization: `Bearer ${scopedOwnerSecret}` },
    });
    expect(crossProjectObservability.statusCode).toBe(404);
  });
});
