import { newId } from "@facility/core";
import {
  auditEvents,
  createDb,
  githubInstallations,
  migrate,
  orgMembers,
  orgs,
  seed,
  userIdentities,
  users,
} from "@facility/db";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/types.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";

describe("direct GitHub browser login", async () => {
  const probe = postgres(databaseUrl, { max: 1, connect_timeout: 2 });
  let reachable = true;
  try {
    await probe`select 1`;
  } catch {
    reachable = false;
  } finally {
    await probe.end();
  }
  if (!reachable) {
    it.skip("Postgres unreachable", () => undefined);
    return;
  }

  const installationId = 7_100_000 + Math.floor(Math.random() * 100_000);
  const accountId = 7_200_000 + Math.floor(Math.random() * 100_000);
  const githubUserId = Date.now();
  const orgId = `org_github_login_${Date.now()}`;
  const ownerEmail = `github-login-${Date.now()}@example.com`;
  const primaryEmail = `github-primary-${Date.now()}@personal.example`;
  let membershipState: "active" | "missing" = "active";
  let membershipChecks = 0;
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/login/oauth/access_token"))
      return json({ access_token: "ghu_must_not_persist" });
    if (url.endsWith("/user/emails"))
      return json([
        { email: primaryEmail, verified: true, primary: true },
        { email: ownerEmail, verified: true, primary: false },
        { email: "unverified@example.com", verified: false, primary: false },
      ]);
    if (url.includes("/user/installations"))
      return json({ installations: [{ id: installationId, account: { id: accountId } }] });
    if (url.endsWith("/user/memberships/orgs/theam")) {
      membershipChecks += 1;
      return membershipState === "active"
        ? json({ state: "active", organization: { login: "theam" } })
        : json({}, 404);
    }
    if (url.endsWith("/user"))
      return json({ id: githubUserId, login: "facility-owner", name: "Facility Owner" });
    return json({}, 404);
  };
  const config: AppConfig = {
    databaseUrl,
    secretMasterKey: Buffer.alloc(32, 11).toString("base64"),
    port: 4400,
    publicUrl: "http://localhost:4400",
    webUrl: "http://localhost:3400",
    sandboxApiUrl: "http://localhost:4400",
    sandboxGatewayUrl: "http://localhost:4410",
    gatewayUrl: "http://localhost:4410",
    sandboxRunnerImage: "facility-runner:dev",
    sandboxDriver: "docker",
    facilityInsecureDev: true,
    logLevel: "silent",
    authIdentityProvider: "github",
    authCallbackUrl: "http://localhost:3400/api/auth/callback",
    githubOauthClientId: "github-client",
    githubOauthClientSecret: "github-secret",
    githubOauthAuthorizeUrl: "https://github.test/login/oauth/authorize",
    githubOauthTokenUrl: "https://github.test/login/oauth/access_token",
    githubOauthApiUrl: "https://api.github.test",
    githubOauthAllowedOrganization: "theam",
  };
  const app = await buildApp(config, { authFetch: fakeFetch });
  const unrestrictedApp = await buildApp(
    { ...config, githubOauthAllowedOrganization: undefined },
    { authFetch: fakeFetch },
  );
  const { db, client } = createDb(databaseUrl);

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl);
    await app.ready();
    await unrestrictedApp.ready();
    const userId = newId("user");
    await db.insert(orgs).values({
      id: orgId,
      name: "GitHub login integration",
      slug: `github-login-${Date.now()}`,
    });
    await db.insert(users).values({ id: userId, email: ownerEmail, status: "active" });
    await db.insert(orgMembers).values({
      id: newId("member"),
      orgId,
      userId,
      roleId: "role_bundled_owner",
    });
    await db.insert(githubInstallations).values({
      id: newId("int"),
      orgId,
      installationId,
      accountId,
      accountLogin: "facility",
      targetType: "Organization",
    });
  });
  afterAll(async () => {
    await app.close();
    await unrestrictedApp.close();
    await client.end();
  });

  it("admits an invitation matching a verified secondary GitHub email", async () => {
    const auditBefore = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(eq(auditEvents.action, "auth.login"));
    const start = await app.inject({
      method: "GET",
      url: "/auth/login?returnTo=https://evil.example/steal",
    });
    expect(start.statusCode).toBe(302);
    const authorization = new URL(required(start.headers.location, "authorization redirect"));
    expect(authorization.origin).toBe("https://github.test");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    const stateCookie = required(
      start.cookies.find((cookie) => cookie.name === "facility_oauth_state"),
      "OAuth state cookie",
    );
    const callback = await app.inject({
      method: "GET",
      url: `/auth/callback?code=github-code&state=${authorization.searchParams.get("state")}`,
      headers: { cookie: `${stateCookie.name}=${stateCookie.value}` },
    });
    expect(callback.statusCode).toBe(302);
    expect(membershipChecks).toBeGreaterThan(0);
    expect(callback.headers.location).toBe("http://localhost:3400/");
    const session = required(
      callback.cookies.find((cookie) => cookie.name === "facility_session"),
      "Facility session cookie",
    );
    const me = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { cookie: `${session.name}=${session.value}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().principal.email).toBe(ownerEmail);
    const persistedUser = await db.select().from(users).where(eq(users.email, ownerEmail));
    expect(persistedUser).toHaveLength(1);
    const persistedIdentity = await db
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.providerSubject, String(githubUserId)));
    expect(persistedIdentity).toHaveLength(1);
    expect(JSON.stringify(persistedIdentity)).not.toContain("ghu_must_not_persist");
    const loginAudit = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(eq(auditEvents.action, "auth.login"));
    expect(loginAudit).toHaveLength(auditBefore.length + 1);
  });

  it("rejects an invited installation user outside the configured organization", async () => {
    const start = await app.inject({ method: "GET", url: "/auth/login" });
    const stateCookie = required(
      start.cookies.find((cookie) => cookie.name === "facility_oauth_state"),
      "OAuth state cookie",
    );
    const authorization = new URL(required(start.headers.location, "authorization redirect"));
    membershipState = "missing";
    const callback = await app.inject({
      method: "GET",
      url: `/auth/callback?code=github-code&state=${authorization.searchParams.get("state")}`,
      headers: { cookie: `${stateCookie.name}=${stateCookie.value}` },
    });
    membershipState = "active";

    expect(callback.statusCode).toBe(403);
    expect(callback.json().error.code).toBe("organization_membership_required");
    expect(callback.cookies.some((cookie) => cookie.name === "facility_session")).toBe(false);
  });

  it("preserves existing login behavior when no organization is configured", async () => {
    const checksBefore = membershipChecks;
    membershipState = "missing";
    const start = await unrestrictedApp.inject({ method: "GET", url: "/auth/login" });
    const stateCookie = required(
      start.cookies.find((cookie) => cookie.name === "facility_oauth_state"),
      "OAuth state cookie",
    );
    const authorization = new URL(required(start.headers.location, "authorization redirect"));
    const callback = await unrestrictedApp.inject({
      method: "GET",
      url: `/auth/callback?code=github-code&state=${authorization.searchParams.get("state")}`,
      headers: { cookie: `${stateCookie.name}=${stateCookie.value}` },
    });
    membershipState = "active";

    expect(callback.statusCode).toBe(302);
    expect(callback.cookies.some((cookie) => cookie.name === "facility_session")).toBe(true);
    expect(membershipChecks).toBe(checksBefore);
  });

  it("rejects callback state replay or mismatch before calling GitHub", async () => {
    const callback = await app.inject({
      method: "GET",
      url: "/auth/callback?code=code&state=forged",
    });
    expect(callback.statusCode).toBe(401);
    expect(callback.json().error.code).toBe("bad_state");
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`Missing ${label}`);
  return value;
}
