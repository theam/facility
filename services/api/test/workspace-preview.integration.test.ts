import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";
import { newId } from "@facility/core";
import {
  createDb,
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
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { GithubWorkspaceCredentialBroker } from "../src/github/workspace-credentials.js";
import { registerWorkspacePreviewRoutes } from "../src/routes/v1/workspace-previews.js";
import type { StoryDomain } from "../src/story-domain.js";
import type { AppConfig } from "../src/types.js";
import { previewCookieName, WorkspacePreviewService } from "../src/workspaces/preview.js";
import type {
  ProjectEnvironmentService,
  ProjectManifestSource,
} from "../src/workspaces/project-environment.js";
import type { WorkspaceRuntime } from "../src/workspaces/runtime.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility_test";

const config: AppConfig = {
  databaseUrl,
  secretMasterKey: Buffer.alloc(32, 31).toString("base64"),
  port: 4400,
  publicUrl: "http://api.test",
  previewUrl: "http://preview.test",
  workspaceImage: "facility-runner:test",
  workspaceDriver: "docker",
  facilityInsecureDev: true,
  logLevel: "silent",
};

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

describe("workspace preview session security", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres is unreachable at DATABASE_URL; preview session tests skipped", () =>
      undefined);
    return;
  }

  const { db, client } = createDb(databaseUrl);
  const suffix = crypto.randomUUID().slice(0, 8);
  const orgId = newId("org");
  const projectId = newId("proj");
  const storyId = newId("story");
  const workspaceId = newId("ws");
  const userId = newId("user");
  const roleId = newId("role");
  const gatewayToken = "g".repeat(48);
  const endpoint = { service: "web", port: 3000, url: "http://127.0.0.1:31000" };
  let service: WorkspacePreviewService;

  beforeAll(async () => {
    await migrate(databaseUrl);
    await db.insert(orgs).values({
      id: orgId,
      name: "Workspace preview security",
      slug: `workspace-preview-${suffix}`,
      settings: {},
    });
    await db.insert(users).values({
      id: userId,
      email: `workspace-preview-${suffix}@example.com`,
      status: "active",
    });
    await db.insert(roles).values({
      id: roleId,
      orgId,
      name: `preview-${suffix}`,
      permissions: ["workspaces:execute"],
    });
    await db.insert(orgMembers).values({ id: newId("member"), orgId, userId, roleId });
    await db.insert(projects).values({
      id: projectId,
      orgId,
      name: "Workspace preview",
      slug: `workspace-preview-${suffix}`,
      settings: {},
    });
    await db.insert(stories).values({
      id: storyId,
      orgId,
      projectId,
      provider: "manual",
      externalId: `preview-${suffix}`,
      title: "Preview a persistent workspace",
      status: "working",
      createdBy: { type: "user", id: userId },
    });
    await db.insert(workspaces).values({
      id: workspaceId,
      orgId,
      projectId,
      storyId,
      provider: "fake",
      externalRef: `fake:${workspaceId}`,
      volumeRef: `fake-volume:${workspaceId}`,
      state: "running",
      environment: {
        image: "facility-runner:test",
        variables: { FACILITY_PREVIEW_GATEWAY_TOKEN: gatewayToken },
        ports: [{ service: "web", port: 3000 }],
      },
      endpoints: [endpoint],
    });

    const runtime = {
      provider: "fake",
      wake: async () => ({ state: "running" }),
    } as unknown as WorkspaceRuntime;
    const credentials = {
      issue: async () => ({
        repositories: [{ owner: "theam", name: "example", defaultBranch: "main", role: "primary" }],
        environment: {},
        expiresAt: new Date(Date.now() + 60_000),
      }),
    } as unknown as GithubWorkspaceCredentialBroker;
    const manifests = {
      load: async () => ({
        version: 1,
        repositories: { primary: "theam/example", related: [] },
        environment: {
          start: "true",
          services: { web: { port: 3000, protocol: "http", websocket: true } },
        },
        hash: "manifest-hash",
      }),
    } as ProjectManifestSource;
    const environment = {
      prepare: async () => ({ endpoints: [endpoint], primaryCwd: "repos/theam/example" }),
    } as unknown as ProjectEnvironmentService;
    service = new WorkspacePreviewService(db, config, runtime, credentials, manifests, environment);
  });

  afterAll(async () => {
    await client.end();
  });

  it("requires a one-time exchange and remains bound to an active organization member", async () => {
    const opened = await service.open({ orgId, projectId, storyId, userId, service: "web" });
    const accessUrl = new URL(opened.url);
    const token = accessUrl.searchParams.get("token");
    if (!token) throw new Error("expected preview access token");

    await expect(service.authorize(opened.sessionId, token)).rejects.toMatchObject({
      code: "preview_access_invalid",
      statusCode: 401,
    });
    await expect(service.exchange(opened.sessionId, token)).resolves.toMatchObject({
      storyId,
      workspaceId,
      service: "web",
    });
    await expect(service.exchange(opened.sessionId, token)).rejects.toMatchObject({
      code: "preview_access_invalid",
    });
    const session = await service.authorize(opened.sessionId, token);
    await expect(service.target(session, "nested/path?mode=preview")).resolves.toMatchObject({
      gatewayToken,
      url: expect.objectContaining({ pathname: "/nested/path", search: "?mode=preview" }),
    });
    await expect(service.target(session, "%2e%2e/admin")).rejects.toMatchObject({
      code: "preview_path_invalid",
      statusCode: 400,
    });

    await db.update(users).set({ status: "disabled" }).where(eq(users.id, userId));
    await expect(service.authorize(opened.sessionId, token)).rejects.toMatchObject({
      code: "preview_access_invalid",
    });
    await db.update(users).set({ status: "active" }).where(eq(users.id, userId));
    await db
      .update(previewSessions)
      .set({ revokedAt: new Date() })
      .where(eq(previewSessions.id, opened.sessionId));
    await expect(service.authorize(opened.sessionId, token)).rejects.toMatchObject({
      code: "preview_access_invalid",
    });
  });

  it("rejects expired and malformed access tokens", async () => {
    const opened = await service.open({ orgId, projectId, storyId, userId, service: "web" });
    const token = new URL(opened.url).searchParams.get("token");
    if (!token) throw new Error("expected preview access token");
    await db
      .update(previewSessions)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(previewSessions.id, opened.sessionId));
    await expect(service.exchange(opened.sessionId, token)).rejects.toMatchObject({
      code: "preview_access_invalid",
    });
    await expect(service.exchange(opened.sessionId, "not-a-token")).rejects.toMatchObject({
      code: "preview_access_invalid",
    });
  });
});

