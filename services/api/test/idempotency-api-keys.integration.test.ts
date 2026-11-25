import { createHash, randomUUID } from "node:crypto";
import { generateApiKey, newId } from "@facility/core";
import {
  apiKeys,
  auditEvents,
  createDb,
  idempotencyRecords,
  migrate,
  orgs,
  projects,
  seed,
} from "@facility/db";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { expireIdempotencyRecords } from "../src/idempotency.js";
import type { Principal } from "../src/types.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility_test";

async function canConnect() {
  const client = postgres(databaseUrl, { max: 1, connect_timeout: 2 });
  try {
    await client`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

describe("API-key idempotency safety", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    const databaseExpectation = process.env.CI ? it : it.skip;
    databaseExpectation("Postgres is reachable at DATABASE_URL", () =>
      expect(reachable).toBe(true),
    );
    return;
  }

  const suffix = randomUUID().slice(0, 8);
  const legacyRecordId = `idem_legacy_secret_${suffix}`;
  const { db, client } = createDb(databaseUrl);
  const otherOrgId = newId("org");
  const otherProjectId = newId("proj");
  let app: Awaited<ReturnType<typeof buildApp>>;
  let ownerCookie = "";
  let ownerPrincipal: Principal;
  let replayHandlerCalls = 0;
  let committedFailureHandlerCalls = 0;
  let staleHandlerCalls = 0;

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl, { includeDemoData: true });
    await dropAuditFailureTrigger();
    await db.insert(orgs).values({
      id: otherOrgId,
      name: `Other idempotency org ${suffix}`,
      slug: `other-idempotency-${suffix}`,
    });
    await db.insert(projects).values({
      id: otherProjectId,
      orgId: otherOrgId,
      name: `Other idempotency project ${suffix}`,
      slug: `other-idempotency-project-${suffix}`,
      settings: {},
    });

    app = await buildApp(
      {
        databaseUrl,
        secretMasterKey: Buffer.alloc(32, 29).toString("base64"),
        port: 4400,
        publicUrl: "http://localhost:4400",
        webUrl: "http://localhost:3400",
        workspaceImage: "facility-runner:test",
        workspaceDriver: "docker",
        facilityInsecureDev: true,
        logLevel: "silent",
      },
      { rateLimitMax: 10_000 },
    );

    app.post("/__test/idempotency-replay", { config: { permission: "keys:issue" } }, async () => {
      replayHandlerCalls += 1;
      return { call: replayHandlerCalls };
    });
    app.post(
      "/__test/idempotency-commit-failure",
      { config: { permission: "keys:issue" } },
      async (request) => {
        committedFailureHandlerCalls += 1;
        const body = request.body as { name: string };
        const key = await generateApiKey("fak");
        await db.insert(apiKeys).values({
          id: key.id,
          orgId: "org_local",
          name: body.name,
          prefix: key.lookup,
          last4: key.last4,
          hash: key.hash,
          scopeType: "org",
          roleId: "role_bundled_owner",
        });
        throw new Error("forced failure after committed mutation");
      },
    );
    app.post("/__test/idempotency-stale", { config: { permission: "keys:issue" } }, async () => {
      staleHandlerCalls += 1;
      return { ok: true };
    });

    await db.insert(idempotencyRecords).values({
      id: legacyRecordId,
      orgId: "org_local",
      principalId: "user:legacy-release",
      method: "POST",
      path: "/v1/keys",
      keyHash: sha256(`legacy-${suffix}`),
      requestHash: sha256("{}"),
      state: "completed",
      statusCode: 200,
      responseBody: { id: `key_legacy_${suffix}`, secret: `fak_legacy_${suffix}` },
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/__test/session",
      payload: { email: `idempotency-owner-${suffix}@example.com` },
    });
    expect(login.statusCode, login.body).toBe(200);
    ownerCookie = login.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    const me = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie: ownerCookie } });
    expect(me.statusCode, me.body).toBe(200);
    ownerPrincipal = me.json<{ principal: Principal }>().principal;
  });

  it("sanitizes secret-bearing responses left by an older release at startup", async () => {
    const record = (
      await db
        .select()
        .from(idempotencyRecords)
        .where(eq(idempotencyRecords.id, legacyRecordId))
        .limit(1)
    )[0];

    expect(record).toMatchObject({ state: "completed", statusCode: 409 });
    expect(record?.responseBody).toEqual({
      error: {
        code: "idempotency_outcome_indeterminate",
        message: "The original request may have completed; automatic replay is refused",
      },
    });
    expect(JSON.stringify(record?.responseBody)).not.toContain(`fak_legacy_${suffix}`);
  });

  afterAll(async () => {
    await dropAuditFailureTrigger();
    await app.close();
    await client.end();
  });

  it("keeps ordinary successful responses replayable", async () => {
    const idempotencyKey = `ordinary-${suffix}`;
    const headers = { cookie: ownerCookie, "idempotency-key": idempotencyKey };
    const first = await app.inject({
      method: "POST",
      url: "/__test/idempotency-replay",
      headers,
      payload: { value: "same" },
    });
    const replay = await app.inject({
      method: "POST",
      url: "/__test/idempotency-replay",
      headers,
      payload: { value: "same" },
    });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ call: 1 });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ call: 1 });
    expect(replay.headers["idempotency-status"]).toBe("replayed");
    expect(replayHandlerCalls).toBe(1);
  });

  it("returns a one-time secret once without persisting it for replay", async () => {
    const name = `secret-safe-${suffix}`;
    const idempotencyKey = `secret-safe-${suffix}`;
    const headers = { cookie: ownerCookie, "idempotency-key": idempotencyKey };
    const payload = { name, roleId: "role_bundled_owner" };
    const first = await app.inject({ method: "POST", url: "/v1/keys", headers, payload });

    expect(first.statusCode).toBe(200);
    const firstBody = first.json<{ id: string; secret: string }>();
    expect(firstBody.secret).toMatch(/^fak_/);
    const record = await idempotencyRecord("/v1/keys", idempotencyKey);
    expect(record).toMatchObject({ state: "completed", statusCode: 409 });
    expect(record?.responseBody).toEqual({
      error: {
        code: "idempotency_outcome_indeterminate",
        message: "The original request may have completed; automatic replay is refused",
      },
    });
    expect(JSON.stringify(record?.responseBody)).not.toContain(firstBody.secret);

    const replay = await app.inject({ method: "POST", url: "/v1/keys", headers, payload });
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({
      error: { code: "idempotency_outcome_indeterminate" },
    });

    const changedBody = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers,
      payload: { ...payload, name: `${name}-changed` },
    });
    expect(changedBody.statusCode).toBe(409);
    expect(changedBody.json()).toMatchObject({ error: { code: "idempotency_key_reused" } });
    expect(await keysNamed(name)).toHaveLength(1);
    expect(await keysNamed(`${name}-changed`)).toHaveLength(0);
  });

  it("allows only one issuance when the same idempotency key arrives concurrently", async () => {
    const name = `concurrent-${suffix}`;
    const headers = {
      cookie: ownerCookie,
      "idempotency-key": `concurrent-${suffix}`,
    };
    const payload = { name, roleId: "role_bundled_owner" };

    const responses = await Promise.all([
      app.inject({ method: "POST", url: "/v1/keys", headers, payload }),
      app.inject({ method: "POST", url: "/v1/keys", headers, payload }),
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(1);
    expect(await keysNamed(name)).toHaveLength(1);
  });

  it("rolls back key issuance with its audit event and safely permits retry", async () => {
    const name = `audit-rollback-${suffix}`;
    const idempotencyKey = `audit-rollback-${suffix}`;
    const headers = { cookie: ownerCookie, "idempotency-key": idempotencyKey };
    const payload = { name, roleId: "role_bundled_owner" };
    await createAuditFailureTrigger();

    const failed = await app.inject({ method: "POST", url: "/v1/keys", headers, payload });
    expect(failed.statusCode).toBe(500);
    expect(await keysNamed(name)).toHaveLength(0);
    expect(await idempotencyRecord("/v1/keys", idempotencyKey)).toBeUndefined();

    await dropAuditFailureTrigger();
    const retried = await app.inject({ method: "POST", url: "/v1/keys", headers, payload });
    expect(retried.statusCode).toBe(200);
    const retriedBody = retried.json<{ id: string }>();
    expect(await keysNamed(name)).toHaveLength(1);
    const audits = await db
      .select({ target: auditEvents.target })
      .from(auditEvents)
      .where(eq(auditEvents.action, "key.issued"));
    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: { type: "key", id: retriedBody.id } }),
      ]),
    );
  });

  it("seals a committed server failure instead of running it twice", async () => {
    const name = `committed-failure-${suffix}`;
    const idempotencyKey = `committed-failure-${suffix}`;
    const headers = { cookie: ownerCookie, "idempotency-key": idempotencyKey };
    const payload = { name };

    const failed = await app.inject({
      method: "POST",
      url: "/__test/idempotency-commit-failure",
      headers,
      payload,
    });
    expect(failed.statusCode).toBe(500);
    expect(await keysNamed(name)).toHaveLength(1);
    expect(
      await idempotencyRecord("/__test/idempotency-commit-failure", idempotencyKey),
    ).toMatchObject({ state: "completed", statusCode: 409 });

    const replay = await app.inject({
      method: "POST",
      url: "/__test/idempotency-commit-failure",
      headers,
      payload,
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({
      error: { code: "idempotency_outcome_indeterminate" },
    });
    expect(committedFailureHandlerCalls).toBe(1);
    expect(await keysNamed(name)).toHaveLength(1);
  });

  it("seals stale pending requests without invoking their handler", async () => {
    const idempotencyKey = `stale-${suffix}`;
    const path = "/__test/idempotency-stale";
    const payload = { value: "same" };
    const id = idempotencyId(ownerPrincipal, "POST", path, idempotencyKey);
    await db.insert(idempotencyRecords).values({
      id,
      orgId: ownerPrincipal.orgId,
      principalId: `${ownerPrincipal.type}:${ownerPrincipal.id}`,
      method: "POST",
      path,
      keyHash: sha256(idempotencyKey),
      requestHash: sha256(JSON.stringify(payload)),
      state: "pending",
      expiresAt: new Date(Date.now() + 60 * 60_000),
      updatedAt: new Date(Date.now() - 16 * 60_000),
    });

    const response = await app.inject({
      method: "POST",
      url: path,
      headers: { cookie: ownerCookie, "idempotency-key": idempotencyKey },
      payload,
    });
    expect(response.statusCode).toBe(409);
    expect(response.headers["idempotency-status"]).toBe("indeterminate");
    expect(response.json()).toMatchObject({
      error: { code: "idempotency_outcome_indeterminate" },
    });
    expect(staleHandlerCalls).toBe(0);
    expect(await idempotencyRecord(path, idempotencyKey)).toMatchObject({
      state: "completed",
      statusCode: 409,
    });
  });

  it("cleans up expired records", async () => {
    const id = `idem_expired_${suffix}`;
    await db.insert(idempotencyRecords).values({
      id,
      orgId: ownerPrincipal.orgId,
      principalId: `${ownerPrincipal.type}:${ownerPrincipal.id}`,
      method: "POST",
      path: "/__test/expired",
      keyHash: sha256(`expired-${suffix}`),
      requestHash: sha256("{}"),
      state: "completed",
      statusCode: 200,
      responseBody: { ok: true },
      expiresAt: new Date(Date.now() - 1_000),
    });

    expect(await expireIdempotencyRecords(db)).toBeGreaterThanOrEqual(1);
    expect(
      await db.select().from(idempotencyRecords).where(eq(idempotencyRecords.id, id)),
    ).toHaveLength(0);
  });

  it("rejects malformed, revoked, and cross-tenant inputs before creating keys", async () => {
    const malformedName = `malformed-${suffix}`;
    const malformed = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie: ownerCookie, "idempotency-key": "short" },
      payload: { name: malformedName, roleId: "role_bundled_owner" },
    });
    expect(malformed.statusCode).toBe(400);
    expect(await keysNamed(malformedName)).toHaveLength(0);

    const revokedCredential = await generateApiKey("fak");
    await db.insert(apiKeys).values({
      id: revokedCredential.id,
      orgId: "org_local",
      name: `revoked-caller-${suffix}`,
      prefix: revokedCredential.lookup,
      last4: revokedCredential.last4,
      hash: revokedCredential.hash,
      scopeType: "org",
      roleId: "role_bundled_owner",
      revokedAt: new Date(),
    });
    const revokedName = `revoked-denied-${suffix}`;
    const revoked = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: {
        authorization: `Bearer ${revokedCredential.secret}`,
        "idempotency-key": `revoked-${suffix}`,
      },
      payload: { name: revokedName, roleId: "role_bundled_owner" },
    });
    expect(revoked.statusCode).toBe(401);
    expect(await keysNamed(revokedName)).toHaveLength(0);

    const crossTenantName = `cross-tenant-${suffix}`;
    const crossTenant = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie: ownerCookie, "idempotency-key": `cross-tenant-${suffix}` },
      payload: {
        name: crossTenantName,
        roleId: "role_bundled_owner",
        projectId: otherProjectId,
      },
    });
    expect(crossTenant.statusCode).toBe(400);
    expect(crossTenant.json()).toMatchObject({ error: { code: "project_not_in_org" } });
    expect(await keysNamed(crossTenantName)).toHaveLength(0);
  });

  async function keysNamed(name: string) {
    return db
      .select({ id: apiKeys.id, revokedAt: apiKeys.revokedAt })
      .from(apiKeys)
      .where(and(eq(apiKeys.orgId, "org_local"), eq(apiKeys.name, name)));
  }

  async function idempotencyRecord(path: string, key: string) {
    return (
      await db
        .select()
        .from(idempotencyRecords)
        .where(and(eq(idempotencyRecords.path, path), eq(idempotencyRecords.keyHash, sha256(key))))
        .limit(1)
    )[0];
  }

  async function createAuditFailureTrigger() {
    await client.unsafe(`
      CREATE OR REPLACE FUNCTION facility_repro_fail_audit()
      RETURNS trigger AS $repro$
      BEGIN
        RAISE EXCEPTION 'forced audit failure after key insertion';
      END;
      $repro$ LANGUAGE plpgsql
    `);
    await client.unsafe(`
      CREATE TRIGGER "facility_repro_fail_audit"
      BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION facility_repro_fail_audit()
    `);
  }

  async function dropAuditFailureTrigger() {
    await client.unsafe('DROP TRIGGER IF EXISTS "facility_repro_fail_audit" ON audit_events');
    await client.unsafe("DROP FUNCTION IF EXISTS facility_repro_fail_audit()");
  }
});

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function idempotencyId(principal: Principal, method: string, path: string, key: string) {
  return `idem_${sha256(
    `${principal.orgId}:${principal.type}:${principal.id}:${method}:${path}:${sha256(key)}`,
  )}`;
}
