import { createServer } from "node:http";
import { newId } from "@facility/core";
import {
  createDb,
  githubInstallations,
  migrate,
  orgMembers,
  orgs,
  previewSessions,
  projects,
  roles,
  stories,
  users,
  workspaces,
} from "@facility/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { buildApp, mintSessionCookie } from "../src/app.js";
import type { GithubWorkspaceCredentialBroker } from "../src/github/workspace-credentials.js";
import type { StoryDomain } from "../src/story-domain.js";
import type { AppConfig, Principal } from "../src/types.js";
import { previewChallenge } from "../src/workspaces/native-preview.js";
import { WorkspacePreviewService } from "../src/workspaces/preview.js";
import type {
  ProjectEnvironmentService,
  ProjectManifestSource,
} from "../src/workspaces/project-environment.js";
import type { WorkspaceRuntime } from "../src/workspaces/runtime.js";

const gatewayModule = new URL("../../../runner/facility-preview-gateway.mjs", import.meta.url).href;
const { createPreviewGateway } = await import(gatewayModule);
function required(value: string | null | undefined): string {
  if (!value) throw new Error("Missing response value in native preview fixture");
  return value;
}
const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility_test";
// Critical auth integration must fail, not silently skip, without its local database.
describe("native preview browser flow with persisted authorization", () => {
  const { db, client } = createDb(databaseUrl);
  const orgId = newId("org"),
    projectId = newId("proj"),
    userId = newId("user"),
    roleId = newId("role");
  const storyIds = [newId("story"), newId("story")] as const,
    workspaceIds = [newId("ws"), newId("ws")] as const;
  const origin = "https://native-one.vercel.run",
    secondOrigin = "https://native-two.vercel.run";
  const gatewayToken = "g".repeat(43),
    verifier = "v".repeat(43);
  const actor: Principal = {
    type: "user",
    id: userId,
    userId,
    orgId,
    permissions: ["previews:read"],
  };
  const config = {
    databaseUrl,
    secretMasterKey: Buffer.alloc(32, 31).toString("base64"),
    port: 4400,
    workspaceImage: "facility-runner:test",
    workspaceDriver: "docker",
    facilityInsecureDev: false,
    logLevel: "silent",
    nativePreviews: true,
    webUrl: "https://facility.test",
    publicUrl: "https://api.facility.test",
    previewUrl: "https://facility-preview.test",
    authIdentityProvider: "github",
    githubOauthClientId: "test-client",
    githubOauthClientSecret: "test-secret",
    githubOauthAuthorizeUrl: "https://github.test/login/oauth/authorize",
    githubOauthTokenUrl: "https://github.test/login/oauth/access_token",
    githubOauthApiUrl: "https://api.github.test",
  } as AppConfig;
  const installationId = Date.now(),
    accountId = installationId + 1;
  const authFetch: typeof fetch = async (input) => {
    const url = String(input);
    const json = (value: unknown) => Response.json(value);
    if (url.endsWith("/login/oauth/access_token")) return json({ access_token: "fake-token" });
    if (url.endsWith("/user/emails"))
      return json([{ email: `${userId}@example.test`, verified: true, primary: true }]);
    if (url.includes("/user/installations"))
      return json({ installations: [{ id: installationId, account: { id: accountId } }] });
    if (url.endsWith("/user")) return json({ id: accountId, login: "preview-reader" });
    throw new Error(`Unexpected identity request: ${url}`);
  };
  const execute = vi.fn(() => {
    throw new Error("Must not execute workspace commands");
  });
  const service = new WorkspacePreviewService(
    db,
    config,
    { wake: execute } as unknown as WorkspaceRuntime,
    { issue: execute } as unknown as GithubWorkspaceCredentialBroker,
    { load: execute } as unknown as ProjectManifestSource,
    { prepare: execute, startPrepared: execute } as unknown as ProjectEnvironmentService,
  );
  let api: Awaited<ReturnType<typeof buildApp>>;
  let apiOrigin: string, gatewayOrigin: string;
  let gateway: ReturnType<typeof createServer>;
  let requests = 0;
  const appServer = createServer(async (request, response) => {
    requests++;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.setHeader("content-type", "application/json");
    response.setHeader("set-cookie", [
      "app_session=yes; Domain=vercel.run; Path=/; HttpOnly",
      "__Host-facility-preview=forged; Secure; Path=/",
    ]);
    response.end(
      JSON.stringify({
        url: request.url,
        cookie: request.headers.cookie,
        authorization: request.headers.authorization,
        host: request.headers["x-forwarded-host"],
        body: Buffer.concat(chunks).toString("base64"),
        secret: request.headers["x-facility-preview-token"],
      }),
    );
  });
  const ws = new WebSocketServer({ server: appServer });
  ws.on("connection", (socket, request) =>
    socket.on("message", () => socket.send(String(request.headers.cookie))),
  );
  const endpoint = (url: string) => [{ service: "web", port: 3000, access: "native", url }];
  beforeAll(async () => {
    await migrate(databaseUrl);
    await db.insert(orgs).values({ id: orgId, name: "Native previews", slug: orgId });
    await db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, status: "active" });
    await db
      .insert(roles)
      .values({ id: roleId, orgId, name: "Preview reader", permissions: ["previews:read"] });
    await db.insert(orgMembers).values({ id: newId("member"), orgId, userId, roleId });
    await db.insert(githubInstallations).values({
      id: newId("int"),
      orgId,
      installationId,
      accountId,
      accountLogin: "test",
      targetType: "Organization",
    });
    await db.insert(projects).values({ id: projectId, orgId, name: "Preview", slug: projectId });
    for (const i of [0, 1] as const) {
      await db.insert(stories).values({
        id: storyIds[i],
        orgId,
        projectId,
        provider: "manual",
        externalId: storyIds[i],
        title: "Preview",
        status: "working",
        createdBy: { type: "user", id: userId },
      });
      await db.insert(workspaces).values({
        id: workspaceIds[i],
        orgId,
        projectId,
        storyId: storyIds[i],
        provider: "vercel",
        externalRef: workspaceIds[i],
        volumeRef: workspaceIds[i],
        state: "running",
        setupChecksum: "ready",
        environment: {
          image: "test",
          variables: { FACILITY_PREVIEW_GATEWAY_TOKEN: gatewayToken },
        },
        endpoints: endpoint(i ? secondOrigin : origin),
      });
    }
    // Exercise real login, cookies, middleware and the production limiter, not a
    // route-only Fastify fixture that skips the integration boundaries.
    api = await buildApp(config, { authFetch, storyDomain: { previews: service } as StoryDomain });
    await api.listen({ port: 0, host: "127.0.0.1" });
    apiOrigin = `http://127.0.0.1:${(api.server.address() as { port: number }).port}`;
    await new Promise<void>((resolve) => appServer.listen(0, "127.0.0.1", resolve));
    gateway = createPreviewGateway({
      target: (appServer.address() as { port: number }).port,
      secret: gatewayToken,
      native: {
        apiUrl: apiOrigin,
        webUrl: config.webUrl,
        origin,
        workspaceId: workspaceIds[0],
        service: "web",
      },
    });
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    gatewayOrigin = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
  });
  beforeEach(async () => {
    await db
      .update(roles)
      .set({ permissions: ["previews:read"] })
      .where(eq(roles.id, roleId));
    await db.update(users).set({ status: "active" }).where(eq(users.id, userId));
    await db
      .update(workspaces)
      .set({ state: "running", endpoints: endpoint(origin) })
      .where(eq(workspaces.id, workspaceIds[0]));
    execute.mockClear();
  });
  afterAll(async () => {
    await api?.close();
    ws.close();
    if (gateway) await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await new Promise<void>((resolve) => appServer.close(() => resolve()));
    await client.end();
  });
  const grant = async (workspaceId = workspaceIds[0]) => {
    const result = await service.nativeLogin(actor, workspaceId, "web", previewChallenge(verifier));
    const url = new URL(result.url);
    return {
      workspaceId,
      service: "web",
      sessionId: required(url.searchParams.get("session")),
      code: required(url.searchParams.get("code")),
      verifier,
    };
  };
  const active = async () => {
    const input = await grant();
    const result = await service.nativeExchange(input, gatewayToken);
    return { ...input, token: result.accessToken };
  };
  it.each([
    "/projects/123?tab=files&filter=a%2Fb",
    "/auth/callback?code=app-code&state=app-state%2F123",
  ])("returns through the real Facility login to the original application URL: %s", async (path) => {
    const start = await fetch(gatewayOrigin + path, {
      headers: {
        accept: "text/html",
        cookie: `__Host-facility-preview=psess_${"a".repeat(32)}.${"z".repeat(43)}`,
      },
      redirect: "manual",
    });
    expect(start.status).toBe(302);
    const nonce = required(start.headers.getSetCookie()[0]?.split(";", 1)[0]);
    const previewLogin = new URL(required(start.headers.get("location")));
    expect([...previewLogin.searchParams.keys()]).toEqual(["challenge"]);
    const anonymous = await api.inject({
      url: previewLogin.pathname.slice(4) + previewLogin.search,
    });
    const facilityLogin = new URL(required(anonymous.headers.location));
    const login = await api.inject({ url: facilityLogin.pathname.slice(4) + facilityLogin.search });
    expect(login.statusCode).toBe(302);
    const authorization = new URL(required(login.headers.location));
    expect(authorization.origin).toBe("https://github.test");
    const state = login.cookies.find((cookie) => cookie.name === "facility_oauth_state");
    expect(state).toBeDefined();
    const facilityCallback = await api.inject({
      url: `/auth/callback?code=fake-github-code&state=${authorization.searchParams.get("state")}`,
      headers: { cookie: `${state?.name}=${state?.value}` },
    });
    expect(facilityCallback.statusCode).toBe(302);
    expect(facilityCallback.headers.location).toBe(previewLogin.toString());
    const facilitySession = facilityCallback.cookies.find(
      (cookie) => cookie.name === "facility_session",
    );
    const grant = await api.inject({
      url: previewLogin.pathname.slice(4) + previewLogin.search,
      headers: { cookie: `${facilitySession?.name}=${facilitySession?.value}` },
    });
    expect(grant.statusCode).toBe(302);
    const callback = new URL(required(grant.headers.location));
    const callbackUrl = gatewayOrigin + callback.pathname + callback.search;
    // Altered or missing browser state must not consume the legitimate grant.
    for (const cookie of ["", nonce.replace(/.$/, (last) => (last === "a" ? "b" : "a"))]) {
      expect((await fetch(callbackUrl, { headers: { cookie }, redirect: "manual" })).status).toBe(
        401,
      );
    }
    const exchanged = await fetch(callbackUrl, { headers: { cookie: nonce }, redirect: "manual" });
    expect(exchanged.status).toBe(302);
    expect(exchanged.headers.get("location")).toBe(path);
    const session = required(exchanged.headers.getSetCookie()[0]?.split(";", 1)[0]);
    const application = await fetch(gatewayOrigin + path, {
      headers: { cookie: `${session}; app_state=retained` },
    });
    expect(application.status).toBe(200);
    expect(await application.json()).toMatchObject({ url: path, cookie: "app_state=retained" });
    expect(
      (await fetch(callbackUrl, { headers: { cookie: nonce }, redirect: "manual" })).status,
    ).toBe(401);
  });
  it("authorizes an asset burst beyond 200 requests without caching permissions", async () => {
    const input = await active();
    const cookie = `__Host-facility-preview=${input.sessionId}.${input.token}`;
    const before = requests;
    for (let i = 0; i < 205; i++) {
      const response = await fetch(`${gatewayOrigin}/assets/${i}.js`, { headers: { cookie } });
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }
    expect(requests - before).toBe(205);
    await db.update(roles).set({ permissions: [] }).where(eq(roles.id, roleId));
    expect((await fetch(`${gatewayOrigin}/assets/next.js`, { headers: { cookie } })).status).toBe(
      401,
    );
    expect(requests - before).toBe(205);
  }, 30_000);
  it("bounds authorization traffic separately and leaves the ordinary production limit unchanged", async () => {
    // Malformed requests exercise the real limiter without 6,000 database lookups.
    const url = `/workspace-preview-native/${workspaceIds[0]}/web/authorize`;
    for (let i = 0; i < 6_001; i++) {
      const response = await api.inject({
        method: "POST",
        url,
        remoteAddress: "198.51.100.10",
        payload: {},
        headers: { "x-forwarded-for": `spoofed-${i}` },
      });
      expect(response.statusCode).toBe(i < 6_000 ? 400 : 429);
    }
    // The dedicated authorization bucket did not consume the general API bucket.
    for (let i = 0; i < 201; i++) {
      const response = await api.inject({ url: "/auth/login", remoteAddress: "198.51.100.10" });
      expect(response.statusCode).toBe(i < 200 ? 302 : 429);
    }
  }, 30_000);
  it("allows both previews with one role without executing setup or granting commands", async () => {
    for (const i of [0, 1] as const) {
      const opened = await service.open({
        orgId,
        projectId,
        storyId: storyIds[i],
        userId,
        service: "web",
        canExecute: false,
      });
      expect(opened.url).toBe(i ? secondOrigin : origin);
      const input = await grant(workspaceIds[i]);
      expect(
        new URL(
          (await service.nativeLogin(actor, workspaceIds[i], "web", previewChallenge(verifier)))
            .url,
        ).origin,
      ).toBe(i ? secondOrigin : origin);
      expect(await service.nativeExchange(input, gatewayToken)).toHaveProperty("accessToken");
    }
    expect(execute).not.toHaveBeenCalled();
  });
  it("rejects other organizations/projects, API keys and missing view permissions", async () => {
    for (const wrong of [
      { ...actor, orgId: "other" },
      { ...actor, projectId: "other" },
      { ...actor, type: "key" as const },
      { ...actor, permissions: ["projects:read"] },
    ])
      await expect(
        service.nativeLogin(wrong, workspaceIds[0], "web", previewChallenge(verifier)),
      ).rejects.toMatchObject({ statusCode: 401 });
  });
  it("binds browser and workspace, rotates the code and consumes it atomically", async () => {
    const input = await grant();
    for (const wrong of [
      { ...input, verifier: "b".repeat(43) },
      { ...input, workspaceId: workspaceIds[1] },
      { ...input, service: "other" },
      { ...input, code: "bad" },
    ])
      await expect(service.nativeExchange(wrong, gatewayToken)).rejects.toMatchObject({
        statusCode: 401,
      });
    await expect(service.nativeExchange(input, "")).rejects.toMatchObject({ statusCode: 401 });
    const results = await Promise.allSettled([
      service.nativeExchange(input, gatewayToken),
      service.nativeExchange(input, gatewayToken),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const success = results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{
      accessToken: string;
    }>;
    expect(success.value.accessToken).not.toBe(input.code);
    await expect(
      service.nativeAuthorize({ ...input, token: input.code }, gatewayToken),
    ).rejects.toMatchObject({ statusCode: 401 });
    await expect(
      service.exchange(input.sessionId, success.value.accessToken),
    ).rejects.toMatchObject({ statusCode: 401 });
    await expect(
      service.authorize(input.sessionId, success.value.accessToken),
    ).rejects.toMatchObject({ statusCode: 401 });
  });
  it("rejects expired grants, revoked sessions and changed permissions/origins", async () => {
    const expired = await grant();
    await db
      .update(previewSessions)
      .set({ createdAt: new Date(Date.now() - 120_000) })
      .where(eq(previewSessions.id, expired.sessionId));
    await expect(service.nativeExchange(expired, gatewayToken)).rejects.toMatchObject({
      statusCode: 401,
    });
    const input = await active();
    await expect(service.nativeAuthorize(input, gatewayToken)).resolves.toHaveProperty("expiresAt");
    await db
      .update(roles)
      .set({ permissions: ["projects:read"] })
      .where(eq(roles.id, roleId));
    await expect(service.nativeAuthorize(input, gatewayToken)).rejects.toMatchObject({
      statusCode: 401,
    });
    await db
      .update(roles)
      .set({ permissions: ["previews:read"] })
      .where(eq(roles.id, roleId));
    await db
      .update(workspaces)
      .set({ endpoints: endpoint(secondOrigin) })
      .where(eq(workspaces.id, workspaceIds[0]));
    await expect(service.nativeAuthorize(input, gatewayToken)).rejects.toMatchObject({
      statusCode: 401,
    });
    await db
      .update(workspaces)
      .set({ endpoints: endpoint(origin) })
      .where(eq(workspaces.id, workspaceIds[0]));
    await db
      .update(previewSessions)
      .set({ revokedAt: new Date() })
      .where(eq(previewSessions.id, input.sessionId));
    await expect(service.nativeAuthorize(input, gatewayToken)).rejects.toMatchObject({
      statusCode: 401,
    });
  });
  it("leaves sleeping workspaces alone for preview-only users", async () => {
    await db
      .update(workspaces)
      .set({ state: "sleeping" })
      .where(eq(workspaces.id, workspaceIds[0]));
    await expect(
      service.open({
        orgId,
        projectId,
        storyId: storyIds[0],
        userId,
        service: "web",
        canExecute: false,
      }),
    ).rejects.toMatchObject({ code: "preview_not_running" });
    expect(execute).not.toHaveBeenCalled();
  });
  it("completes browser redirects and preserves app cookies, root paths, POST and WebSockets", async () => {
    const start = await fetch(gatewayOrigin, {
      headers: { accept: "text/html" },
      redirect: "manual",
    });
    expect(start.status).toBe(302);
    const nonce = required(start.headers.getSetCookie()[0]?.split(";", 1)[0]);
    const loginUrl = new URL(required(start.headers.get("location")));
    const apiPath = loginUrl.pathname.slice(4) + loginUrl.search;
    const anonymous = await api.inject({ method: "GET", url: apiPath });
    expect(anonymous.statusCode).toBe(302);
    expect(new URL(required(anonymous.headers.location)).pathname).toBe("/api/auth/login");
    const login = await api.inject({
      method: "GET",
      url: apiPath,
      headers: { cookie: `facility_session=${await mintSessionCookie(config, userId, orgId)}` },
    });
    expect(login.statusCode).toBe(302);
    const callback = new URL(required(login.headers.location));
    const exchanged = await fetch(gatewayOrigin + callback.pathname + callback.search, {
      headers: { cookie: nonce },
      redirect: "manual",
    });
    expect(exchanged.status).toBe(302);
    const cookie = required(exchanged.headers.getSetCookie()[0]?.split(";", 1)[0]);
    expect(exchanged.headers.getSetCookie()[0]).toContain("HttpOnly; SameSite=Lax");
    const body = Buffer.from("a=%2F\u0000\u00ff");
    const response = await fetch(`${gatewayOrigin}/auth/callback?code=app`, {
      method: "POST",
      headers: {
        cookie: `${cookie}; app_session=yes`,
        authorization: "Bearer app-token",
        "x-forwarded-host": "attacker.test",
      },
      body,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      url: "/auth/callback?code=app",
      cookie: "app_session=yes",
      authorization: "Bearer app-token",
      host: "native-one.vercel.run",
      body: body.toString("base64"),
    });
    expect(response.headers.getSetCookie()).toEqual(["app_session=yes; Path=/; HttpOnly"]);
    const socket = new WebSocket(gatewayOrigin.replace("http:", "ws:"), {
      headers: { cookie: `${cookie}; app_session=yes` },
    });
    const message = await new Promise<string>((resolve, reject) => {
      socket.once("open", () => socket.send("ping"));
      socket.once("message", (data) => {
        resolve(data.toString());
        socket.close();
      });
      socket.once("error", reject);
    });
    expect(message).toBe("app_session=yes");
    expect(
      (
        await fetch(gatewayOrigin + callback.pathname + callback.search, {
          headers: { cookie: nonce },
          redirect: "manual",
        })
      ).status,
    ).toBe(401);
  });
  it("does not forward anonymous traffic or sessions belonging to disabled users", async () => {
    const before = requests;
    expect((await fetch(gatewayOrigin, { method: "POST" })).status).toBe(401);
    const input = await active();
    await db.update(users).set({ status: "disabled" }).where(eq(users.id, userId));
    const cookie = `__Host-facility-preview=${input.sessionId}.${input.token}`;
    expect((await fetch(gatewayOrigin, { headers: { cookie } })).status).toBe(401);
    expect(requests).toBe(before);
  });
  it("rejects malformed API requests, missing gateway credentials and expired sessions", async () => {
    const input = await active();
    const url = `/workspace-preview-native/${input.workspaceId}/web/authorize`;
    expect(
      (
        await api.inject({
          method: "POST",
          url,
          payload: { sessionId: input.sessionId, token: "bad" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await api.inject({
          method: "POST",
          url,
          payload: { sessionId: input.sessionId, token: input.token },
        })
      ).statusCode,
    ).toBe(401);
    await db
      .update(previewSessions)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(previewSessions.id, input.sessionId));
    await expect(service.nativeAuthorize(input, gatewayToken)).rejects.toMatchObject({
      statusCode: 401,
    });
  });
  it("fails closed on an unavailable control plane, including WebSocket upgrades", async () => {
    const before = requests;
    const input = await active();
    const unavailable = createPreviewGateway({
      target: (appServer.address() as { port: number }).port,
      secret: gatewayToken,
      native: {
        apiUrl: apiOrigin,
        webUrl: config.webUrl,
        origin,
        workspaceId: workspaceIds[0],
        service: "web",
      },
      fetchImpl: async () => {
        throw new Error("Control plane unavailable");
      },
    });
    await new Promise<void>((resolve) => unavailable.listen(0, "127.0.0.1", resolve));
    try {
      const address = `http://127.0.0.1:${(unavailable.address() as { port: number }).port}`;
      const cookie = `__Host-facility-preview=${input.sessionId}.${input.token}`;
      expect(
        (await fetch(address, { headers: { cookie, accept: "text/html" }, redirect: "manual" }))
          .status,
      ).toBe(503);
      const socket = new WebSocket(address.replace("http:", "ws:"), { headers: { cookie } });
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => {
          socket.close();
          reject(new Error("Denied websocket reached the app"));
        });
        socket.once("error", (error) => {
          expect(error.message).toContain("401");
          resolve();
        });
      });
      expect(requests).toBe(before);
    } finally {
      await new Promise<void>((resolve) => unavailable.close(() => resolve()));
    }
  });
});