describe("workspace preview HTTP and WebSocket proxy", () => {
  const sessionId = "psess_abcdefghijklmnop";
  const cookieToken = "browser-cookie-token";
  const gatewayToken = "internal-gateway-token-that-is-long-enough";
  let backend = createServer();
  let backendWs: WebSocketServer;
  let gateway: ChildProcess;
  let app = Fastify({ logger: false });
  let appOrigin = "";

  beforeAll(async () => {
    backend = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          method: request.method,
          url: request.url,
          body: Buffer.concat(chunks).toString("utf8"),
          gatewayHeaderVisible: request.headers["x-facility-preview-token"] !== undefined,
        }),
      );
    });
    backendWs = new WebSocketServer({ server: backend });
    backendWs.on("connection", (socket) =>
      socket.on("message", (data) => socket.send(`echo:${data}`)),
    );
    await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
    const backendPort = (backend.address() as { port: number }).port;
    const gatewayPort = await freePort();
    gateway = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../../../runner/facility-preview-gateway.mjs", import.meta.url)),
        "--listen",
        String(gatewayPort),
        "--target",
        String(backendPort),
      ],
      {
        env: { ...process.env, FACILITY_PREVIEW_GATEWAY_TOKEN: gatewayToken },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    await waitForGateway(gatewayPort);

    const previews = {
      authorize: async (receivedSessionId: string, receivedToken: string) => {
        if (receivedSessionId !== sessionId || receivedToken !== cookieToken) {
          throw Object.assign(new Error("invalid"), {
            code: "preview_access_invalid",
            statusCode: 401,
          });
        }
        return { id: sessionId };
      },
      target: async (_session: unknown, path: string) => ({
        url: new URL(path, `http://127.0.0.1:${gatewayPort}/`),
        gatewayToken,
      }),
      exchange: async () => ({ id: sessionId }),
      open: async () => ({ sessionId, url: "http://preview.test", expiresAt: new Date() }),
    };
    app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(cookie);
    await app.register(websocket);
    app.decorate("storyDomain", { previews } as unknown as StoryDomain);
    await registerWorkspacePreviewRoutes(app, config);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address() as { port: number };
    appOrigin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app.close();
    gateway.kill("SIGTERM");
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  });

  it("blocks the provider URL and proxies only a valid Facility cookie", async () => {
    const gatewayPort = Number(gateway.spawnargs[gateway.spawnargs.indexOf("--listen") + 1] ?? "0");
    await expect(fetch(`http://127.0.0.1:${gatewayPort}/private`)).resolves.toMatchObject({
      status: 401,
    });

    const denied = await fetch(`${appOrigin}/workspace-preview/${sessionId}/hello`);
    expect(denied.status).toBe(401);
    const response = await fetch(`${appOrigin}/workspace-preview/${sessionId}/hello?x=1`, {
      method: "POST",
      headers: {
        cookie: `${previewCookieName(sessionId)}=${cookieToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ works: true }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      method: "POST",
      url: "/hello?x=1",
      body: JSON.stringify({ works: true }),
      gatewayHeaderVisible: false,
    });
  });

  it("proxies WebSocket upgrades through the same session and gateway boundary", async () => {
    const response = await websocketMessage(
      `${appOrigin.replace("http:", "ws:")}/workspace-preview/${sessionId}/socket`,
      `${previewCookieName(sessionId)}=${cookieToken}`,
      "ping",
    );
    expect(response).toBe("echo:ping");

    await expect(
      websocketMessage(
        `${appOrigin.replace("http:", "ws:")}/workspace-preview/${sessionId}/socket`,
        "",
        "ping",
      ),
    ).rejects.toThrow();
  });
});

async function freePort() {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitForGateway(port: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/health`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error("preview gateway did not start");
}

function websocketMessage(url: string, cookieValue: string, message: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = new WebSocket(url, { headers: cookieValue ? { cookie: cookieValue } : {} });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("WebSocket response timed out"));
    }, 3_000);
    socket.once("open", () => socket.send(message));
    socket.once("message", (data) => {
      clearTimeout(timer);
      socket.close();
      resolve(data.toString());
    });
    socket.once("close", (code) => {
      if (code === 1000) return;
      clearTimeout(timer);
      reject(new Error(`WebSocket closed with ${code}`));
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
