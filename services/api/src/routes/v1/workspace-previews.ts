import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { request as upstreamRequest } from "undici";
import WebSocket from "ws";
import { z } from "zod";
import { ApiError } from "../../errors.js";
import type { AppConfig } from "../../types.js";
import { previewCookieName, previewCookieOptions } from "../../workspaces/preview.js";
import { principal as authenticatedPrincipal } from "./shared.js";

const OpenParams = z.object({ projectId: z.string(), storyId: z.string(), service: z.string() });
const SessionParams = z.object({ sessionId: z.string() });
const SessionPathParams = z.object({ sessionId: z.string(), "*": z.string().optional() });
const ExchangeQuery = z.object({ token: z.string() });

export async function registerWorkspacePreviewRoutes(app: FastifyInstance, config: AppConfig) {
  const previews = app.storyDomain.previews;

  app.post(
    "/v1/projects/:projectId/workspace-stories/:storyId/preview/:service/open",
    {
      config: { permission: "workspaces:execute", idempotent: true },
      schema: { params: OpenParams, operationId: "openWorkspacePreview" },
    },
    async (request) => {
      const actor = authenticatedPrincipal(request);
      if (actor.type !== "user" || !actor.userId) {
        throw new ApiError(403, "preview_user_required", "Preview access requires a user session");
      }
      const userId = actor.userId;
      const { projectId, storyId, service } = request.params as z.infer<typeof OpenParams>;
      return translate(() =>
        previews.open({
          orgId: actor.orgId,
          projectId,
          storyId,
          userId,
          service,
        }),
      );
    },
  );

  app.get(
    "/workspace-preview-auth/:sessionId",
    {
      config: { public: true },
      schema: {
        params: SessionParams,
        querystring: ExchangeQuery,
        operationId: "exchangeWorkspacePreviewAccess",
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params as z.infer<typeof SessionParams>;
      const { token } = request.query as z.infer<typeof ExchangeQuery>;
      await translate(() => previews.exchange(sessionId, token));
      reply.setCookie(previewCookieName(sessionId), token, previewCookieOptions(config, sessionId));
      reply.header("cache-control", "no-store");
      reply.header("referrer-policy", "no-referrer");
      return reply.redirect(`/workspace-preview/${encodeURIComponent(sessionId)}/`);
    },
  );

  const proxy = async (request: FastifyRequest, reply: FastifyReply) => {
    const { sessionId } = request.params as z.infer<typeof SessionPathParams>;
    const path = (request.params as z.infer<typeof SessionPathParams>)["*"] ?? "";
    const token = request.cookies[previewCookieName(sessionId)] ?? "";
    const session = await translate(() => previews.authorize(sessionId, token));
    const target = await translate(() =>
      previews.target(session, pathWithQuery(path, request.url)),
    );
    const body =
      request.method === "GET" || request.method === "HEAD" ? undefined : requestBody(request);
    const upstream = await upstreamRequest(target.url, {
      method: request.method as "GET",
      headers: forwardedHeaders(request.headers, target.gatewayToken),
      body,
    });
    reply.status(upstream.statusCode);
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-content-type-options", "nosniff");
    for (const name of ["content-type", "cache-control", "etag", "last-modified"]) {
      const value = upstream.headers[name];
      if (value) reply.header(name, value);
    }
    const location = upstream.headers.location;
    if (typeof location === "string") {
      reply.header("location", rewriteLocation(location, sessionId, target.url));
    }
    if (request.method === "HEAD") return reply.send();
    if (String(upstream.headers["content-type"] ?? "").includes("text/html")) {
      return reply.send(rewriteHtml(await upstream.body.text(), sessionId));
    }
    return reply.send(upstream.body);
  };

  for (const url of ["/workspace-preview/:sessionId", "/workspace-preview/:sessionId/*"]) {
    const pathSuffix = url.endsWith("/*") ? "Path" : "";
    app.route({
      method: "GET",
      url,
      exposeHeadRoute: false,
      config: { public: true },
      schema: {
        params: url.endsWith("/*") ? SessionPathParams : SessionParams,
        operationId: `getWorkspacePreview${pathSuffix}`,
      },
      handler: proxy,
      wsHandler: (socket, request) => {
        const { sessionId } = request.params as z.infer<typeof SessionPathParams>;
        const path = (request.params as z.infer<typeof SessionPathParams>)["*"] ?? "";
        const token = request.cookies[previewCookieName(sessionId)] ?? "";
        const pending: Array<{ data: WebSocket.RawData; binary: boolean }> = [];
        let upstream: WebSocket | undefined;
        socket.on("message", (data, binary) => {
          if (upstream?.readyState === WebSocket.OPEN) upstream.send(data, { binary });
          else pending.push({ data, binary });
        });
        const authorized = previews
          .authorize(sessionId, token)
          .then((session) => previews.target(session, pathWithQuery(path, request.url)));
        void authorized
          .then((target) => {
            const targetUrl = new URL(target.url);
            targetUrl.protocol = targetUrl.protocol === "https:" ? "wss:" : "ws:";
            upstream = new WebSocket(targetUrl, {
              headers: { "x-facility-preview-token": target.gatewayToken },
            });
            upstream.on("open", () => {
              for (const message of pending.splice(0))
                upstream?.send(message.data, { binary: message.binary });
            });
            upstream.on("message", (data, binary) => socket.send(data, { binary }));
            upstream.on("close", (code, reason) => closeWebSocket(socket, code, reason.toString()));
            upstream.on("error", () => socket.close(1011, "Preview service unavailable"));
            socket.on("close", (code, reason) => {
              if (upstream) closeWebSocket(upstream, code, reason.toString());
            });
          })
          .catch(() => socket.close(1008, "Preview access invalid"));
      },
    });
    for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const) {
      app.route({
        method,
        url,
        config: { public: true },
        schema: {
          params: url.endsWith("/*") ? SessionPathParams : SessionParams,
          operationId: `${method.toLowerCase()}WorkspacePreview${pathSuffix}`,
        },
        handler: proxy,
      });
    }
  }
}

