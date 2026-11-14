import { randomUUID } from "node:crypto";
import { generateApiKey, newId } from "@facility/core";
import { apiKeys, createDb, migrate, orgs, projects, seed } from "@facility/db";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";

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

describe("project-scoped API keys and project creation", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    const databaseExpectation = process.env.CI ? it : it.skip;
    databaseExpectation("Postgres is reachable at DATABASE_URL", () =>
      expect(reachable).toBe(true),
    );
    return;
  }

  const { db, client } = createDb(databaseUrl);
  const suffix = randomUUID().slice(0, 8);
  const orgId = newId("org");
  const projectId = newId("proj");
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl);
    await db.insert(orgs).values({ id: orgId, name: "Scoped keys", slug: `scoped-${suffix}` });
    await db.insert(projects).values({ id: projectId, orgId, name: "Pinned", slug: "pinned" });
    app = await buildApp(
      {
        databaseUrl,
        secretMasterKey: Buffer.alloc(32, 33).toString("base64"),
        port: 4433,
        publicUrl: "http://localhost:4433",
        webUrl: "http://localhost:3433",
        workspaceImage: "facility-runner:test",
        workspaceDriver: "docker",
        facilityInsecureDev: false,
        logLevel: "silent",
      },
      { rateLimitMax: 10_000 },
    );
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await client.end();
  });

  async function key(scopedProjectId: string | null) {
    const generated = await generateApiKey("fak");
    await db.insert(apiKeys).values({
      id: generated.id,
      orgId,
      name: "scope test",
      prefix: generated.lookup,
      last4: generated.last4,
      hash: generated.hash,
      scopeType: scopedProjectId ? "project" : "org",
      projectId: scopedProjectId,
      roleId: "role_bundled_maintainer",
    });
    return { authorization: `Bearer ${generated.secret}` };
  }

  const create = (headers: { authorization: string }, slug: string) =>
    app.inject({
      method: "POST",
      url: "/v1/projects",
      headers,
      payload: { name: slug, slug },
    });
  const projectsWithSlug = (slug: string) =>
    db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.orgId, orgId), eq(projects.slug, slug)));

  it("rejects project creation by a key pinned to another project", async () => {
    const headers = await key(projectId);
    const response = await create(headers, "escaped");

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "project_scope_forbidden" } });
    expect(await projectsWithSlug("escaped")).toEqual([]);

    const own = await app.inject({ method: "GET", url: `/v1/projects/${projectId}`, headers });
    expect(own.statusCode).toBe(200);
  });

  it("still lets an organization-wide key create projects", async () => {
    const response = await create(await key(null), "org-created");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ orgId, slug: "org-created" });
    expect(await projectsWithSlug("org-created")).toHaveLength(1);
  });
});
