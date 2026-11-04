import { createHmac } from "node:crypto";
import { newId } from "@facility/core";
import {
  createDb,
  githubInstallations,
  githubWebhookEvents,
  migrate,
  orgs,
  projectRepositories,
  projects,
} from "@facility/db";
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
  const projectId = newId("proj");
  const repositoryId = newId("repo");
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
    await db.insert(projects).values({
      id: projectId,
      orgId,
      name: "Webhook project",
      slug: `webhook-project-${suffix}`,
      settings: {},
    });
    await db.insert(projectRepositories).values({
      id: repositoryId,
      orgId,
      projectId,
      installationId: installationRowId,
      owner: "facility-webhook",
      name: "example",
      defaultBranch: "main",
      role: "primary",
    });
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
          projectId,
          repositoryId,
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

  it("applies installation lifecycle events, including unsuspend while suspended", async () => {
    const suspendedAt = async (rowId: string) =>
      (
        await db
          .select({ suspendedAt: githubInstallations.suspendedAt })
          .from(githubInstallations)
          .where(eq(githubInstallations.id, rowId))
      )[0]?.suspendedAt ?? null;
    const beforeRows = (await db.select().from(githubWebhookEvents)).length;
    const beforeQueue = queued.length;
    await db
      .update(githubInstallations)
      .set({ suspendedAt: new Date("2026-01-01T00:00:00Z") })
      .where(eq(githubInstallations.id, installationRowId));

    // The suspended gate must not swallow the event that lifts the suspension.
    const unsuspend = await deliverLifecycle(
      `unsuspend-${suffix}`,
      installationNumber,
      "unsuspend",
      null,
    );
    expect(unsuspend.statusCode).toBe(202);
    expect(await suspendedAt(installationRowId)).toBeNull();

    const suspend = await deliverLifecycle(
      `suspend-${suffix}`,
      installationNumber,
      "suspend",
      "2026-02-03T04:05:06Z",
    );
    expect(suspend.statusCode).toBe(202);
    expect(await suspendedAt(installationRowId)).toEqual(new Date("2026-02-03T04:05:06Z"));

    // Unrelated lifecycle actions leave the state alone.
    await deliverLifecycle(`created-${suffix}`, installationNumber, "created", undefined);
    expect(await suspendedAt(installationRowId)).toEqual(new Date("2026-02-03T04:05:06Z"));

    // Another installation's event never changes this one.
    await db
      .update(githubInstallations)
      .set({ suspendedAt: null })
      .where(eq(githubInstallations.id, installationRowId));
    await deliverLifecycle(
      `other-${suffix}`,
      otherInstallationNumber,
      "suspend",
      "2026-02-03T04:05:06Z",
    );
    expect(await suspendedAt(installationRowId)).toBeNull();
    expect(await suspendedAt(otherInstallationRowId)).toEqual(new Date("2026-02-03T04:05:06Z"));

    // A wrongly signed lifecycle event is rejected and changes nothing.
    const rejected = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: headers(`forged-${suffix}`, "sha256=00", "installation"),
      payload: installationPayload(installationNumber, "deleted", undefined),
    });
    expect(rejected.statusCode).toBe(401);
    expect(await suspendedAt(installationRowId)).toBeNull();

    // Uninstalling keeps the row and suspends it, so every existing gate closes.
    const deleted = await deliverLifecycle(
      `deleted-${suffix}`,
      installationNumber,
      "deleted",
      undefined,
    );
    expect(deleted.statusCode).toBe(202);
    expect(await suspendedAt(installationRowId)).toBeInstanceOf(Date);

    // Lifecycle events are applied directly: no webhook receipt, no worker job.
    expect(await db.select().from(githubWebhookEvents)).toHaveLength(beforeRows);
    expect(queued).toHaveLength(beforeQueue);
  });

  function deliverLifecycle(
    delivery: string,
    installation: number,
    action: string,
    suspendedAt: string | null | undefined,
  ) {
    const body = installationPayload(installation, action, suspendedAt);
    return app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: headers(delivery, sign(body), "installation"),
      payload: body,
    });
  }

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

function headers(delivery: string, signature: string, eventType = "issues") {
  return {
    "content-type": "application/json",
    "x-hub-signature-256": signature,
    "x-github-delivery": delivery,
    "x-github-event": eventType,
  };
}

function installationPayload(
  installationId: number,
  action: string,
  suspendedAt: string | null | undefined,
) {
  return Buffer.from(
    JSON.stringify({
      action,
      installation: {
        id: installationId,
        ...(suspendedAt === undefined ? {} : { suspended_at: suspendedAt }),
      },
    }),
  );
}

function sign(body: Buffer) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function installationEventPrefix(installationId: string) {
  return `gh_${installationId}_`;
}
