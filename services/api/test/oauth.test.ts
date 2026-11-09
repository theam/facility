import { newId } from "@facility/core";
import {
  createDb,
  githubInstallations,
  migrate,
  oauthArtifacts,
  orgMembers,
  seed,
  userIdentities,
  users,
} from "@facility/db";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from "jose";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, mintSessionCookie } from "../src/app.js";
import {
  authorizationUrlWithConsent,
  isAuthorizationServerPath,
  oauthBrowserOrigin,
  oauthScopes,
  oidcScopesForConsent,
} from "../src/auth/authorization-server.js";
import { pkceChallenge } from "../src/auth/identity-provider.js";
import { oauthAdapterFactory } from "../src/auth/oauth-adapter.js";
import {
  AccessTokenError,
  looksLikeJwt,
  type OauthConfig,
  oauthConfigFromApp,
  verifyAccessToken,
} from "../src/oauth.js";
import type { AppConfig } from "../src/types.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";
const masterKey = Buffer.alloc(32, 7).toString("base64");
const issuer = "https://facility.test";
const audience = "https://mcp.facility.test/mcp";
const allScopes = "openid offline_access email profile facility:mcp";
const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
const privateJwk = { ...(await exportJWK(privateKey)), kid: "test-key", alg: "ES256", use: "sig" };
const publicJwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "ES256", use: "sig" };
// `exportJWK` emits no `key_ops`, so it cannot reproduce what an operator gets
// out of `crypto.subtle.exportKey`. The integration below configures this shape
// instead, so the flow runs on the key derivation production actually uses.
const webCryptoPrivateJwk = { ...privateJwk, key_ops: ["sign"], ext: true };
const foreign = await generateKeyPair("ES256");
type SignKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
const base: AppConfig = {
  databaseUrl,
  secretMasterKey: masterKey,
  port: 4400,
  publicUrl: "https://api.facility.test",
  webUrl: issuer,
  workspaceImage: "facility-runner:dev",
  workspaceDriver: "docker",
  authCallbackUrl: `${issuer}/api/auth/callback`,
  facilityInsecureDev: true,
  logLevel: "silent",
};
const oauthConfig = { issuer, audience, jwks: { keys: [publicJwk] } };

async function token(
  input: {
    sub?: string;
    orgId?: string;
    aud?: string;
    iss?: string;
    exp?: number | false;
    scope?: string;
    key?: SignKey;
  } = {},
) {
  const jwt = new SignJWT({
    org_id: input.orgId ?? "org_test",
    scope: input.scope ?? "facility:mcp",
  })
    .setProtectedHeader({ alg: "ES256", kid: "test-key" })
    .setIssuer(input.iss ?? issuer)
    .setSubject(input.sub ?? "user_test")
    .setAudience(input.aud ?? audience)
    .setIssuedAt();
  if (input.exp !== false) jwt.setExpirationTime(input.exp ?? "15m");
  return jwt.sign(input.key ?? privateKey);
}

describe("authorization-server route ownership", () => {
  it.each([
    "/oauth/authorize",
    "/oauth/token",
    "/oauth/register",
    "/oauth/jwks",
    "/.well-known/openid-configuration",
    "/.well-known/oauth-authorization-server",
  ])("delegates %s to the authorization server", (path) => {
    expect(isAuthorizationServerPath(path)).toBe(true);
  });
  it.each([
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/unknown",
    "/oauth/interaction/consent",
    "/mcp",
    "/v1/projects",
  ])("leaves %s to the application router", (path) => {
    expect(isAuthorizationServerPath(path)).toBe(false);
  });
});

