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
import { createLocalJWKSet, decodeJwt, exportJWK, generateKeyPair, SignJWT } from "jose";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, mintSessionCookie } from "../src/app.js";
import { oauthBrowserOrigin } from "../src/auth/authorization-server.js";
import { pkceChallenge } from "../src/auth/identity-provider.js";
import {
  AccessTokenError,
  looksLikeJwt,
  oauthConfigFromApp,
  verifyAccessToken,
} from "../src/oauth.js";
import type { AppConfig } from "../src/types.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";
const masterKey = Buffer.alloc(32, 7).toString("base64");
const issuer = "https://facility.test";
const audience = "https://mcp.facility.test/mcp";
const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
const privateJwk = { ...(await exportJWK(privateKey)), kid: "test-key", alg: "ES256", use: "sig" };
const publicJwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "ES256", use: "sig" };
const foreign = await generateKeyPair("ES256");
type SignKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
const base: AppConfig = {
  databaseUrl,
  secretMasterKey: masterKey,
  port: 4400,
  publicUrl: "https://api.facility.test",
  webUrl: issuer,
  sandboxApiUrl: "http://localhost:4400",
  sandboxGatewayUrl: "http://localhost:4410",
  gatewayUrl: "http://localhost:4410",
  sandboxRunnerImage: "facility-runner:dev",
  sandboxDriver: "docker",
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
    .setIssuer(issuer)
    .setSubject(input.sub ?? "user_test")
    .setAudience(input.aud ?? audience)
    .setIssuedAt();
  if (input.exp !== false) jwt.setExpirationTime(input.exp ?? "15m");
  return jwt.sign(input.key ?? privateKey);
}

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

  it.each([
    ["expired", () => token({ exp: Math.floor(Date.now() / 1000) - 1 })],
    ["wrong audience", () => token({ aud: "https://other.example" })],
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
    oauthJwks: { keys: [privateJwk] },
  };
  const app = await buildApp(config, { oauthJwks: createLocalJWKSet({ keys: [publicJwk] }) });
  const { db, client } = createDb(databaseUrl);
  const userId = newId("user");
  let orgId = "";

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl);
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/__test/session",
      payload: { email: `oauth-${Date.now()}@example.com` },
    });
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
      },
    });
    expect(registration.statusCode, registration.body).toBe(201);
    expect(registration.json()).toMatchObject({
      client_name: "Facility MCP test",
      token_endpoint_auth_method: "none",
    });
    expect(registration.json().client_secret).toBeUndefined();
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

  it("completes PKCE authorization, rotates refresh tokens, and rejects reuse", async () => {
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
      scope: "openid offline_access facility:mcp",
      resource: audience,
      state: "oauth-state",
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: "S256",
    });
    const wrongResource = new URLSearchParams(query);
    wrongResource.set("resource", "https://mcp.facility.test");
    const rejectedResource = await app.inject({
      method: "GET",
      url: `/oauth/authorize?${wrongResource}`,
      headers: proxyHeaders,
    });
    expect(rejectedResource.statusCode).toBe(400);
    expect(rejectedResource.body).toContain("Unknown OAuth resource");

    const authorization = await app.inject({
      method: "GET",
      url: `/oauth/authorize?${query}`,
      headers: proxyHeaders,
    });
    expect(authorization.statusCode).toBe(303);
    const providerCookies = authorization.cookies.map((cookie) => `${cookie.name}=${cookie.value}`);
    const interactionUrl = new URL(
      required(authorization.headers.location, "interaction redirect"),
      config.publicUrl,
    );
    expect(interactionUrl.origin).toBe(issuer);
    const interactionPath = interactionUrl.pathname;
    const signedOutInteraction = await app.inject({
      method: "GET",
      url: interactionPath,
      headers: { cookie: providerCookies.join("; ") },
    });
    expect(signedOutInteraction.statusCode).toBe(302);
    expect(signedOutInteraction.headers.location).toBe(
      `${issuer}/api/auth/login?returnTo=${encodeURIComponent(interactionPath)}`,
    );
    const facilityCookie = `facility_session=${await mintSessionCookie(config, userId, orgId)}`;
    const interaction = await app.inject({
      method: "GET",
      url: interactionPath,
      headers: { cookie: [facilityCookie, ...providerCookies].join("; ") },
    });
    expect(interaction.statusCode).toBe(200);
    expect(interaction.body).toContain("Authorize Facility MCP");
    expect(interaction.body).toContain(redirectUri);
    const consent = await app.inject({
      method: "POST",
      url: interactionPath,
      headers: {
        ...proxyHeaders,
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
    const resumed = await app.inject({
      method: "GET",
      url: new URL(consentLocation, issuer).pathname + new URL(consentLocation, issuer).search,
      headers: { ...proxyHeaders, cookie: resumedCookies.join("; ") },
    });
    expect(resumed.statusCode).toBe(303);
    const callback = new URL(required(resumed.headers.location, "OAuth callback redirect"));
    expect(callback.searchParams.get("state")).toBe("oauth-state");
    const code = required(callback.searchParams.get("code"), "authorization code");
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

    const rotated = await tokenRequest(app, proxyHeaders, {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: first.refresh_token,
      resource: audience,
    });
    expect(rotated.statusCode, rotated.body).toBe(200);
    expect(rotated.json().refresh_token).not.toBe(first.refresh_token);
    const replay = await tokenRequest(app, proxyHeaders, {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: first.refresh_token,
      resource: audience,
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error).toBe("invalid_grant");
  });
});

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
