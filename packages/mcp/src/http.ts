import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createFacilityMcpServer } from "./tools.js";

export type HttpServerOptions = {
  apiUrl: string;
  port: number;
  host?: string;
  allowedHosts?: string[];
  fetch?: typeof fetch;
  // OAuth 2.1 resource-server discovery (RFC 9728). When set, the server
  // advertises the Facility instance authorization server so interactive MCP clients
  // (Claude, Cursor, ChatGPT) can run the OAuth 2.1 / PKCE flow. `fak_` API
  // keys continue to work unchanged for non-interactive service use.
  resourceUrl?: string;
  authorizationServer?: string;
  maxBodyBytes?: number;
  maxRequestsPerMinute?: number;
  /** Trust exactly this many right-most proxy hops when deriving rate-limit identity. */
  trustedProxyHops?: number;
};

const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";

export function serveHttp(options: HttpServerOptions) {
  const host = options.host ?? "127.0.0.1";
  const allowedHosts = configuredHosts(options, host);
  const limiter = new FixedWindowLimiter(options.maxRequestsPerMinute ?? 120, 60_000);
  const credentialValidator = new CredentialValidator(options.apiUrl, options.fetch ?? fetch);
  const trustedProxyHops = nonNegativeInteger(options.trustedProxyHops ?? 0, "trustedProxyHops");
  const server = createServer(async (request, response) => {
    const path = request.url?.split("?")[0] ?? "";
    response.setHeader("x-request-id", randomUUID());
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("cache-control", "no-store");

    // Load balancers address targets by private IP and therefore cannot send
    // the public authority allowlisted for MCP traffic. These read-only probes
    // expose no credentials or tenant data; keep every functional endpoint
    // behind the authority check below.
    if (request.method === "GET" && ["/health", "/healthz"].includes(path)) {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: true, version: "0.3.0", transport: "streamable-http" }));
      return;
    }
    if (request.method === "GET" && path === "/readyz") {
      try {
        const upstream = await (options.fetch ?? fetch)(
          `${options.apiUrl.replace(/\/$/, "")}/health`,
          {
            signal: AbortSignal.timeout(2_000),
          },
        );
        const ok = upstream.ok;
        await upstream.body?.cancel();
        response.writeHead(ok ? 200 : 503, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify({ ok, api: ok ? "up" : "down" }));
      } catch {
        response.writeHead(503, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify({ ok: false, api: "down" }));
      }
      return;
    }

    if (!validRequestAuthority(request, allowedHosts)) {
      response.writeHead(421, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "untrusted request authority" }));
      return;
    }

    // Public OAuth discovery document — served without auth so an interactive
    // client can bootstrap the flow before it holds a token.
    if (request.method === "GET" && path === PROTECTED_RESOURCE_PATH) {
      if (!options.authorizationServer) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "oauth_not_configured" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          resource: options.resourceUrl ?? "",
          authorization_servers: [options.authorizationServer],
          bearer_methods_supported: ["header"],
        }),
      );
      return;
    }

    const admission = limiter.admit(clientAddress(request, trustedProxyHops), Date.now());
    if (!admission.allowed) {
      response.writeHead(429, {
        "content-type": "application/json",
        "retry-after": String(admission.retryAfterSeconds),
      });
      response.end(JSON.stringify({ error: "rate limit exceeded" }));
      return;
    }

    const bearer = bearerToken(request);
    if (!bearer) {
      response.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": wwwAuthenticate(options),
      });
      response.end(JSON.stringify({ error: "missing or invalid bearer token" }));
      return;
    }
    const credential = await credentialValidator.validate(bearer);
    if (credential === "invalid") {
      response.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": wwwAuthenticate(options),
      });
      response.end(JSON.stringify({ error: "missing or invalid bearer token" }));
      return;
    }
    if (credential === "unavailable") {
      response.writeHead(503, {
        "content-type": "application/json",
        "retry-after": "2",
      });
      response.end(JSON.stringify({ error: "credential validation unavailable" }));
      return;
    }
    if (request.method !== "POST" || !["/mcp", "/"].includes(path)) {
      response.writeHead(405, { "content-type": "application/json", allow: "POST" });
      response.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }

    let parsedBody: unknown;
    try {
      parsedBody = await readJsonBody(request, options.maxBodyBytes ?? 1024 * 1024);
    } catch (error) {
      const tooLarge = error instanceof HttpBodyError && error.status === 413;
      response.writeHead(tooLarge ? 413 : 400, {
        "content-type": "application/json",
        ...(tooLarge ? { connection: "close" } : {}),
      });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: tooLarge ? -32001 : -32700,
            message: tooLarge ? "Request body too large" : "Invalid JSON request body",
          },
          id: null,
        }),
      );
      return;
    }

    const mcp = createFacilityMcpServer({
      apiUrl: options.apiUrl,
      apiKey: bearer,
      fetch: options.fetch,
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      void transport.close();
      void mcp.close();
    };
    response.once("close", cleanup);
    request.once("aborted", cleanup);
    try {
      await mcp.connect(transport);
      await transport.handleRequest(request, response, parsedBody);
    } catch (error) {
      cleanup();
      writeError(response, error);
    }
  });
  server.listen(options.port, host);
  return server;
}

class FixedWindowLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
  ) {
    if (!Number.isInteger(maxRequests) || maxRequests < 1) {
      throw new Error("MCP maxRequestsPerMinute must be a positive integer");
    }
  }

  admit(key: string, now: number): { allowed: boolean; retryAfterSeconds: number } {
    const current = this.windows.get(key);
    if (!current || current.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      this.sweep(now);
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (current.count >= this.maxRequests) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1_000)),
      };
    }
    current.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private sweep(now: number) {
    if (this.windows.size < 1_000) return;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }
}

type CredentialStatus = "valid" | "invalid" | "unavailable";

class CredentialValidator {
  private readonly validUntil = new Map<string, number>();

  constructor(
    private readonly apiUrl: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async validate(token: string): Promise<CredentialStatus> {
    const fingerprint = createHash("sha256").update(token).digest("hex");
    const now = Date.now();
    if ((this.validUntil.get(fingerprint) ?? 0) > now) return "valid";
    try {
      const response = await this.fetchImpl(`${this.apiUrl.replace(/\/$/, "")}/v1/me`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2_000),
      });
      await response.body?.cancel().catch(() => undefined);
      // A 403 still proves the control plane authenticated the credential; the
      // requested MCP operation will enforce its own narrower permission.
      if (response.ok || response.status === 403) {
        this.validUntil.set(fingerprint, now + 5_000);
        this.sweep(now);
        return "valid";
      }
      return response.status === 401 ? "invalid" : "unavailable";
    } catch {
      return "unavailable";
    }
  }

  private sweep(now: number) {
    if (this.validUntil.size < 1_000) return;
    for (const [fingerprint, expiresAt] of this.validUntil) {
      if (expiresAt <= now) this.validUntil.delete(fingerprint);
    }
  }
}

class HttpBodyError extends Error {
  constructor(readonly status: number) {
    super(status === 413 ? "request_body_too_large" : "invalid_json");
  }
}

async function readJsonBody(request: IncomingMessage, maxBytes: number) {
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new HttpBodyError(413);
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buffer.length;
    if (received > maxBytes) throw new HttpBodyError(413);
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpBodyError(400);
  }
}

function configuredHosts(options: HttpServerOptions, bindHost: string) {
  const hosts = new Set((options.allowedHosts ?? []).map(normalizeAuthority));
  if (options.resourceUrl) {
    try {
      hosts.add(normalizeAuthority(new URL(options.resourceUrl).host));
    } catch {
      throw new Error("MCP resourceUrl must be an absolute URL");
    }
  }
  if (isLoopback(bindHost)) {
    hosts.add("localhost");
    hosts.add("127.0.0.1");
    hosts.add("[::1]");
  } else if (hosts.size === 0) {
    throw new Error(
      "MCP allowedHosts or resourceUrl is required when binding to a non-loopback interface",
    );
  }
  return hosts;
}

function validRequestAuthority(request: IncomingMessage, allowedHosts: Set<string>) {
  const authority = request.headers.host;
  if (!authority || !allowedHosts.has(normalizeAuthority(authority))) return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return allowedHosts.has(normalizeAuthority(new URL(origin).host));
  } catch {
    return false;
  }
}

function normalizeAuthority(authority: string) {
  const lower = authority.trim().toLowerCase();
  if (lower.startsWith("[")) return lower.replace(/\]:\d+$/, "]");
  return lower.replace(/:\d+$/, "");
}

function isLoopback(host: string) {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host.toLowerCase());
}

function bearerToken(request: IncomingMessage): string {
  const header = request.headers.authorization;
  if (typeof header !== "string") return "";
  return header.match(/^Bearer\s+(\S+)\s*$/i)?.[1] ?? "";
}

function clientAddress(request: IncomingMessage, trustedProxyHops: number): string {
  const socketAddress = request.socket.remoteAddress ?? "unknown";
  if (trustedProxyHops === 0) return socketAddress;
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded !== "string") return socketAddress;
  const chain = [
    ...forwarded
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    socketAddress,
  ];
  const index = Math.max(0, chain.length - 1 - trustedProxyHops);
  return chain[index] ?? socketAddress;
}

function nonNegativeInteger(value: number, label: string) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`MCP ${label} must be a non-negative integer`);
  }
  return value;
}

function wwwAuthenticate(options: HttpServerOptions): string {
  if (options.authorizationServer && options.resourceUrl) {
    return `Bearer resource_metadata="${options.resourceUrl}${PROTECTED_RESOURCE_PATH}"`;
  }
  return "Bearer";
}

function writeError(response: ServerResponse, error: unknown) {
  if (response.headersSent) return;
  // Log server-side; return a generic JSON-RPC error so upstream/config detail
  // is never leaked to the client.
  console.error("mcp http error", error);
  response.writeHead(500, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal server error" },
      id: null,
    }),
  );
}
