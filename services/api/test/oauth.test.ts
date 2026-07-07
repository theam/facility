import { newId } from "@facility/core";
import { createDb, migrate, orgMembers, seed, users } from "@facility/db";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTVerifyGetKey,
  SignJWT,
} from "jose";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
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
const ISSUER = "https://auth.facility.test";
const AUDIENCE = "facility-mcp";

// Trusted signing keypair + the JWKS the resource server trusts (offline).
const { privateKey, publicKey } = await generateKeyPair("RS256");
const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256" };
const jwks: JWTVerifyGetKey = createLocalJWKSet({ keys: [publicJwk] });
const foreign = await generateKeyPair("RS256");
type SignKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

const oauthConfig: OauthConfig = {
  issuer: ISSUER,
  jwksUri: `${ISSUER}/oauth2/jwks`,
  audience: AUDIENCE,
};
const subject = `workos_user_${Date.now()}`;
const email = `${subject}-oauth@example.com`;

async function signToken(
  o: {
    sub?: string;
    issuer?: string;
    audience?: string | null;
    alg?: string;
    key?: SignKey;
    exp?: string | number | false;
  } = {},
) {
  const jwt = new SignJWT({ email })
    .setProtectedHeader({ alg: o.alg ?? "RS256", kid: "test-key" })
    .setIssuer(o.issuer ?? ISSUER)
    .setSubject(o.sub ?? subject)
    .setIssuedAt();
  if (o.audience !== null) jwt.setAudience(o.audience ?? AUDIENCE);
  if (o.exp !== false) jwt.setExpirationTime(o.exp ?? "1h");
  return jwt.sign(o.key ?? privateKey);
}

// --- Pure token verification (no database; never skipped) ---

describe("oauth token verification", () => {
  it("derives config only when both issuer domain and audience are set, https-only", () => {
    const base: AppConfig = {
      databaseUrl,
      secretMasterKey: masterKey,
      port: 4400,
      publicUrl: "http://localhost:4400",
      sandboxApiUrl: "http://localhost:4400",
      sandboxGatewayUrl: "http://localhost:4410",
      sandboxRunnerImage: "facility-runner:dev",
      sandboxDriver: "docker",
      facilityInsecureDev: true,
      logLevel: "silent",
    };
    expect(oauthConfigFromApp({ ...base, workosAuthkitDomain: ISSUER })).toBeNull();
    expect(oauthConfigFromApp({ ...base, mcpOauthAudience: AUDIENCE })).toBeNull();
    expect(
      oauthConfigFromApp({
        ...base,
        workosAuthkitDomain: "http://auth.facility.test",
        mcpOauthAudience: AUDIENCE,
      }),
    ).toBeNull();
    const ok = oauthConfigFromApp({
      ...base,
      workosAuthkitDomain: ISSUER,
      mcpOauthAudience: AUDIENCE,
    });
    expect(ok?.issuer).toBe(ISSUER);
    expect(ok?.audience).toBe(AUDIENCE);
  });

  it("accepts a correctly signed, unexpired, correctly-audienced token", async () => {
    const claims = await verifyAccessToken(await signToken(), oauthConfig, jwks);
    expect(claims.workosUserId).toBe(subject);
    expect(claims.email).toBe(email);
  });

  it("rejects an expired token", async () => {
    await expect(
      verifyAccessToken(
        await signToken({ exp: Math.floor(Date.now() / 1000) - 60 }),
        oauthConfig,
        jwks,
      ),
    ).rejects.toBeInstanceOf(AccessTokenError);
  });

  it("rejects a token with no exp claim (non-expiring)", async () => {
    await expect(
      verifyAccessToken(await signToken({ exp: false }), oauthConfig, jwks),
    ).rejects.toBeInstanceOf(AccessTokenError);
  });

  it("rejects a token from the wrong issuer", async () => {
    await expect(
      verifyAccessToken(await signToken({ issuer: "https://evil.example" }), oauthConfig, jwks),
    ).rejects.toBeInstanceOf(AccessTokenError);
  });

  it("rejects a token signed by an untrusted key", async () => {
    await expect(
      verifyAccessToken(await signToken({ key: foreign.privateKey }), oauthConfig, jwks),
    ).rejects.toBeInstanceOf(AccessTokenError);
  });

  it("rejects a non-RS256 (HS256 alg-confusion) token", async () => {
    const hs = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(ISSUER)
      .setSubject(subject)
      .setAudience(AUDIENCE)
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("shared-secret"));
    await expect(verifyAccessToken(hs, oauthConfig, jwks)).rejects.toBeInstanceOf(AccessTokenError);
  });

  it("rejects a token with the wrong audience", async () => {
    await expect(
      verifyAccessToken(await signToken({ audience: "some-other-resource" }), oauthConfig, jwks),
    ).rejects.toBeInstanceOf(AccessTokenError);
  });

  it("rejects a token with no audience claim", async () => {
    await expect(
      verifyAccessToken(await signToken({ audience: null }), oauthConfig, jwks),
    ).rejects.toBeInstanceOf(AccessTokenError);
  });

  it("rejects a token with no subject", async () => {
    const noSub = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime("1h")
      .sign(privateKey);
    await expect(verifyAccessToken(noSub, oauthConfig, jwks)).rejects.toBeInstanceOf(
      AccessTokenError,
    );
  });

  it("classifies JWT-shaped strings", () => {
    expect(looksLikeJwt("aaa.bbb.ccc")).toBe(true);
    expect(looksLikeJwt("fak_abc123")).toBe(false);
    expect(looksLikeJwt("aaa.bbb")).toBe(false);
  });
});

