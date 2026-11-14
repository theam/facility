import { randomUUID } from "node:crypto";
import { newId } from "@facility/core";
import { createDb, migrate, orgMembers, orgs, seed, users } from "@facility/db";
import { and, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, mintSessionCookie } from "../src/app.js";
import type { AppConfig } from "../src/types.js";

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

describe("member invitations by email", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    const databaseExpectation = process.env.CI ? it : it.skip;
    databaseExpectation("Postgres is reachable at DATABASE_URL", () =>
      expect(reachable).toBe(true),
    );
    return;
  }

  const { db, client } = createDb(databaseUrl);
  const config: AppConfig = {
    databaseUrl,
    secretMasterKey: Buffer.alloc(32, 32).toString("base64"),
    port: 4432,
    publicUrl: "http://localhost:4432",
    webUrl: "http://localhost:3432",
    workspaceImage: "facility-runner:test",
    workspaceDriver: "docker",
    facilityInsecureDev: false,
    logLevel: "silent",
  };
  let app: Awaited<ReturnType<typeof buildApp>>;
  const suffix = randomUUID().slice(0, 8);
  const orgId = newId("org");
  const ownerId = newId("user");
  let headers: { cookie: string };

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl);
    await db.insert(orgs).values({ id: orgId, name: "Invites", slug: `invites-${suffix}` });
    await db
      .insert(users)
      .values({ id: ownerId, email: `owner-${suffix}@example.com`, status: "active" });
    await db
      .insert(orgMembers)
      .values({ id: newId("member"), orgId, userId: ownerId, roleId: "role_bundled_owner" });
    headers = { cookie: `facility_session=${await mintSessionCookie(config, ownerId, orgId)}` };
    app = await buildApp(config, { rateLimitMax: 10_000 });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await client.end();
  });

  const invite = (email: string, roleId: string) =>
    app.inject({ method: "POST", url: "/v1/members", headers, payload: { email, roleId } });
  const usersWithEmail = (email: string) =>
    db
      .select()
      .from(users)
      .where(eq(sql`lower(${users.email})`, email.toLowerCase()));

  it("updates the existing user when the same address is re-invited in other letter case", async () => {
    const email = `jane-${suffix}@example.com`;
    const first = await invite(email, "role_bundled_viewer");
    expect(first.statusCode).toBe(200);

    const second = await invite(`Jane-${suffix}@Example.COM`, "role_bundled_maintainer");
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      userId: first.json().userId,
      roleId: "role_bundled_maintainer",
    });
    expect(await usersWithEmail(email)).toHaveLength(1);
  });

  it("matches a user stored with mixed case and stores new invitations in lower case", async () => {
    const legacyId = newId("user");
    await db
      .insert(users)
      .values({ id: legacyId, email: `Legacy-${suffix}@Example.com`, status: "active" });

    const legacy = await invite(`legacy-${suffix}@example.com`, "role_bundled_viewer");
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json().userId).toBe(legacyId);

    const fresh = await invite(`New-${suffix}@Example.com`, "role_bundled_viewer");
    expect(fresh.statusCode).toBe(200);
    const stored = await db
      .select({ email: users.email })
      .from(users)
      .innerJoin(orgMembers, eq(orgMembers.userId, users.id))
      .where(and(eq(orgMembers.orgId, orgId), eq(users.id, fresh.json().userId)));
    expect(stored).toEqual([{ email: `new-${suffix}@example.com` }]);
  });
});
