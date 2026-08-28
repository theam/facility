#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { canonicalAuthorizationServerUrl, serveHttp } from "../http.js";
import { createFacilityMcpServer } from "../tools.js";

const [command, ...rest] = process.argv.slice(2);

if (command === "serve") {
  const port = Number(flag(rest, "--port") ?? "4420");
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    console.error("--port must be an integer between 0 and 65535.");
    process.exit(2);
  }
  const apiUrl = process.env.FACILITY_API_URL;
  if (!apiUrl) {
    console.error("FACILITY_API_URL is required.");
    process.exit(2);
  }
  // OAuth discovery points at this Facility instance's authorization server.
  const authRaw = process.env.MCP_AUTHORIZATION_SERVER;
  let authorizationServer: string | undefined;
  try {
    authorizationServer = authRaw ? canonicalAuthorizationServerUrl(authRaw) : undefined;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "MCP_AUTHORIZATION_SERVER is invalid");
    process.exit(2);
  }
  const host = flag(rest, "--host") ?? process.env.MCP_HOST ?? "127.0.0.1";
  const server = serveHttp({
    apiUrl,
    port,
    host,
    allowedHosts: process.env.MCP_ALLOWED_HOSTS?.split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    resourceUrl: process.env.MCP_PUBLIC_URL?.replace(/\/+$/, ""),
    authorizationServer,
    trustedProxyHops: integerEnv("MCP_TRUST_PROXY_HOPS", 0),
  });
  server.on("listening", () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.error(`facility-mcp listening on http://${host}:${actualPort}/mcp`);
  });
  const shutdown = async (signal: string) => {
    console.error(`facility-mcp received ${signal}; shutting down`);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
} else {
  const apiUrl = process.env.FACILITY_API_URL;
  const apiKey = process.env.FACILITY_API_KEY;
  if (!apiUrl || !apiKey) {
    console.error("FACILITY_API_URL and FACILITY_API_KEY are required for stdio transport.");
    process.exit(2);
  }
  const server = createFacilityMcpServer({
    apiUrl,
    apiKey,
  });
  await server.connect(new StdioServerTransport());
}

function flag(args: string[], name: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function integerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    console.error(`${name} must be a non-negative integer.`);
    process.exit(2);
  }
  return value;
}