// --- Integration through resolvePrincipal (requires Postgres) ---

async function canConnect() {
  const sqlClient = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
  try {
    await sqlClient`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sqlClient.end().catch(() => undefined);
  }
}

describe("oauth resource server (integration)", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres unreachable; OAuth integration tests skipped", () => undefined);
    return;
  }

  const config: AppConfig = {
    databaseUrl,
    secretMasterKey: masterKey,
    port: 4400,
    publicUrl: "http://localhost:4400",
    sandboxApiUrl: "http://localhost:4400",
    sandboxGatewayUrl: "http://localhost:4410",
    sandboxRunnerImage: "facility-runner:dev",
    sandboxDriver: "docker",
    webUrl: "http://localhost:3000",
    facilityInsecureDev: true,
    logLevel: "silent",
    workosApiKey: "sk_test",
    workosClientId: "client_test",
    workosAuthkitDomain: ISSUER,
    mcpOauthAudience: AUDIENCE,
  };
  const app = await buildApp(config, { oauthJwks: jwks });
  const { db, client } = createDb(databaseUrl);
  let orgId = "";
  let fakKey = "";

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl);
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/auth/dev-login",
      payload: { email: `oauth-owner-${Date.now()}@example.com` },
    });
    expect(login.statusCode).toBe(200);
    orgId = login.json().orgId;
    const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const key = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: `oauth-fak-${Date.now()}`, roleId: "role_bundled_owner" },
    });
    expect(key.statusCode).toBe(200);
    fakKey = key.json().secret;
    const userId = newId("user");
    await db.insert(users).values({
      id: userId,
      workosUserId: subject,
      email,
      name: "OAuth User",
      status: "active",
    });
    await db.insert(orgMembers).values({
      id: newId("user"),
      orgId,
      userId,
      roleId: "role_bundled_owner",
    });
  });

  afterAll(async () => {
    await app.close();
    await client.end();
  });

  it("authenticates an API request with a valid OAuth access token", async () => {
    const me = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${await signToken()}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().principal.email).toBe(email);
    expect(me.json().principal.orgId).toBe(orgId);
  });

  it("rejects an expired token at the API with 401", async () => {
    const me = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: {
        authorization: `Bearer ${await signToken({ exp: Math.floor(Date.now() / 1000) - 60 })}`,
      },
    });
    expect(me.statusCode).toBe(401);
  });

  it("forbids a valid token whose subject has no platform membership", async () => {
    const me = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${await signToken({ sub: "workos_user_unknown" })}` },
    });
    expect(me.statusCode).toBe(403);
  });

  it("still accepts fak_ API keys and rejects missing auth", async () => {
    const withKey = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${fakKey}` },
    });
    expect(withKey.statusCode).toBe(200);
    const anon = await app.inject({ method: "GET", url: "/v1/me" });
    expect(anon.statusCode).toBe(401);
  });
});
