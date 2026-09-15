import { createServer } from "node:http";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { registerWorkspacePreviewSiteRoutes } from "../src/routes/v1/workspace-preview-sites.js";
import type { StoryDomain } from "../src/story-domain.js";
import type { AppConfig } from "../src/types.js";
import { assertSiteSession, SITE_COOKIE } from "../src/workspaces/preview-sites.js";

const site = {
  id: "app",
  orgId: "org_a",
  projectId: "proj_a",
  workspaceId: "ws_a",
  service: "app",
  origin: "https://one.cloudfront.net",
  surfaceToken: "a".repeat(43),
};
const sessionId = "psess_1234567890abcdef";
const token = "t".repeat(43);
const grantCookie = `${SITE_COOKIE}=${sessionId}.${token}`;
const invalid = () =>
  Object.assign(new Error("invalid"), { statusCode: 401, code: "preview_access_invalid" });
let state = "new";
let calls = 0;
const app = Fastify({ logger: false });
const backend = createServer(async (request, response) => {
  calls++;
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (request.url === "/callback") {
    response.writeHead(302, {
      location: "/clients",
      "set-cookie": [
        "app_session=authenticated; Domain=localhost; Path=/; HttpOnly; Secure; SameSite=Lax",
        `${SITE_COOKIE}=forged; Path=/; Secure`,
      ],
    });
    response.end();
    return;
  }
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      url: request.url,
      method: request.method,
      body: Buffer.concat(chunks).toString("base64"),
      cookie: request.headers.cookie,
      host: request.headers["x-forwarded-host"],
      proto: request.headers["x-forwarded-proto"],
      nextAction: request.headers["next-action"],
    }),
  );
});
const wsServer = new WebSocketServer({ server: backend });
wsServer.on("connection", (socket, request) =>
  socket.on("message", () => socket.send(String(request.headers.cookie))),
);
let origin = "";
let backendOrigin = "";
const prefix = "/workspace-preview-site/app";
const headers = { "x-facility-preview-surface": site.surfaceToken, cookie: grantCookie };

describe("stable preview HTTP and WebSocket integration", () => {
  beforeAll(async () => {
    await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
    backendOrigin = `http://127.0.0.1:${(backend.address() as { port: number }).port}`;
    await app.register(cookie);
    await app.register(websocket);
    app.decorate("storyDomain", {
      previews: {
        exchange: async (id: string, received: string, binding: typeof site) => {
          assertSiteSession(site, binding);
          if (id !== sessionId || received !== token || state !== "new") throw invalid();
          state = "active";
          return { ...site, id };
        },
        authorize: async (id: string, received: string) => {
          if (id !== sessionId || received !== token || state !== "active") throw invalid();
          return { ...site, id, workspaceId: state === "active" ? site.workspaceId : "other" };
        },
        target: async (_session: unknown, path: string) => ({
          url: new URL(path, backendOrigin),
          gatewayToken: "gateway",
        }),
      },
    } as unknown as StoryDomain);
    await registerWorkspacePreviewSiteRoutes(app, {
      previewSites: [
        site,
        {
          ...site,
          id: "other",
          workspaceId: "ws_other",
          origin: "https://two.cloudfront.net",
          surfaceToken: "b".repeat(43),
        },
      ],
    } as AppConfig);
    await app.listen({ host: "127.0.0.1", port: 0 });
    origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await app.close();
    wsServer.close();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  });

  it("exchanges once, uses a root HttpOnly cookie, and preserves root callback routing", async () => {
    const launch = `${origin}${prefix}/.facility/auth/${sessionId}?token=${token}`;
    const response = await fetch(launch, { headers, redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.get("set-cookie")).toContain("Path=/; HttpOnly; Secure; SameSite=Lax");
    expect((await fetch(launch, { headers, redirect: "manual" })).status).toBe(401);
    const callback = await fetch(`${origin}${prefix}/callback`, { headers, redirect: "manual" });
    expect(callback.headers.get("location")).toBe(`${site.origin}/clients`);
    expect(callback.headers.getSetCookie()).toEqual([
      "app_session=authenticated; Path=/; HttpOnly; Secure; SameSite=Lax",
    ]);
    const page = await fetch(`${origin}${prefix}/clients`, {
      headers: { ...headers, cookie: `${grantCookie}; app_session=authenticated` },
    });
    expect(await page.json()).toMatchObject({
      url: "/clients",
      cookie: "app_session=authenticated",
      host: "one.cloudfront.net",
      proto: "https",
    });
    expect(page.headers.get("cache-control")).toBe("private, no-store");
  });
  it.each([
    "application/json",
    "application/x-www-form-urlencoded",
    "multipart/form-data; boundary=example",
    "text/x-component",
  ])("preserves %s bodies and encoded URLs", async (type) => {
    const body = Buffer.from("test=one%26two\r\n\u0000\u00ff");
    const response = await fetch(`${origin}${prefix}/action?return=%2Fclients%3Fx%3D1`, {
      method: "POST",
      headers: { ...headers, "content-type": type, "next-action": "abc" },
      body,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      body: body.toString("base64"),
      url: "/action?return=%2Fclients%3Fx%3D1",
      nextAction: "abc",
    });
  });
  it("denies missing, malformed, expired and revoked grants before contacting the app", async () => {
    const before = calls;
    for (const cookieValue of ["", `${SITE_COOKIE}=malformed`, `${grantCookie}.extra`]) {
      expect(
        (
          await fetch(`${origin}${prefix}/clients`, {
            headers: { ...headers, cookie: cookieValue },
          })
        ).status,
      ).toBe(401);
    }
    for (const deniedState of ["expired", "revoked"]) {
      state = deniedState;
      expect((await fetch(`${origin}${prefix}/clients`, { headers })).status).toBe(401);
    }
    state = "active";
    expect(calls).toBe(before);
  });
  it("denies cross-workspace sessions and forged distribution routing", async () => {
    const before = calls;
    expect(
      (
        await fetch(`${origin}/workspace-preview-site/other/clients`, {
          headers: { ...headers, "x-facility-preview-surface": "b".repeat(43) },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${origin}${prefix}/clients`, {
          headers: { ...headers, "x-facility-preview-surface": "forged" },
        })
      ).status,
    ).toBe(404);
    expect(calls).toBe(before);
  });
  it("forwards WebSocket app cookies while removing the Facility grant", async () => {
    const result = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(`${origin.replace("http:", "ws:")}${prefix}/socket`, {
        headers: { ...headers, cookie: `${grantCookie}; app_session=authenticated` },
      });
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error("timeout"));
      }, 3000);
      socket.once("open", () => socket.send("ping"));
      socket.once("message", (data) => {
        clearTimeout(timer);
        socket.close();
        resolve(data.toString());
      });
      socket.once("error", reject);
    });
    expect(result.trim()).toBe("app_session=authenticated");
  });
});