describe("Facility OAuth access-token verification", () => {
  it("enables OAuth only when issuer, resource, and keys are all configured", () => {
    expect(oauthConfigFromApp(base)).toBeNull();
    expect(oauthConfigFromApp({ ...base, oauthIssuer: issuer, mcpPublicUrl: audience })).toBeNull();
    expect(
      oauthConfigFromApp({
        ...base,
        oauthIssuer: issuer,
        mcpPublicUrl: audience,
        oauthJwks: { keys: [privateJwk] },
      })?.audience,
    ).toBe(audience);
  });

  it("accepts a signed, scoped, audience-bound Facility token", async () => {
    await expect(verifyAccessToken(await token(), oauthConfig)).resolves.toEqual({
      userId: "user_test",
      orgId: "org_test",
      scope: "facility:mcp",
    });
  });

  it("verifies its own tokens against keys derived from a WebCrypto signing key", async () => {
    const derived = oauthConfigFromApp({
      ...base,
      oauthIssuer: issuer,
      mcpPublicUrl: audience,
      oauthJwks: { keys: [webCryptoPrivateJwk] },
    });

    // Carrying `key_ops: ["sign"]` into the verification set makes jose reject the
    // key as a candidate, and the instance stops trusting anything it signs.
    expect(derived?.jwks.keys[0]).not.toHaveProperty("key_ops");
    expect(derived?.jwks.keys[0]).not.toHaveProperty("ext");
    expect(derived?.jwks.keys[0]).not.toHaveProperty("d");
    await expect(verifyAccessToken(await token(), derived as OauthConfig)).resolves.toMatchObject({
      userId: "user_test",
      orgId: "org_test",
    });
  });

  it.each([
    ["expired", () => token({ exp: Math.floor(Date.now() / 1000) - 1 })],
    ["wrong audience", () => token({ aud: "https://other.example" })],
    ["wrong issuer", () => token({ iss: "https://other.example" })],
    ["missing expiry", () => token({ exp: false })],
    ["missing MCP scope", () => token({ scope: "openid" })],
    ["foreign signature", () => token({ key: foreign.privateKey })],
  ])("rejects %s", async (_label, create) => {
    await expect(verifyAccessToken(await create(), oauthConfig)).rejects.toBeInstanceOf(
      AccessTokenError,
    );
  });

  it("recognizes only three-segment JWT values", () => {
    expect(looksLikeJwt("a.b.c")).toBe(true);
    expect(looksLikeJwt("fak_test")).toBe(false);
  });
});

describe("Facility OAuth browser-origin runtime guard", () => {
  it("accepts an exact same-origin callback, including HTTP local development", () => {
    expect(
      oauthBrowserOrigin({
        ...base,
        publicUrl: "http://localhost:4400",
        webUrl: "http://localhost:3400",
        oauthIssuer: "http://localhost:3400",
        authCallbackUrl: "http://localhost:3400/api/auth/callback",
      }),
    ).toBe("http://localhost:3400");
  });

  it.each([
    ["web path", { webUrl: `${issuer}/app`, oauthIssuer: issuer }],
    ["issuer path", { webUrl: issuer, oauthIssuer: `${issuer}/oauth` }],
    ["issuer credentials", { webUrl: issuer, oauthIssuer: "https://user:secret@facility.test" }],
    ["different issuer", { webUrl: issuer, oauthIssuer: "https://other.facility.test" }],
  ])("rejects a non-canonical or mismatched %s at runtime", (_label, overrides) => {
    expect(() => oauthBrowserOrigin({ ...base, ...overrides })).toThrow(
      "Facility OAuth WEB_URL and issuer must be the same canonical HTTP(S) origin",
    );
  });

  it.each([
    `${issuer}/auth/callback`,
    `${issuer}/api/auth/callback/`,
    `${issuer}/api/auth/callback?tenant=one`,
    `${issuer}/api/auth/callback#fragment`,
    "https://other.facility.test/api/auth/callback",
    "https://user:secret@facility.test/api/auth/callback",
  ])("rejects a non-exact authentication callback at runtime: %s", (authCallbackUrl) => {
    expect(() =>
      oauthBrowserOrigin({
        ...base,
        oauthIssuer: issuer,
        authCallbackUrl,
      }),
    ).toThrow("Facility OAuth authentication callback must be exactly WEB_URL /api/auth/callback");
  });
});

describe("offline access consent policy", () => {
  it.each([undefined, "", "login"])("requires consent when prompt is %j", (prompt) => {
    const params = new URLSearchParams({ scope: allScopes, state: "state with + and &" });
    if (prompt !== undefined) params.set("prompt", prompt);
    const result = new URL(authorizationUrlWithConsent(`/oauth/authorize?${params}`), issuer);
    expect(result.searchParams.get("prompt")).toBe(prompt ? `${prompt} consent` : "consent");
    expect(result.searchParams.get("scope")).toBe(allScopes);
    expect(result.searchParams.get("state")).toBe("state with + and &");
  });

  it.each([
    "/oauth/authorize",
    "/oauth/authorize?scope=openid+facility:mcp",
    "/oauth/authorize?scope=",
    "/oauth/authorize?scope=offline_access&prompt=consent",
    "/oauth/authorize?scope=offline_access&prompt=none",
    "/oauth/authorize?scope=offline_access&prompt=none+login",
    "/oauth/authorize?scope=offline_access&prompt=none&prompt=login",
    "/oauth/authorize?scope=offline_access&scope=openid",
    "/oauth/token?scope=offline_access",
    "/oauth/authorize/resume?scope=offline_access",
  ])("preserves requests that must not be rewritten: %s", (url) => {
    expect(authorizationUrlWithConsent(url)).toBe(url);
  });

  it("preserves unsupported prompt values for provider validation", () => {
    const result = new URL(
      authorizationUrlWithConsent("/oauth/authorize?scope=offline_access&prompt=unsupported"),
      issuer,
    );
    expect(result.searchParams.get("prompt")).toBe("unsupported consent");
  });
});

