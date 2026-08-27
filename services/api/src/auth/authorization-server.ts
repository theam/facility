import { githubInstallations, oauthArtifacts, orgMembers, roles, users } from "@facility/db";
import formbody from "@fastify/formbody";
import middie from "@fastify/middie";
import { and, eq, isNull, lt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import Provider from "oidc-provider";
import { z } from "zod";
import { ApiError } from "../errors.js";
import type { AppConfig } from "../types.js";
import { oauthAdapterFactory } from "./oauth-adapter.js";

export async function registerAuthorizationServer(app: FastifyInstance, config: AppConfig) {
  if (!config.oauthIssuer || !config.oauthJwks || !config.mcpPublicUrl) return;
  const browserOrigin = oauthBrowserOrigin(config);
  const Adapter = oauthAdapterFactory(app.facilityDb, config.secretMasterKey);
  const provider = new Provider(config.oauthIssuer, {
    adapter: Adapter,
    jwks: config.oauthJwks,
    cookies: { keys: [config.secretMasterKey], long: { signed: true }, short: { signed: true } },
    clients: [],
    clientDefaults: {
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      id_token_signed_response_alg: "ES256",
      application_type: "native",
    },
    features: {
      devInteractions: { enabled: false },
      registration: { enabled: true, initialAccessToken: false },
      revocation: { enabled: true },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => config.mcpPublicUrl,
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx: unknown, resource: string) => {
          if (resource !== config.mcpPublicUrl)
            throw new ApiError(400, "invalid_target", "Unknown OAuth resource");
          return {
            scope: "facility:mcp",
            audience: config.mcpPublicUrl,
            accessTokenTTL: 900,
            accessTokenFormat: "jwt",
          };
        },
      },
    },
    routes: {
      authorization: "/oauth/authorize",
      token: "/oauth/token",
      jwks: "/oauth/jwks",
      registration: "/oauth/register",
      revocation: "/oauth/revoke",
      introspection: "/oauth/introspect",
      end_session: "/oauth/session/end",
      userinfo: "/oauth/userinfo",
    },
    scopes: ["openid", "offline_access"],
    claims: { openid: ["sub"], email: ["email", "email_verified"], profile: ["name"] },
    formats: { AccessToken: "jwt" },
    pkce: { required: () => true, methods: ["S256"] },
    ttl: {
      AccessToken: 900,
      AuthorizationCode: 600,
      RefreshToken: 30 * 24 * 60 * 60,
      Grant: 30 * 24 * 60 * 60,
      Interaction: 600,
      Session: 7 * 24 * 60 * 60,
      IdToken: 300,
    },
    rotateRefreshToken: true,
    issueRefreshToken: (_ctx: unknown, client: { grantTypeAllowed(grantType: string): boolean }) =>
      client.grantTypeAllowed("refresh_token"),
    interactions: {
      url: (_ctx: unknown, interaction: { uid: string }) =>
        `${browserOrigin}/oauth/interaction/${interaction.uid}`,
    },
    findAccount: async (_ctx: unknown, accountId: string) => {
      const account = await activeAccount(app, accountId);
      if (!account) return undefined;
      return {
        accountId,
        claims: async () => ({
          sub: accountId,
          email: account.user.email,
          email_verified: true,
          name: account.user.name,
        }),
      };
    },
    extraTokenClaims: async (_ctx: unknown, token: { accountId?: string; scope?: string }) => {
      if (!token.accountId) return {};
      const account = await activeAccount(app, token.accountId);
      return account ? { org_id: account.member.orgId, scope: token.scope ?? "facility:mcp" } : {};
    },
  });
  provider.proxy = true;

  await app.register(middie);
  await app.register(formbody);
  const callback = provider.callback();
  const issuerUrl = new URL(config.oauthIssuer);
  let registrationWindow = { startedAt: Date.now(), count: 0 };
  app.use((req, res, next) => {
    const path = req.url?.split("?")[0] ?? "";
    if (
      (path.startsWith("/oauth/") && !path.startsWith("/oauth/interaction/")) ||
      path.startsWith("/.well-known/")
    ) {
      if (path === "/oauth/register") {
        if (Date.now() - registrationWindow.startedAt >= 60_000)
          registrationWindow = { startedAt: Date.now(), count: 0 };
        registrationWindow.count += 1;
        if (registrationWindow.count > 60) {
          res.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
          res.end(JSON.stringify({ error: "rate_limit_exceeded" }));
          return;
        }
      }
      // Do not trust client-supplied forwarding headers. oidc-provider uses these
      // to construct endpoint URLs, so pin them to the configured issuer.
      req.headers["x-forwarded-host"] = issuerUrl.host;
      req.headers["x-forwarded-proto"] = issuerUrl.protocol.slice(0, -1);
      callback(req, res);
    } else next();
  });

  const cleanup = setInterval(
    () => {
      void app.facilityDb
        .delete(oauthArtifacts)
        .where(lt(oauthArtifacts.expiresAt, new Date()))
        .catch((error) => {
          app.log.warn({ err: error }, "OAuth artifact cleanup failed");
        });
    },
    60 * 60 * 1000,
  );
  cleanup.unref();
  app.addHook("onClose", async () => clearInterval(cleanup));

  app.get(
    "/oauth/interaction/:uid",
    { config: { public: true }, schema: { params: z.object({ uid: z.string() }) } },
    async (request, reply) => {
      if (!request.principal?.userId) {
        const returnTo = `/oauth/interaction/${(request.params as { uid: string }).uid}`;
        return reply.redirect(
          `${browserOrigin}/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
        );
      }
      const details = await provider.interactionDetails(request.raw, reply.raw);
      const clientId = escapeHtml(String(details.params?.client_id ?? "unknown client"));
      const resource = escapeHtml(String(details.params?.resource ?? config.mcpPublicUrl));
      const redirectUri = escapeHtml(String(details.params?.redirect_uri ?? "unknown redirect"));
      reply.type("text/html; charset=utf-8");
      return `<!doctype html><html><body><main><h1>Authorize Facility MCP</h1><p><code>${clientId}</code> requests access to <code>${resource}</code>.</p><p>After approval, Facility will return to <code>${redirectUri}</code>.</p><form method="post"><button name="confirm" value="yes">Authorize</button></form></main></body></html>`;
    },
  );

  app.post(
    "/oauth/interaction/:uid",
    {
      config: { public: true },
      schema: {
        params: z.object({ uid: z.string() }),
        body: z.object({ confirm: z.literal("yes") }),
      },
    },
    async (request, reply) => {
      if (!request.principal?.userId)
        throw new ApiError(401, "unauthorized", "Authentication required");
      const details = await provider.interactionDetails(request.raw, reply.raw);
      const clientId = String(details.params?.client_id ?? "");
      const resource = String(details.params?.resource ?? config.mcpPublicUrl);
      if (resource !== config.mcpPublicUrl)
        throw new ApiError(400, "invalid_target", "Unknown OAuth resource");
      let grant = details.grantId ? await provider.Grant.find(details.grantId) : undefined;
      if (!grant) grant = new provider.Grant({ accountId: request.principal.userId, clientId });
      grant.addOIDCScope("openid offline_access");
      grant.addResourceScope(resource, "facility:mcp");
      const grantId = await grant.save();
      await provider.interactionFinished(
        request.raw,
        reply.raw,
        {
          login: { accountId: request.principal.userId },
          consent: { grantId },
        },
        { mergeWithLastSubmission: false },
      );
      return reply.hijack();
    },
  );
}

async function activeAccount(app: FastifyInstance, userId: string) {
  return (
    await app.facilityDb
      .select({ user: users, member: orgMembers, role: roles, installation: githubInstallations })
      .from(orgMembers)
      .innerJoin(users, eq(orgMembers.userId, users.id))
      .innerJoin(roles, eq(orgMembers.roleId, roles.id))
      .innerJoin(githubInstallations, eq(githubInstallations.orgId, orgMembers.orgId))
      .where(
        and(
          eq(users.id, userId),
          eq(users.status, "active"),
          isNull(githubInstallations.suspendedAt),
        ),
      )
      .orderBy(orgMembers.createdAt)
      .limit(1)
  )[0];
}

function escapeHtml(value: string) {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, (character) => entities[character] ?? character);
}

export function oauthBrowserOrigin(config: AppConfig) {
  let issuer: URL;
  let web: URL;
  let callback: URL;
  try {
    issuer = new URL(config.oauthIssuer ?? "");
    web = new URL(config.webUrl ?? config.publicUrl);
    callback = new URL(config.authCallbackUrl ?? `${web.origin}/api/auth/callback`);
  } catch {
    throw new Error(
      "Facility OAuth WEB_URL, issuer, and authentication callback must be valid HTTP(S) URLs",
    );
  }
  if (!isOriginUrl(web) || !isOriginUrl(issuer) || issuer.origin !== web.origin) {
    throw new Error("Facility OAuth WEB_URL and issuer must be the same canonical HTTP(S) origin");
  }
  if (!isExactAuthCallbackUrl(callback, web.origin)) {
    throw new Error(
      "Facility OAuth authentication callback must be exactly WEB_URL /api/auth/callback",
    );
  }
  return web.origin;
}

function isOriginUrl(url: URL) {
  return (
    ["http:", "https:"].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    url.pathname === "/" &&
    !url.search &&
    !url.hash
  );
}

function isExactAuthCallbackUrl(url: URL, webOrigin: string) {
  return (
    ["http:", "https:"].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    url.toString() === `${webOrigin}/api/auth/callback`
  );
}
