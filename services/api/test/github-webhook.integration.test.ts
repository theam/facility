import { createHmac } from "node:crypto";
import { newId } from "@facility/core";
import { createDb, githubInstallations, githubWebhookEvents, migrate, orgs } from "@facility/db";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerWebhookRoutes } from "../src/routes/webhooks.js";
import type { AppConfig } from "../src/types.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility_test";
const secret = "github-webhook-integration-secret";

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

describe("GitHub webhook authentication and tenant binding", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    const databaseExpectation = process.env.CI ? it : it.skip;
    databaseExpectation("Postgres is reachable at DATABASE_URL", () =>
      expect(reachable).toBe(true),
    );
    return;
  }

  const { db, client } = createDb(databaseUrl);
  const app = Fastify({ logger: false });
  const suffix = crypto.randomUUID().slice(0, 8);
  const orgId = newId("org");
  const otherOrgId = newId("org");
  const installationRowId = newId("ghi");
  const otherInstallationRowId = newId("ghi");
  const installationNumber = 4_000_000 + Math.floor(Math.random() * 100_000);
  const otherInstallationNumber = installationNumber + 100_000;
  const queued: Array<{ queue: string; data: Record<string, unknown> }> = [];
  const config = {
    databaseUrl,
    secretMasterKey: Buffer.alloc(32, 51).toString("base64"),
    port: 4400,
    publicUrl: "http://127.0.0.1:4400",
    workspaceImage: "facility-runner:test",
    workspaceDriver: "docker",
    facilityInsecureDev: true,
    githubAppWebhookSecret: secret,
    logLevel: "silent",
  } satisfies AppConfig;

  beforeAll(async () => {
    await migrate(databaseUrl);
    await db.insert(orgs).values([
      { id: orgId, name: "Webhook tenant", slug: `webhook-${suffix}`, settings: {} },
      {
        id: otherOrgId,
        name: "Other webhook tenant",
        slug: `webhook-other-${suffix}`,
        settings: {},
      },
    ]);
    await db.insert(githubInstallations).values([
      {
        id: installationRowId,
        orgId,
        installationId: installationNumber,
        accountId: 11,
        accountLogin: "facility-webhook",
        targetType: "Organization",
      },
      {
        id: otherInstallationRowId,
        orgId: otherOrgId,
        installationId: otherInstallationNumber,
        accountId: 12,
        accountLogin: "facility-webhook-other",
        targetType: "Organization",
      },
    ]);
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate("facilityDb", db);
    app.decorate("enqueue", async (queue: string, data: Record<string, unknown>) => {
      queued.push({ queue, data });
      return "queued";
    });
    await registerWebhookRoutes(app, config);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await client.end();
  });

  it("accepts a valid delivery once and binds it to the installation organization", async () => {
    const delivery = `delivery-${suffix}`;
    const response = await deliver(delivery, installationNumber);
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ ok: true });
    expect(queued).toEqual([
      {
        queue: "github.webhook",
        data: { inboundEventId: `${installationEventPrefix(installationRowId)}${delivery}` },
      },
    ]);
    const stored = await db.select().from(githubWebhookEvents);
    expect(stored).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `${installationEventPrefix(installationRowId)}${delivery}`,
          orgId,
          installationId: installationRowId,
          verified: true,
        }),
      ]),
    );

    const replay = await deliver(delivery, installationNumber);
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual({ ok: true, replayed: true });
    expect(queued).toHaveLength(1);

    const otherDelivery = `other-${suffix}`;
    const other = await deliver(otherDelivery, otherInstallationNumber);
    expect(other.statusCode).toBe(202);
    expect(
      (await db.select().from(githubWebhookEvents)).find((row) => row.id.endsWith(otherDelivery)),
    ).toMatchObject({ orgId: otherOrgId, installationId: otherInstallationRowId });
  });

  it("rejects invalid and malformed signed requests without enqueueing work", async () => {
    const before = queued.length;
    const body = payload(installationNumber);
    const invalid = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: headers(`invalid-${suffix}`, "sha256=".padEnd(71, "0")),
      payload: body,
    });
    expect(invalid.statusCode).toBe(401);

    const malformedBody = Buffer.from("{");
    const malformed = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: headers(`malformed-${suffix}`, sign(malformedBody)),
      payload: malformedBody,
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({ ok: false });
    expect(queued).toHaveLength(before);
  });

  it("acknowledges unknown or suspended installations without storing or dispatching them", async () => {
    const beforeRows = (await db.select().from(githubWebhookEvents)).length;
    const beforeQueue = queued.length;
    const unknown = await deliver(`unknown-${suffix}`, 9_999_999);
    expect(unknown.statusCode).toBe(202);

    await db
      .update(githubInstallations)
      .set({ suspendedAt: new Date() })
      .where(eq(githubInstallations.id, installationRowId));
    const suspended = await deliver(`suspended-${suffix}`, installationNumber);
    expect(suspended.statusCode).toBe(202);
    expect(await db.select().from(githubWebhookEvents)).toHaveLength(beforeRows);
    expect(queued).toHaveLength(beforeQueue);
  });

  function deliver(delivery: string, installation: number) {
    const body = payload(installation);
    return app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: headers(delivery, sign(body)),
      payload: body,
    });
  }
});

function payload(installationId: number) {
  return Buffer.from(
    JSON.stringify({
      action: "opened",
      installation: { id: installationId },
      repository: { full_name: "facility-webhook/example" },
      issue: { number: 12, title: "Webhook test" },
    }),
  );
}

function headers(delivery: string, signature: string) {
  return {
    "content-type": "application/json",
    "x-hub-signature-256": signature,
    "x-github-delivery": delivery,
    "x-github-event": "issues",
  };
}

function sign(body: Buffer) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function installationEventPrefix(installationId: string) {
  return `gh_${installationId}_`;
}