describe("Facility OAuth consent scopes", () => {
  it("grants every requested advertised OIDC scope in canonical order", () => {
    expect(oidcScopesForConsent(oauthScopes("profile openid email offline_access"))).toBe(
      "openid offline_access email profile",
    );
  });

  it("does not promote resource or unknown scopes into the OIDC grant", () => {
    expect(oidcScopesForConsent(oauthScopes("openid facility:mcp projects:write unknown"))).toBe(
      "openid",
    );
  });

  it.each([undefined, null, 42, ["openid"]])("handles a non-string scope value: %j", (scope) => {
    expect(oauthScopes(scope)).toEqual(new Set());
  });
});

describe("Facility OAuth resource-server integration", async () => {
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 2 });
  let reachable = true;
  try {
    await sql`select 1`;
  } catch {
    reachable = false;
  } finally {
    await sql.end();
  }
  if (!reachable) {
    it.skip("Postgres unreachable", () => undefined);
    return;
  }

  const config: AppConfig = {
    ...base,
    oauthIssuer: issuer,
    mcpPublicUrl: audience,
    oauthJwks: { keys: [webCryptoPrivateJwk] },
  };
  // Deliberately no `oauthJwks` override: injecting a hand-built verification set
  // here is what hid this bug, because it skips the derivation that turns the
  // configured signing keys into the keys the running instance verifies with.
  const app = await buildApp(config);
  const { db, client } = createDb(databaseUrl);
  const Adapter = oauthAdapterFactory(db, masterKey);
  const refreshTokens = new Adapter("RefreshToken");
  const userId = newId("user");
  let orgId = "";

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl, { includeDemoData: true });
    await app.ready();
    const address = new URL(await app.listen({ port: 0, host: "127.0.0.1" }));
    config.port = Number(address.port);
    const login = await app.inject({
      method: "POST",
      url: "/__test/session",
      payload: { email: `oauth-${Date.now()}@example.com` },
    });
    expect(login.statusCode, login.body).toBe(200);
    orgId = login.json().orgId;
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.com`,
      status: "active",
      avatarUrl: "https://avatars.example/oauth-user.png",
    });
    await db.insert(userIdentities).values({
      id: `identity_${Date.now()}`,
      userId,
      provider: "github",
      providerSubject: `oauth-${Date.now()}`,
      login: "oauth-octocat",
    });
    await db
      .insert(orgMembers)
      .values({ id: newId("member"), orgId, userId, roleId: "role_bundled_owner" });
    await db.insert(githubInstallations).values({
      id: newId("int"),
      orgId,
      installationId: 9_000_000 + Math.floor(Math.random() * 100_000),
      accountId: 8_000_000,
      accountLogin: "oauth-test",
      targetType: "Organization",
    });
  });
  afterAll(async () => {
    await app.close();
    await client.end();
  });

  async function authorizationRequest(scope = allScopes) {
    const proxyHeaders = { host: "api.facility.test", "x-forwarded-proto": "https" };
    const redirectUri = "http://127.0.0.1:32127/callback";
    const registration = await app.inject({
      method: "POST",
      url: "/oauth/register",
      headers: proxyHeaders,
      payload: {
        client_name: "OAuth scope contract regression",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: allScopes,
      },
    });
    expect(registration.statusCode).toBe(201);
    const clientId = registration.json().client_id as string;
    const verifier = "scope-contract-verifier-".padEnd(64, "x");
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope,
      resource: audience,
      state: "scope-contract-state",
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: "S256",
    });
    return { app, config, userId, orgId, proxyHeaders, query, clientId, verifier, redirectUri };
  }

  async function issueTokens(scope = allScopes) {
    const request = await authorizationRequest(scope);
    const code = await completePkceConsent(request);
    const exchange = await tokenRequest(app, request.proxyHeaders, {
      grant_type: "authorization_code",
      client_id: request.clientId,
      code,
      redirect_uri: request.redirectUri,
      code_verifier: request.verifier,
      resource: audience,
    });
    expect(exchange.statusCode).toBe(200);
    const tokens = exchange.json() as {
      access_token: string;
      refresh_token: string;
      scope: string;
    };
    return {
      ...request,
      ...tokens,
      refresh: (overrides: Record<string, string> = {}) =>
        tokenRequest(app, request.proxyHeaders, {
          grant_type: "refresh_token",
          client_id: request.clientId,
          refresh_token: tokens.refresh_token,
          resource: audience,
          ...overrides,
        }),
    };
  }

  it.each([
    ["unknown scope", { scope: `${allScopes} facility:admin` }, "invalid_scope"],
    ["different resource", { resource: "https://other.example/mcp" }, "invalid_target"],
    ["malformed token", { refresh_token: "not-a-refresh-token" }, "invalid_grant"],
  ])("rejects refresh with %s", async (_label, overrides, error) => {
    const issued = await issueTokens();
    const denied = await issued.refresh(overrides as Record<string, string>);
    expect(denied.statusCode).toBe(400);
    expect(denied.json().error).toBe(error);
  });

  it("rejects a refresh token presented by another registered client", async () => {
    const issued = await issueTokens();
    const other = await authorizationRequest();
    const denied = await issued.refresh({ client_id: other.clientId });
    expect(denied.statusCode).toBe(400);
    expect(denied.json().error).toBe("invalid_grant");
  });

  it.each(["expired", "revoked"])("rejects %s refresh tokens", async (kind) => {
    const issued = await issueTokens();
    if (kind === "expired") {
      const stored = required(await refreshTokens.find(issued.refresh_token), "refresh artifact");
      await refreshTokens.upsert(issued.refresh_token, stored, -1);
    } else {
      const revoked = await app.inject({
        method: "POST",
        url: "/oauth/revoke",
        headers: { ...issued.proxyHeaders, "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({
          client_id: issued.clientId,
          token: issued.refresh_token,
          token_type_hint: "refresh_token",
        }).toString(),
      });
      expect(revoked.statusCode).toBe(200);
    }
    const denied = await issued.refresh();
    expect(denied.statusCode).toBe(400);
    expect(denied.json().error).toBe("invalid_grant");
  });

  it.each([
    ["openid email profile facility:mcp", allScopes, "offline_access"],
    ["openid offline_access facility:mcp", allScopes, "email profile"],
    ["openid offline_access email profile", allScopes, "facility:mcp"],
  ])("does not expand a refresh grant originally issued for %s", async (scope, requested, missing) => {
    const issued = await issueTokens(scope);
    const denied = await issued.refresh({ scope: requested });
    expect(denied.statusCode).toBe(400);
    expect(denied.json()).toMatchObject({ error: "invalid_scope", scope: missing });
    // Includes grants equivalent to legacy tokens that lost offline_access.
    // An omitted scope preserves them but must never silently upgrade them.
    const renewed = await issued.refresh();
    expect(renewed.statusCode).toBe(200);
    const next = renewed.json();
    const stored = await refreshTokens.find(next.refresh_token);
    expect(oauthScopes(stored?.scope)).toEqual(oauthScopes(scope));
    const expandedAgain = await issued.refresh({
      refresh_token: next.refresh_token,
      scope: requested,
    });
    expect(expandedAgain.statusCode).toBe(400);
    expect(expandedAgain.json().error).toBe("invalid_scope");
  });

  it("does not mint MCP scope when refresh explicitly requests only OIDC scopes", async () => {
    const issued = await issueTokens();
    const narrowed = await issued.refresh({ scope: "openid email" });
    expect(narrowed.statusCode).toBe(200);
    await expectMcpAccessDenied(app, narrowed.json().access_token, { userId, orgId });
  });

  it.each([
    "none",
    "none consent",
    "unsupported",
  ])("keeps silent and invalid authorization requests from granting access (prompt=%s)", async (prompt) => {
    const request = await authorizationRequest();
    request.query.set("prompt", prompt);
    const response = await app.inject({
      method: "GET",
      url: `/oauth/authorize?${request.query}`,
      headers: request.proxyHeaders,
    });
    expect(response.statusCode).toBe(303);
    const callback = new URL(required(response.headers.location, "denied callback"));
    expect(callback.origin + callback.pathname).toBe(request.redirectUri);
    expect(callback.searchParams.get("code")).toBeNull();
    expect(callback.searchParams.get("error")).toBe(
      prompt === "none" ? "login_required" : "invalid_request",
    );
    expect(callback.searchParams.get("iss")).toBe(issuer);
    expect(callback.searchParams.get("state")).toBe(request.query.get("state"));
  });

  it("rejects a wrong PKCE verifier after offline consent", async () => {
    const request = await authorizationRequest();
    const code = await completePkceConsent(request);
    const denied = await tokenRequest(app, request.proxyHeaders, {
      grant_type: "authorization_code",
      client_id: request.clientId,
      code,
      redirect_uri: request.redirectUri,
      code_verifier: "wrong-verifier-".padEnd(64, "x"),
    });
    expect(denied.statusCode).toBe(400);
    expect(denied.json().error).toBe("invalid_grant");
  });

  it.each(["scope", "prompt"])("rejects duplicate authorization %s parameters", async (param) => {
    const request = await authorizationRequest();
    request.query.append(param, param === "scope" ? "openid" : "none");
    if (param === "prompt") request.query.append("prompt", "consent");
    const denied = await app.inject({
      method: "GET",
      url: `/oauth/authorize?${request.query}`,
      headers: request.proxyHeaders,
    });
    expect(denied.statusCode).toBe(303);
    const callback = new URL(required(denied.headers.location, "invalid request callback"));
    expect(callback.searchParams.get("error")).toBe("invalid_request");
    expect(callback.searchParams.get("code")).toBeNull();
    expect(callback.searchParams.get("iss")).toBe(issuer);
  });

  it("serves canonical MCP resource discovery alongside the enabled authorization server", async () => {
    const challenge = await app.inject({ method: "POST", url: "/mcp", payload: {} });
    expect(challenge.statusCode).toBe(401);
    const resourceMetadata = String(challenge.headers["www-authenticate"]).match(
      /resource_metadata="([^"]+)"/,
    )?.[1];
    expect(resourceMetadata).toBe(
      "https://mcp.facility.test/.well-known/oauth-protected-resource/mcp",
    );
    const metadata = await app.inject({
      method: "GET",
      url: new URL(resourceMetadata as string).pathname,
      headers: {
        host: "evil.example",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "http",
      },
    });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json()).toEqual({
      resource: audience,
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: ["facility:mcp"],
    });
    for (const authorization of [
      "Bearer malformed",
      `Bearer ${await token({ aud: "https://other.example" })}`,
    ]) {
      const denied = await app.inject({
        method: "POST",
        url: "/mcp",
        payload: {},
        headers: { authorization },
      });
      expect(denied.statusCode).toBe(401);
    }
    const oidc = await app.inject({ method: "GET", url: "/.well-known/openid-configuration" });
    expect(oidc.statusCode).toBe(200);
    expect(oidc.json().issuer).toBe(issuer);
  });

  it("publishes authorization metadata and registers a public PKCE client", async () => {
    const proxyHeaders = {
      host: "api.facility.test",
      "x-forwarded-host": "api.facility.test",
      "x-forwarded-proto": "https",
    };
    const metadata = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-authorization-server",
      headers: proxyHeaders,
    });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json()).toMatchObject({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["openid", "offline_access", "email", "profile", "facility:mcp"],
      authorization_response_iss_parameter_supported: true,
    });
    const poisonedMetadata = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-authorization-server",
      headers: {
        host: "evil.example",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "http",
      },
    });
    expect(poisonedMetadata.statusCode).toBe(200);
    expect(poisonedMetadata.json().issuer).toBe(issuer);
    const publishedKeys = await app.inject({
      method: "GET",
      url: "/oauth/jwks",
      headers: proxyHeaders,
    });
    expect(publishedKeys.statusCode).toBe(200);
    expect(publishedKeys.json().keys[0]).toMatchObject({ kid: "test-key", kty: "EC" });
    expect(publishedKeys.json().keys[0].d).toBeUndefined();
    const registration = await app.inject({
      method: "POST",
      url: "/oauth/register",
      headers: proxyHeaders,
      payload: {
        client_name: "Facility MCP test",
        redirect_uris: ["http://127.0.0.1:32123/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: "openid offline_access email profile facility:mcp",
      },
    });
    expect(registration.statusCode, registration.body).toBe(201);
    expect(registration.json()).toMatchObject({
      client_name: "Facility MCP test",
      token_endpoint_auth_method: "none",
      scope: "openid offline_access email profile facility:mcp",
    });
    expect(registration.json().client_secret).toBeUndefined();
    const rejectedRegistration = await app.inject({
      method: "POST",
      url: "/oauth/register",
      headers: proxyHeaders,
      payload: {
        client_name: "Invalid scope client",
        redirect_uris: ["http://127.0.0.1:32123/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: "openid facility:unknown",
      },
    });
    expect(rejectedRegistration.statusCode).toBe(400);
    expect(rejectedRegistration.json()).toMatchObject({ error: "invalid_client_metadata" });
  });

  it("resolves a current member and rejects cross-tenant claims", async () => {
    const accepted = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${await token({ sub: userId, orgId })}` },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().principal).toMatchObject({
      githubLogin: "oauth-octocat",
      avatarUrl: "https://avatars.example/oauth-user.png",
    });
    const denied = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${await token({ sub: userId, orgId: "org_other" })}` },
    });
    expect(denied.statusCode).toBe(403);
  });

  it.each([
    undefined,
    "consent",
    "login",
  ])("completes PKCE, explicit and omitted refresh scopes, MCP reads and reuse denial (prompt=%j)", async (prompt) => {
    const proxyHeaders = {
      host: "api.facility.test",
      "x-forwarded-host": "api.facility.test",
      "x-forwarded-proto": "https",
    };
    const redirectUri = "http://127.0.0.1:32124/callback";
    const registration = await app.inject({
      method: "POST",
      url: "/oauth/register",
      headers: proxyHeaders,
      payload: {
        client_name: "MCP regression client",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
    });
    expect(registration.statusCode, registration.body).toBe(201);
    const clientId = registration.json().client_id as string;
    const verifier = "pkce-verifier-".padEnd(64, "x");
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid offline_access email profile facility:mcp",
      resource: audience,
      state: "oauth-state",
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: "S256",
    });
    if (prompt) query.set("prompt", prompt);
    const wrongResource = new URLSearchParams(query);
    wrongResource.set("resource", "https://mcp.facility.test");
    const rejectedResource = await app.inject({
      method: "GET",
      url: `/oauth/authorize?${wrongResource}`,
      headers: proxyHeaders,
    });
    expect(rejectedResource.statusCode).toBe(400);
    expect(rejectedResource.body).toContain("Unknown OAuth resource");

    const code = await completePkceConsent({
      app,
      config,
      userId,
      orgId,
      proxyHeaders,
      query,
    });
    const storedCode = await new Adapter("AuthorizationCode").find(code);
    expect(oauthScopes(storedCode?.scope)).toEqual(oauthScopes(allScopes));
    expect(storedCode?.resource).toBe(audience);
    const storedGrant = await new Adapter("Grant").find(required(storedCode?.grantId, "grant id"));
    expect(storedGrant?.openid).toEqual({ scope: "openid offline_access email profile" });
    expect(storedGrant?.resources).toEqual({ [audience]: "facility:mcp" });
    const exchange = await tokenRequest(app, proxyHeaders, {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: audience,
    });
    expect(exchange.statusCode, exchange.body).toBe(200);
    const first = exchange.json();
    expect(first.access_token.split(".")).toHaveLength(3);
    expect(first.refresh_token).toBeTypeOf("string");
    expect(decodeJwt(first.access_token).scope).toBe("facility:mcp");
    expect(first.scope).toBe("facility:mcp");
    const storedRefresh = await refreshTokens.find(first.refresh_token);
    expect(oauthScopes(storedRefresh?.scope)).toEqual(oauthScopes(allScopes));
    expect(storedRefresh?.resource).toBe(audience);
    const persisted = JSON.stringify(await db.select().from(oauthArtifacts));
    expect(persisted).not.toContain(first.refresh_token);
    expect(persisted).not.toContain(first.access_token);
    const me = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${first.access_token}` },
    });
    expect(
      me.statusCode,
      JSON.stringify({ body: me.body, claims: decodeJwt(first.access_token) }),
    ).toBe(200);
    await expectMcpRead(config.port, first.access_token);

    const rotated = await tokenRequest(app, proxyHeaders, {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: first.refresh_token,
      resource: audience,
      scope: query.get("scope") as string,
    });
    expect(rotated.statusCode, rotated.body).toBe(200);
    const rotatedBody = rotated.json();
    expect(rotatedBody.refresh_token).not.toBe(first.refresh_token);
    expect(decodeJwt(rotatedBody.access_token).scope).toBe("facility:mcp");
    const refreshedMe = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${rotatedBody.access_token}` },
    });
    expect(refreshedMe.statusCode, refreshedMe.body).toBe(200);
    await expectMcpRead(config.port, rotatedBody.access_token);

    // Rotation preserves the full authorization even when an individual access
    // token requests only its resource scope or omits scope/resource entirely.
    let current = rotatedBody;
    for (const scope of [
      undefined,
      "facility:mcp",
      "profile facility:mcp offline_access email openid",
    ]) {
      const previous = current.refresh_token;
      const renewed = await tokenRequest(app, proxyHeaders, {
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: previous,
        ...(scope === undefined ? {} : { scope }),
      });
      expect(renewed.statusCode).toBe(200);
      current = renewed.json();
      expect(current.refresh_token === previous).toBe(false);
      expect(current.scope).toBe("facility:mcp");
      await expect(verifyAccessToken(current.access_token, oauthConfig)).resolves.toEqual({
        userId,
        orgId,
        scope: "facility:mcp",
      });
      const stored = await refreshTokens.find(current.refresh_token);
      expect(oauthScopes(stored?.scope)).toEqual(oauthScopes(allScopes));
      expect(stored?.resource).toBe(audience);
      expect((await refreshTokens.find(previous))?.consumed).toBeTypeOf("number");
    }
    const replay = await tokenRequest(app, proxyHeaders, {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: first.refresh_token,
      resource: audience,
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error).toBe("invalid_grant");
    const revokedFamily = await tokenRequest(app, proxyHeaders, {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: current.refresh_token,
    });
    expect(revokedFamily.statusCode).toBe(400);
    expect(revokedFamily.json().error).toBe("invalid_grant");
  });

  it("does not grant MCP access when the client omits the MCP scope", async () => {
    const proxyHeaders = {
      host: "api.facility.test",
      "x-forwarded-host": "api.facility.test",
      "x-forwarded-proto": "https",
    };
    const redirectUri = "http://127.0.0.1:32125/callback";
    const registration = await app.inject({
      method: "POST",
      url: "/oauth/register",
      headers: proxyHeaders,
      payload: {
        client_name: "OIDC-only regression client",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: "openid offline_access email",
      },
    });
    expect(registration.statusCode, registration.body).toBe(201);
    const clientId = registration.json().client_id as string;
    const verifier = "oidc-only-pkce-verifier-".padEnd(64, "x");
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid offline_access email",
      resource: audience,
      state: "oidc-only-state",
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: "S256",
    });
    const code = await completePkceConsent({
      app,
      config,
      userId,
      orgId,
      proxyHeaders,
      query,
    });
    const exchange = await tokenRequest(app, proxyHeaders, {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: audience,
    });
    expect(exchange.statusCode, exchange.body).toBe(200);
    const first = exchange.json();
    expect(first.refresh_token).toBeTypeOf("string");
    await expectMcpAccessDenied(app, first.access_token, { userId, orgId });

    const rotated = await tokenRequest(app, proxyHeaders, {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: first.refresh_token,
      resource: audience,
    });
    expect(rotated.statusCode, rotated.body).toBe(200);
    await expectMcpAccessDenied(app, rotated.json().access_token, { userId, orgId });
  });

  it("does not grant MCP access when the authorization request omits scope", async () => {
    const proxyHeaders = {
      host: "api.facility.test",
      "x-forwarded-host": "api.facility.test",
      "x-forwarded-proto": "https",
    };
    const redirectUri = "http://127.0.0.1:32126/callback";
    const registration = await app.inject({
      method: "POST",
      url: "/oauth/register",
      headers: proxyHeaders,
      payload: {
        client_name: "Scope-less regression client",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      },
    });
    expect(registration.statusCode, registration.body).toBe(201);
    const clientId = registration.json().client_id as string;
    const verifier = "scope-less-pkce-verifier-".padEnd(64, "x");
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      resource: audience,
      state: "scope-less-state",
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: "S256",
    });
    const callback = await completePkceConsentCallback({
      app,
      config,
      userId,
      orgId,
      proxyHeaders,
      query,
    });
    expect(callback.searchParams.get("error"), callback.toString()).toBe("access_denied");
    expect(callback.searchParams.get("code")).toBeNull();
  });
});

async function expectMcpRead(port: number, accessToken: string) {
  const client = new Client({ name: "oauth-refresh-regression", version: "1.0.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
      }),
    );
    const result = await client.callTool({ name: "facility_list_projects", arguments: {} });
    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content.find((part) => part.type === "text")?.text;
    expect(Array.isArray(JSON.parse(required(text, "MCP projects response")))).toBe(true);
  } finally {
    await client.close();
  }
}

async function expectMcpAccessDenied(
  app: Awaited<ReturnType<typeof buildApp>>,
  accessToken: string,
  expected: { userId: string; orgId: string },
) {
  const claims = decodeJwt(accessToken);
  expect(claims).toMatchObject({
    iss: issuer,
    aud: audience,
    sub: expected.userId,
    org_id: expected.orgId,
  });
  expect(claims.scope).toBeUndefined();
  await expect(verifyAccessToken(accessToken, oauthConfig)).rejects.toBeInstanceOf(
    AccessTokenError,
  );
  const denied = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: `Bearer ${accessToken}` },
  });
  expect(denied.statusCode).toBe(401);
  expect(denied.json()).toEqual({
    error: { code: "unauthorized", message: "Invalid access token" },
  });
  const deniedMcp = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {},
  });
  expect(deniedMcp.statusCode).toBe(401);
}

type PkceConsentInput = {
  app: Awaited<ReturnType<typeof buildApp>>;
  config: AppConfig;
  userId: string;
  orgId: string;
  proxyHeaders: Record<string, string>;
  query: URLSearchParams;
};

async function completePkceConsent(input: PkceConsentInput) {
  const callback = await completePkceConsentCallback(input);
  return required(callback.searchParams.get("code"), "authorization code");
}

async function completePkceConsentCallback(input: PkceConsentInput) {
  const redirectUri = required(input.query.get("redirect_uri"), "redirect URI");
  const state = required(input.query.get("state"), "OAuth state");
  const authorization = await input.app.inject({
    method: "GET",
    url: `/oauth/authorize?${input.query}`,
    headers: input.proxyHeaders,
  });
  expect(authorization.statusCode).toBe(303);
  const providerCookies = authorization.cookies.map((cookie) => `${cookie.name}=${cookie.value}`);
  const interactionUrl = new URL(
    required(authorization.headers.location, "interaction redirect"),
    input.config.publicUrl,
  );
  expect(interactionUrl.origin).toBe(issuer);
  const interactionPath = interactionUrl.pathname;
  const signedOutInteraction = await input.app.inject({
    method: "GET",
    url: interactionPath,
    headers: { cookie: providerCookies.join("; ") },
  });
  expect(signedOutInteraction.statusCode).toBe(302);
  expect(signedOutInteraction.headers.location).toBe(
    `${issuer}/api/auth/login?returnTo=${encodeURIComponent(interactionPath)}`,
  );
  const facilityCookie = `facility_session=${await mintSessionCookie(
    input.config,
    input.userId,
    input.orgId,
  )}`;
  const interaction = await input.app.inject({
    method: "GET",
    url: interactionPath,
    headers: { cookie: [facilityCookie, ...providerCookies].join("; ") },
  });
  expect(interaction.statusCode).toBe(200);
  expect(interaction.body).toContain("Authorize Facility MCP");
  expect(interaction.body).toContain(redirectUri);
  expect(interaction.body.includes("can renew its access while you are away")).toBe(
    oauthScopes(input.query.get("scope")).has("offline_access"),
  );
  const consent = await input.app.inject({
    method: "POST",
    url: interactionPath,
    headers: {
      ...input.proxyHeaders,
      cookie: [facilityCookie, ...providerCookies].join("; "),
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: "confirm=yes",
  });
  expect(consent.statusCode).toBe(303);
  const resumedCookies = [
    ...providerCookies,
    ...consent.cookies.map((cookie) => `${cookie.name}=${cookie.value}`),
  ];
  const consentLocation = required(consent.headers.location, "consent redirect");
  const resumedUrl = new URL(consentLocation, issuer);
  const resumed = await input.app.inject({
    method: "GET",
    url: resumedUrl.pathname + resumedUrl.search,
    headers: { ...input.proxyHeaders, cookie: resumedCookies.join("; ") },
  });
  expect(resumed.statusCode).toBe(303);
  const callback = new URL(required(resumed.headers.location, "OAuth callback redirect"));
  expect(callback.searchParams.get("iss")).toBe(issuer);
  expect(callback.searchParams.get("state")).toBe(state);
  return callback;
}

function tokenRequest(
  app: Awaited<ReturnType<typeof buildApp>>,
  headers: Record<string, string>,
  body: Record<string, string>,
) {
  return app.inject({
    method: "POST",
    url: "/oauth/token",
    headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(body).toString(),
  });
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`Missing ${label}`);
  return value;
}
