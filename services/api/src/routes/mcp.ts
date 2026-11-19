import { createFacilityMcpServer } from "@facility/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { followupToolInput, registerFollowup, verifyTurnToolToken } from "../turns/followup.js";
import type { AppConfig } from "../types.js";

const MCP_SCOPE = "facility:mcp";

export async function registerMcpRoutes(app: FastifyInstance, config: AppConfig) {
  app.get(
    "/.well-known/oauth-protected-resource/mcp",
    { config: { public: true } },
    async (_request, reply) => {
      if (!config.mcpPublicUrl || !config.oauthIssuer) {
        return reply.status(404).send({ error: "oauth_not_configured" });
      }
      return {
        resource: canonicalMcpUrl(config.mcpPublicUrl),
        authorization_servers: [config.oauthIssuer],
        bearer_methods_supported: ["header"],
        scopes_supported: [MCP_SCOPE],
      };
    },
  );

  app.post(
    "/mcp",
    {
      config: { public: true },
      schema: { body: z.unknown(), operationId: "facilityMcp" },
    },
    async (request, reply) => {
      const bearer = bearerToken(request.headers.authorization);
      if (!bearer || !request.principal) {
        reply.header("www-authenticate", challenge(config));
        return reply.status(401).send({ error: "missing or invalid bearer token" });
      }
      const server = createFacilityMcpServer({
        apiUrl: `http://127.0.0.1:${config.port}`,
        apiKey: bearer,
      });
      await serveMcp(request, reply, server);
    },
  );

  app.post(
    "/internal/turn-tools",
    { config: { public: true }, bodyLimit: 16_384, schema: { hide: true } },
    async (request, reply) => {
      const grant = verifyTurnToolToken(config.secretMasterKey, request.headers.authorization);
      if (!grant) return reply.status(401).send({ error: "Invalid turn credential" });
      const server = new McpServer({ name: "facility-turn", version: "1.0.0" });
      server.registerTool(
        "schedule_followup",
        {
          description:
            "Schedule one continuation of this turn's assignment after asynchronous work. Wait for confirmation before ending the turn. Include only a short public reason and non-secret job references. A person can cancel it or send a new request.",
          inputSchema: followupToolInput,
          annotations: { idempotentHint: true, destructiveHint: false },
        },
        async (input) => {
          try {
            const result = await registerFollowup(
              app.facilityDb,
              grant,
              input,
              config.secretMasterKey,
            );
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
          } catch (error) {
            if (error instanceof ApiError)
              return { isError: true, content: [{ type: "text", text: error.message }] };
            request.log.error({ turnId: grant.turnId }, "turn follow-up persistence failed");
            return {
              isError: true,
              content: [{ type: "text", text: "Could not confirm the follow-up" }],
            };
          }
        },
      );
      await serveMcp(request, reply, server);
    },
  );
}

async function serveMcp(request: FastifyRequest, reply: FastifyReply, server: McpServer) {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    void transport.close();
    void server.close();
  };
  request.raw.once("aborted", close);
  reply.raw.once("close", close);
  reply.hijack();
  try {
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  } catch (error) {
    request.log.error({ err: error }, "embedded MCP request failed");
    close();
    if (!reply.raw.headersSent) {
      reply.raw.writeHead(500, { "content-type": "application/json" });
      reply.raw.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        }),
      );
    }
  }
}

function bearerToken(header: string | undefined) {
  return header?.match(/^Bearer\s+(\S+)\s*$/i)?.[1] ?? "";
}

function challenge(config: AppConfig) {
  if (!config.mcpPublicUrl || !config.oauthIssuer) return "Bearer";
  const metadata = new URL(canonicalMcpUrl(config.mcpPublicUrl));
  metadata.pathname = `/.well-known/oauth-protected-resource${metadata.pathname}`;
  return `Bearer resource_metadata="${metadata.toString()}"`;
}

function canonicalMcpUrl(value: string) {
  const url = new URL(value);
  url.pathname = "/mcp";
  url.search = "";
  url.hash = "";
  return url.toString();
}
