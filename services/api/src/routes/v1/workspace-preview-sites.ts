import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { request as upstreamRequest } from "undici";
import WebSocket from "ws";
import { ApiError } from "../../errors.js";
import type { AppConfig } from "../../types.js";
import {
  assertSiteSession,
  isSiteSurface,
  type PreviewSite,
  SITE_COOKIE,
  SITE_PREFIX,
} from "../../workspaces/preview-sites.js";

const reservedCookie = (name: string) =>
  name === SITE_COOKIE || name.startsWith("facility_") || name.startsWith("__Host-facility");
const hopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

export function siteRequestHeaders(
  headers: FastifyRequest["headers"],
  site: PreviewSite,
  gatewayToken: string,
) {
  const forwarded: Record<string, string> = {};
  const connectionHeaders = String(headers.connection ?? "")
    .toLowerCase()
    .split(",")
    .map((value) => value.trim());
  for (const [name, value] of Object.entries(headers)) {
    if (
      value === undefined ||
      hopHeaders.has(name) ||
      connectionHeaders.includes(name) ||
      /^(?:x-facility-|x-forwarded-|forwarded$|sec-websocket-|cookie$|authorization$|proxy-)/.test(
        name,
      )
    )
      continue;
    forwarded[name] = String(value);
  }
  const cookies = String(headers.cookie ?? "")
    .split(";")
    .filter((entry) => {
      const name = entry.trim().split("=", 1)[0] ?? "";
      return name && !reservedCookie(name);
    })
    .join(";");
  if (cookies) forwarded.cookie = cookies;
  // The application may use bearer auth; it is scoped to this isolated browser
  // origin and never interpreted as a Facility credential on these routes.
  if (headers.authorization) forwarded.authorization = headers.authorization;
  forwarded["accept-encoding"] = "identity";
  forwarded["x-facility-preview-token"] = gatewayToken;
  forwarded["x-forwarded-host"] = new URL(site.origin).host;
  forwarded["x-forwarded-proto"] = new URL(site.origin).protocol.slice(0, -1);
  return forwarded;
}

export function siteResponseCookies(values: string[]) {
  return values
    .filter((value) => !reservedCookie(value.split("=", 1)[0]?.trim() ?? ""))
    .map((value) =>
      value
        .split(";")
        .filter((part) => !/^\s*domain\s*=/i.test(part))
        .join(";"),
    );
}

function siteRequest(config: AppConfig, request: FastifyRequest) {
  const { siteId, "*": path = "" } = request.params as { siteId: string; "*"?: string };
  if (!isSiteSurface(config, request.url, request.headers["x-facility-preview-surface"])) {
    throw new ApiError(404, "not_found", "Route not found");
  }
  const site = config.previewSites?.find((entry) => entry.id === siteId);
  if (!site) throw new ApiError(404, "not_found", "Route not found");
  const raw = request.cookies[SITE_COOKIE] ?? "";
  const [sessionId = "", token = "", extra] = raw.split(".");
  if (extra !== undefined)
    throw new ApiError(401, "preview_access_invalid", "Preview access is invalid or expired");
  // Preserve the wire path and query: Fastify's wildcard params are decoded.
  const wirePath = request.url.slice(`${SITE_PREFIX}${site.id}`.length) || "/";
  return { site, path, wirePath, sessionId, token };
}

