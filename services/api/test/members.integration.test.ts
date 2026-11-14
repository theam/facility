import { randomUUID } from "node:crypto";
import { newId } from "@facility/core";
import { createDb, migrate, orgMembers, orgs, seed, users } from "@facility/db";
import { and, eq } from "drizzle-orm";
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

describe("organization member roles", async () => {
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
    secretMasterKey: Buffer.alloc(32, 31).toString("base64"),
    port: 4431,
    publicUrl: "http://localhost:4431",
    webUrl: "http://localhost:3431",
    workspaceImage: "facility-runner:test",
    workspaceDriver: "docker",
    facilityInsecureDev: false,
    logLevel: "silent",
  };
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl);
    app = await buildApp(config, { rateLimitMax: 10_000 });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await client.end();
  });

  async function organization() {
    const suffix = randomUUID().slice(0, 8);
    const orgId = newId("org");
    await db.insert(orgs).values({ id: orgId, name: "Members", slug: `members-${suffix}` });
    async function member(name: string, roleId: string) {
      const userId = newId("user");
      const email = `${name}-${suffix}@example.com`;
      await db.insert(users).values({ id: userId, email, status: "active" });
      await db.insert(orgMembers).values({ id: newId("member"), orgId, userId, roleId });
      const cookie = await mintSessionCookie(config, userId, orgId);
      return { userId, email, headers: { cookie: `facility_session=${cookie}` } };
    }
    return { orgId, member };
  }

  async function roleOf(orgId: string, userId: string) {
    const [row] = await db
      .select({ roleId: orgMembers.roleId })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)));
    return row?.roleId;
  }

  it("does not let a member invite demote the last owner", async () => {
    const { orgId, member } = await organization();
    const owner = await member("owner", "role_bundled_owner");
    const maintainer = await member("maintainer", "role_bundled_maintainer");

    for (const actor of [maintainer, owner]) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/members",
        headers: actor.headers,
        payload: { email: owner.email, roleId: "role_bundled_viewer" },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: "last_owner_required" } });
    }
    expect(await roleOf(orgId, owner.userId)).toBe("role_bundled_owner");
  });

  it("changes an owner's role through an invite once another owner remains", async () => {
    const { orgId, member } = await organization();
    const owner = await member("owner", "role_bundled_owner");
    const second = await member("second", "role_bundled_owner");

    const response = await app.inject({
      method: "POST",
      url: "/v1/members",
      headers: second.headers,
      payload: { email: owner.email, roleId: "role_bundled_viewer" },
    });
    expect(response.statusCode).toBe(200);
    expect(await roleOf(orgId, owner.userId)).toBe("role_bundled_viewer");
    expect(await roleOf(orgId, second.userId)).toBe("role_bundled_owner");
  });

  it("still invites new members into any assignable role", async () => {
    const { orgId, member } = await organization();
    const owner = await member("owner", "role_bundled_owner");
    const email = `invitee-${randomUUID().slice(0, 8)}@example.com`;

    const response = await app.inject({
      method: "POST",
      url: "/v1/members",
      headers: owner.headers,
      payload: { email, roleId: "role_bundled_viewer" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ orgId, roleId: "role_bundled_viewer" });
  });
});
