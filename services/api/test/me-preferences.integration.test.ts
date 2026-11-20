import { generateApiKey, newId } from "@facility/core";
import { apiKeys, createDb, migrate, orgMembers, seed, users } from "@facility/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, mintSessionCookie } from "../src/app.js";
import type { AppConfig } from "../src/types.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility_test";
const orgId = "org_local";

describe("a person's appearance preference", () => {
  const { db, client } = createDb(databaseUrl);
  const config: AppConfig = {
    databaseUrl,
    secretMasterKey: Buffer.alloc(32, 31).toString("base64"),
    port: 4401,
    publicUrl: "http://localhost:4401",
    workspaceImage: "facility-runner:test",
    workspaceDriver: "docker",
    facilityInsecureDev: true,
    logLevel: "silent",
  };
  let app: Awaited<ReturnType<typeof buildApp>>;
  const first = newId("user");
  const second = newId("user");
  const cookie = async (userId: string) =>
    `facility_session=${await mintSessionCookie(config, userId, orgId)}`;
  const me = async (headers: Record<string, string>) =>
    app.inject({ method: "GET", url: "/v1/me", headers });
  const choose = async (headers: Record<string, string>, payload: Record<string, unknown>) =>
    app.inject({ method: "PATCH", url: "/v1/me/preferences", headers, payload });

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl, { includeDemoData: true });
    for (const id of [first, second]) {
      await db.insert(users).values({ id, email: `${id}@example.test`, name: "Reader" });
      await db
        .insert(orgMembers)
        .values({ id: newId("member"), orgId, userId: id, roleId: "role_bundled_owner" });
    }
    app = await buildApp(config, { rateLimitMax: 10_000 });
  });

  afterAll(async () => {
    await app?.close();
    await client.end();
  });

  it("is unset until the person chooses, then follows them and no one else", async () => {
    const headers = { cookie: await cookie(first) };
    const before = await me(headers);
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json().preferences).toEqual({ theme: null });

    const chosen = await choose(headers, { theme: "dark" });
    expect(chosen.statusCode, chosen.body).toBe(200);
    expect(chosen.json()).toEqual({ theme: "dark" });
    expect((await me(headers)).json().preferences).toEqual({ theme: "dark" });
    // Another session of the same person sees the same choice.
    expect((await me({ cookie: await cookie(first) })).json().preferences).toEqual({
      theme: "dark",
    });
    // Another person keeps their own (unset) preference.
    expect((await me({ cookie: await cookie(second) })).json().preferences).toEqual({
      theme: null,
    });

    expect((await choose(headers, { theme: "system" })).json()).toEqual({ theme: "system" });
    const [stored] = await db.select({ theme: users.theme }).from(users).where(eq(users.id, first));
    expect(stored?.theme).toBe("system");
  });

  it("rejects unknown values, extra fields and missing authentication", async () => {
    const headers = { cookie: await cookie(second) };
    for (const payload of [{ theme: "sepia" }, { theme: "dark", userId: first }, {}]) {
      expect((await choose(headers, payload)).statusCode).toBe(400);
    }
    expect((await choose({}, { theme: "dark" })).statusCode).toBe(401);
    expect((await me(headers)).json().preferences).toEqual({ theme: null });
    const [stored] = await db.select({ theme: users.theme }).from(users).where(eq(users.id, first));
    expect(stored?.theme).toBe("system");
  });

  it("gives API keys no preferences to read or change", async () => {
    const generated = await generateApiKey("fak");
    await db.insert(apiKeys).values({
      id: generated.id,
      orgId,
      name: "Preference test key",
      prefix: generated.lookup,
      hash: generated.hash,
      last4: generated.last4,
      scopeType: "org",
      roleId: "role_bundled_owner",
    });
    const headers = { authorization: `Bearer ${generated.secret}` };
    const read = await me(headers);
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().preferences).toBeNull();
    const write = await choose(headers, { theme: "dark" });
    expect(write.statusCode).toBe(403);
    expect(write.json().error.code).toBe("preferences_user_only");
  });
});