export async function registerWorkspacePreviewSiteRoutes(root: FastifyInstance, config: AppConfig) {
  const previews = root.storyDomain.previews;
  await root.register(async (app) => {
    // Keep form, multipart, RSC/server-action and JSON payloads byte-for-byte.
    app.removeAllContentTypeParsers();
    app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) =>
      done(null, body),
    );
    const authorize = async (request: FastifyRequest) => {
      const input = siteRequest(config, request);
      if (input.path.startsWith(".facility/"))
        throw new ApiError(404, "not_found", "Route not found");
      const session = await previews.authorize(input.sessionId, input.token);
      assertSiteSession(input.site, session);
      const target = await previews.target(session, input.wirePath);
      return { ...input, target };
    };
    const proxy = async (request: FastifyRequest, reply: FastifyReply) => {
      const input = siteRequest(config, request);
      if (input.path.startsWith(".facility/auth/")) {
        if (request.method !== "GET")
          throw new ApiError(405, "method_not_allowed", "Method not allowed");
        const sessionId = input.path.slice(".facility/auth/".length);
        const token = new URL(request.url, input.site.origin).searchParams.get("token") ?? "";
        await previews.exchange(sessionId, token, input.site);
        reply.setCookie(SITE_COOKIE, `${sessionId}.${token}`, {
          httpOnly: true,
          secure: true,
          sameSite: "lax",
          path: "/",
          maxAge: 3600,
        });
        return reply
          .header("cache-control", "no-store")
          .header("referrer-policy", "no-referrer")
          .redirect("/");
      }
      const { site, target } = await authorize(request);
      const upstream = await upstreamRequest(target.url, {
        method: request.method as "GET",
        headers: siteRequestHeaders(request.headers, site, target.gatewayToken),
        body:
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : (request.body as Buffer | undefined),
        headersTimeout: 60_000,
        bodyTimeout: 60_000,
      });
      reply.code(upstream.statusCode);
      for (const [name, value] of Object.entries(upstream.headers)) {
        if (
          value === undefined ||
          hopHeaders.has(name) ||
          name === "set-cookie" ||
          name === "location" ||
          name.startsWith("x-facility-")
        )
          continue;
        reply.header(name, value);
      }
      const cookies = upstream.headers["set-cookie"];
      if (cookies)
        reply.header(
          "set-cookie",
          siteResponseCookies(Array.isArray(cookies) ? cookies : [cookies]),
        );
      const location = upstream.headers.location;
      if (typeof location === "string") {
        let destination = location;
        try {
          const url = new URL(location, target.url);
          if (url.origin === target.url.origin)
            destination = `${site.origin}${url.pathname}${url.search}${url.hash}`;
        } catch {
          /* Preserve application redirects that are not absolute URLs. */
        }
        reply.header("location", destination);
      }
      // Session revocation/membership checks must run even for cached assets.
      reply.header("cache-control", "private, no-store");
      reply.header("referrer-policy", "no-referrer");
      reply.header("x-content-type-options", "nosniff");
      if (request.method === "HEAD") {
        await upstream.body.dump();
        return reply.send();
      }
      return reply.send(upstream.body);
    };
    app.route({
      method: "GET",
      exposeHeadRoute: false,
      url: `${SITE_PREFIX}:siteId/*`,
      config: { public: true, cors: false },
      handler: proxy,
      wsHandler: (socket, request) => {
        let upstream: WebSocket | undefined;
        let pendingBytes = 0;
        const pending: Array<{ data: WebSocket.RawData; binary: boolean }> = [];
        socket.on("message", (data, binary) => {
          if (upstream?.readyState === WebSocket.OPEN) upstream.send(data, { binary });
          else {
            pendingBytes += Buffer.byteLength(data.toString());
            if (pendingBytes > 1024 * 1024) {
              socket.close(1009, "Message too large");
              return;
            }
            pending.push({ data, binary });
          }
        });
        socket.on("close", () => upstream?.terminate());
        void authorize(request)
          .then(({ site, target }) => {
            if (socket.readyState !== WebSocket.OPEN) return;
            const url = new URL(target.url);
            url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
            const protocols = String(request.headers["sec-websocket-protocol"] ?? "")
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean);
            upstream = new WebSocket(url, protocols, {
              headers: siteRequestHeaders(request.headers, site, target.gatewayToken),
            });
            upstream.on("open", () => {
              for (const message of pending.splice(0))
                upstream?.send(message.data, { binary: message.binary });
            });
            upstream.on("message", (data, binary) => {
              if (socket.readyState === WebSocket.OPEN) socket.send(data, { binary });
            });
            upstream.on("close", () => socket.close());
            upstream.on("error", () => socket.close(1011, "Preview service unavailable"));
          })
          .catch(() => socket.close(1008, "Preview access invalid"));
      },
    });
    for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const) {
      app.route({
        method,
        url: `${SITE_PREFIX}:siteId/*`,
        config: { public: true, cors: false },
        handler: proxy,
      });
    }
  });
}