function closeWebSocket(socket: WebSocket, code: number, reason: string) {
  if (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING) return;
  if (code === 1000 || (code >= 3000 && code <= 4999)) socket.close(code, reason);
  else socket.terminate();
}

function pathWithQuery(path: string, requestUrl: string) {
  const query = requestUrl.includes("?") ? `?${requestUrl.split("?", 2)[1]}` : "";
  return `${path}${query}`;
}

function forwardedHeaders(
  headers: Record<string, string | string[] | undefined>,
  gatewayToken: string,
) {
  const forwarded: Record<string, string> = {
    accept: String(headers.accept ?? "*/*"),
    "accept-encoding": "identity",
    "x-facility-preview-token": gatewayToken,
  };
  for (const name of ["content-type", "user-agent", "if-none-match", "if-modified-since"]) {
    if (headers[name]) forwarded[name] = String(headers[name]);
  }
  return forwarded;
}

function requestBody(request: FastifyRequest) {
  if (request.body === undefined || request.body === null) return undefined;
  if (typeof request.body === "string" || Buffer.isBuffer(request.body)) return request.body;
  return JSON.stringify(request.body);
}

function rewriteLocation(location: string, sessionId: string, upstream: URL) {
  const prefix = `/workspace-preview/${encodeURIComponent(sessionId)}`;
  if (location.startsWith("/")) return `${prefix}${location}`;
  try {
    const target = new URL(location);
    if (target.origin === upstream.origin)
      return `${prefix}${target.pathname}${target.search}${target.hash}`;
  } catch {
    // Relative locations remain relative to the authenticated proxy path.
  }
  return location;
}

function rewriteHtml(html: string, sessionId: string) {
  const prefix = `/workspace-preview/${encodeURIComponent(sessionId)}/`;
  return html.replace(/\b(href|src|action)=(['"])\/(?!\/)/gi, `$1=$2${prefix}`);
}

async function translate<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const value = error as { statusCode?: unknown; code?: unknown; message?: unknown };
    if (typeof value.code === "string") {
      throw new ApiError(
        typeof value.statusCode === "number" ? value.statusCode : 409,
        value.code,
        typeof value.message === "string" ? value.message : value.code,
      );
    }
    throw error;
  }
}
