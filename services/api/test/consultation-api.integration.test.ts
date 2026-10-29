import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { generateApiKey, seal } from "@facility/core";
import { apiKeys, roles, turns } from "@facility/db";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp, mintSessionCookie } from "../src/app.js";
import { createStoryDomain } from "../src/story-domain.js";
import type { AppConfig } from "../src/types.js";
import { FakeWorkspaceRuntime } from "../src/workspaces/fake.js";
import { consultationDatabaseUrl, consultationTestEnvironment } from "./fixtures/consultations.js";

let env: Awaited<ReturnType<typeof consultationTestEnvironment>>;
let app: Awaited<ReturnType<typeof buildApp>>;
let config: AppConfig;
const nativeEnqueue = vi.fn(async () => undefined);
const runtime = new FakeWorkspaceRuntime("/tmp/facility-consultation-api-unused");
const execution = vi.spyOn(runtime, "exec");
type Fixture = Awaited<
  ReturnType<Awaited<ReturnType<typeof consultationTestEnvironment>>["fixture"]>
>;
const path = (f: Fixture) =>
  `/v1/projects/${f.scope.projectId}/workspace-stories/${f.scope.storyId}/consultations`;
async function key(f: Fixture) {
  const generated = await generateApiKey("fak");
  await env.db.insert(apiKeys).values({
    id: generated.id,
    orgId: f.scope.orgId,
    name: "Consultation test key",
    prefix: generated.lookup,
    last4: generated.last4,
    hash: generated.hash,
    roleId: f.roleId,
    scopeType: "project",
    projectId: f.scope.projectId,
  });
  return {
    id: generated.id,
    secret: generated.secret,
    headers: { authorization: `Bearer ${generated.secret}` },
  };
}
async function setup() {
  const f = await env.fixture();
  app.storyDomain.consultations = f.service;
  return f;
}
beforeAll(async () => {
  env = await consultationTestEnvironment();
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  config = {
    databaseUrl: consultationDatabaseUrl,
    secretMasterKey: Buffer.alloc(32, 44).toString("base64"),
    port,
    publicUrl: `http://127.0.0.1:${port}`,
    webUrl: `http://127.0.0.1:${port}`,
    workspaceDriver: "docker",
    workspaceImage: "facility-runner:test",
    facilityInsecureDev: true,
    logLevel: "silent",
  };
  const domain = createStoryDomain({ db: env.db, config, runtime, enqueue: nativeEnqueue });
  app = await buildApp(config, { storyDomain: domain, rateLimitMax: 10_000 });
  await app.listen({ port, host: "127.0.0.1" });
});
afterAll(async () => {
  await app?.close();
  await env?.client.end();
});

describe("consultation API and embedded MCP authority", () => {
  it("uses a browser session actor, returns a durable receipt and validates body/header identity", async () => {
    const f = await setup();
    const cookie = `facility_session=${await mintSessionCookie(config, f.userId, f.scope.orgId)}`;
    const body = await f.body();
    const mismatch = await app.inject({
      method: "POST",
      url: path(f),
      headers: { cookie, "idempotency-key": randomUUID() },
      payload: body,
    });
    expect(mismatch.statusCode).toBe(400);
    const response = await app.inject({
      method: "POST",
      url: path(f),
      headers: { cookie, "idempotency-key": body.idempotency_key },
      payload: body,
    });
    expect(response.statusCode, response.body).toBe(202);
    expect(response.json()).toMatchObject({
      state: "queued",
      actor: { type: "user", id: f.userId },
      billing: { costsVisible: false, costCents: null },
    });
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(f.fetch).not.toHaveBeenCalled();
    expect(execution).not.toHaveBeenCalled();
  });

  it("denies missing/expired authentication, forged actor/model fields and viewer writes", async () => {
    const f = await setup();
    const body = await f.body();
    const headers = { "idempotency-key": body.idempotency_key };
    expect(
      (await app.inject({ method: "POST", url: path(f), headers, payload: body })).statusCode,
    ).toBe(401);
    const expired = `facility_session=${await seal(JSON.stringify({ userId: f.userId, orgId: f.scope.orgId, exp: Date.now() - 1 }), config.secretMasterKey)}`;
    expect(
      (
        await app.inject({
          method: "POST",
          url: path(f),
          headers: { ...headers, cookie: expired },
          payload: body,
        })
      ).statusCode,
    ).toBe(401);
    const credential = await key(f);
    for (const extra of [{ actor: { type: "user", id: "forged" } }, { model: "custom" }])
      expect(
        (
          await app.inject({
            method: "POST",
            url: path(f),
            headers: { ...credential.headers, "idempotency-key": randomUUID() },
            payload: { ...body, ...extra },
          })
        ).statusCode,
      ).toBe(400);
    await env.db
      .update(roles)
      .set({ permissions: ["projects:read"] })
      .where(eq(roles.id, f.roleId));
    expect(
      (
        await app.inject({
          method: "POST",
          url: path(f),
          headers: { ...credential.headers, ...headers },
          payload: body,
        })
      ).statusCode,
    ).toBe(403);
    const read = await app.inject({ url: path(f), headers: credential.headers });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ total: 0, items: [] });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("refreshes key authority before HTTP replay and before the queued worker starts", async () => {
    const f = await setup(),
      credential = await key(f),
      body = await f.body();
    const options = {
      method: "POST" as const,
      url: path(f),
      headers: { ...credential.headers, "idempotency-key": body.idempotency_key },
      payload: body,
    };
    const accepted = await app.inject(options);
    expect(accepted.statusCode).toBe(202);
    const id = accepted.json().id as string;
    await env.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(apiKeys.id, credential.id));
    expect((await app.inject(options)).statusCode).toBe(401);
    await f.service.dispatch({ ...f.scope, consultationId: id });
    expect(await f.service.get(f.scope, id)).toMatchObject({
      state: "failed",
      errorCode: "consultation_authorization_revoked",
    });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("keeps a rescoping key and a foreign tenant out of previous receipts", async () => {
    const f = await setup(),
      credential = await key(f),
      body = await f.body();
    const options = {
      method: "POST" as const,
      url: path(f),
      headers: { ...credential.headers, "idempotency-key": body.idempotency_key },
      payload: body,
    };
    expect((await app.inject(options)).statusCode).toBe(202);
    const other = await env.fixture();
    await env.db
      .update(apiKeys)
      .set({ projectId: other.scope.projectId })
      .where(eq(apiKeys.id, credential.id));
    expect((await app.inject(options)).statusCode).toBe(404);
    const foreign = await env.fixture(env.otherOrgId),
      foreignKey = await key(foreign);
    expect((await app.inject({ url: path(f), headers: foreignKey.headers })).statusCode).toBe(404);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("masks cost amounts on write receipts and rechecks cost visibility on every read", async () => {
    const f = await setup(),
      credential = await key(f),
      body = await f.body();
    const response = await app.inject({
      method: "POST",
      url: path(f),
      headers: { ...credential.headers, "idempotency-key": body.idempotency_key },
      payload: body,
    });
    const id = response.json().id as string;
    await f.service.dispatch({ ...f.scope, consultationId: id });
    const read = await app.inject({ url: `${path(f)}/${id}`, headers: credential.headers });
    expect(read.json().billing).toMatchObject({
      costsVisible: true,
      state: "confirmed",
      costCents: expect.any(Number),
    });
    const cancelKey = randomUUID();
    const cancel = {
      method: "POST" as const,
      url: `${path(f)}/${id}/cancel`,
      headers: { ...credential.headers, "idempotency-key": cancelKey },
      payload: { idempotency_key: cancelKey },
    };
    expect((await app.inject(cancel)).json().billing).toMatchObject({
      costsVisible: false,
      costCents: null,
    });
    await env.db
      .update(roles)
      .set({ permissions: ["projects:read", "workspaces:execute"] })
      .where(eq(roles.id, f.roleId));
    expect((await app.inject(cancel)).json().billing).toMatchObject({
      costsVisible: false,
      costCents: null,
    });
    expect(
      (await app.inject({ url: `${path(f)}/${id}`, headers: credential.headers })).json().billing,
    ).toMatchObject({ costsVisible: false, costCents: null, estimatedCents: null });
    const list = (await app.inject({ url: path(f), headers: credential.headers })).json();
    expect(list.items[0].billing).toMatchObject({ costsVisible: false, costCents: null });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it("uses the same authenticated HTTP MCP flow for options, charged intent, result, handoff and cancel", async () => {
    const f = await setup(),
      credential = await key(f);
    const client = new Client({ name: "consultation-acceptance", version: "0.12.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${config.publicUrl}/mcp`), {
        requestInit: { headers: credential.headers },
      }),
    );
    const payload = (value: unknown) => {
      const content =
        value && typeof value === "object" && "content" in value ? value.content : undefined;
      const block = Array.isArray(content)
        ? (content[0] as { type?: unknown; text?: unknown })
        : undefined;
      if (block?.type !== "text" || typeof block.text !== "string")
        throw new Error("Expected a JSON text MCP result");
      return JSON.parse(block.text);
    };
    try {
      const options = payload(
        await client.callTool({
          name: "facility_get_consultation_options",
          arguments: { projectId: f.scope.projectId, storyId: f.scope.storyId },
        }),
      );
      const started = payload(
        await client.callTool({
          name: "facility_consult_story",
          arguments: {
            projectId: f.scope.projectId,
            storyId: f.scope.storyId,
            agent: "reviewer",
            expectedAgentHash: options.agents[0].manifestHash,
            expectedCatalogSha: options.catalogSha,
            message: "Consult without running tools.",
            idempotencyKey: randomUUID(),
          },
        }),
      );
      expect(started).toMatchObject({
        state: "queued",
        actor: { type: "service", id: credential.id },
      });
      await f.service.dispatch({ ...f.scope, consultationId: started.id });
      const final = payload(
        await client.callTool({
          name: "facility_get_consultations",
          arguments: {
            projectId: f.scope.projectId,
            storyId: f.scope.storyId,
            consultationId: started.id,
          },
        }),
      );
      expect(final).toMatchObject({
        state: "succeeded",
        executor: "provider_api_text",
        billing: { state: "confirmed" },
      });
      const draft = payload(
        await client.callTool({
          name: "facility_prepare_consultation_handoff",
          arguments: {
            projectId: f.scope.projectId,
            storyId: f.scope.storyId,
            consultationId: started.id,
          },
        }),
      );
      expect(draft).toMatchObject({
        requiresExplicitSend: true,
        consultationId: started.id,
        resultHash: final.resultHash,
      });
      expect(
        await env.db.select().from(turns).where(eq(turns.storyId, f.scope.storyId)),
      ).toHaveLength(1);
      expect(nativeEnqueue).not.toHaveBeenCalled();
      expect(execution).not.toHaveBeenCalled();
      expect(JSON.stringify(f.fetch.mock.calls)).not.toContain(credential.secret);
      const second = payload(
        await client.callTool({
          name: "facility_consult_story",
          arguments: {
            projectId: f.scope.projectId,
            storyId: f.scope.storyId,
            agent: "reviewer",
            expectedAgentHash: options.agents[0].manifestHash,
            expectedCatalogSha: options.catalogSha,
            message: "Another consultation, canceled before dispatch.",
            idempotencyKey: randomUUID(),
          },
        }),
      );
      const canceled = payload(
        await client.callTool({
          name: "facility_cancel_consultation",
          arguments: {
            projectId: f.scope.projectId,
            storyId: f.scope.storyId,
            consultationId: second.id,
            idempotencyKey: randomUUID(),
          },
        }),
      );
      expect(canceled.state).toBe("canceled");
      await f.service.dispatch({ ...f.scope, consultationId: second.id });
      expect(f.fetch).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
    }
  });
});
