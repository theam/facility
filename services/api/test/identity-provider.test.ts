import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { ExternalIdentityProvider } from "../src/auth/identity-provider.js";
import type { AppConfig } from "../src/types.js";

const base: AppConfig = {
  databaseUrl: "postgres://facility:facility@localhost/facility",
  secretMasterKey: Buffer.alloc(32, 5).toString("base64"),
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
  authCallbackUrl: "http://localhost:3400/api/auth/callback",
};
const transaction = { state: "state", verifier: "v".repeat(64), nonce: "nonce", returnTo: "/" };

describe("GitHub external identity integration", () => {
  it("exchanges a code and verifies email plus installation access through a fake GitHub API", async () => {
    const calls: string[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/login/oauth/access_token")) {
        expect(String(init?.body)).toContain("code_verifier=");
        return response({ access_token: "ghu_secret", token_type: "bearer" });
      }
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer ghu_secret");
      if (url.endsWith("/user/emails"))
        return response([
          { email: "Owner@Personal.example", verified: true, primary: true },
          { email: "Owner@Example.com", verified: true, primary: false },
          { email: "unverified@example.com", verified: false, primary: false },
        ]);
      if (url.includes("/user/installations")) {
        if (url.includes("page=2"))
          return response({ installations: [{ id: 457, account: { id: 790 } }] });
        return response({ installations: [{ id: 456, account: { id: 789 } }] }, 200, {
          link: '<https://api.github.test/user/installations?per_page=100&page=2>; rel="next"',
        });
      }
      if (url.endsWith("/user"))
        return response({
          id: 123,
          login: "octocat",
          name: "Octo Cat",
          avatar_url: "https://example.com/avatar.png",
        });
      return response({}, 404);
    };
    const provider = new ExternalIdentityProvider(
      {
        ...base,
        authIdentityProvider: "github",
        githubOauthClientId: "client",
        githubOauthClientSecret: "secret",
        githubOauthAuthorizeUrl: "https://github.test/login/oauth/authorize",
        githubOauthTokenUrl: "https://github.test/login/oauth/access_token",
        githubOauthApiUrl: "https://api.github.test",
      },
      fakeFetch,
    );
    const authorization = new URL(await provider.authorizationUrl(transaction));
    expect(authorization.searchParams.get("state")).toBe("state");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    await expect(provider.exchange("code", transaction)).resolves.toEqual({
      provider: "github",
      githubUserId: "123",
      login: "octocat",
      email: "owner@personal.example",
      emailVerified: true,
      verifiedEmails: ["owner@personal.example", "owner@example.com"],
      name: "Octo Cat",
      avatarUrl: "https://example.com/avatar.png",
      installations: [
        { installationId: 456, accountId: 789 },
        { installationId: 457, accountId: 790 },
      ],
    });
    expect(calls).toHaveLength(5);
    expect(calls.some((url) => url.includes("/user/memberships/orgs/"))).toBe(false);
  });

  it("requires active membership when a GitHub organization is configured", async () => {
    const calls: string[] = [];
    const provider = new ExternalIdentityProvider(
      {
        ...base,
        githubOauthClientId: "id",
        githubOauthClientSecret: "secret",
        githubOauthAllowedOrganization: "theam",
        githubOauthTokenUrl: "https://github.test/login/oauth/access_token",
        githubOauthApiUrl: "https://api.github.test",
      },
      validGithubFetch(calls, response({ state: "active", organization: { login: "TheAM" } })),
    );

    await expect(provider.exchange("code", transaction)).resolves.toMatchObject({
      githubUserId: "123",
      login: "octocat",
    });
    expect(calls).toContain("https://api.github.test/user/memberships/orgs/theam");
  });

  it.each([
    ["a non-member", response({}, 404), 403, "organization_membership_required"],
    [
      "a pending member",
      response({ state: "pending", organization: { login: "theam" } }),
      403,
      "organization_membership_required",
    ],
    ["a malformed response", response({ state: "active" }), 401, "auth_failed"],
    ["an upstream failure", response({}, 502), 401, "auth_failed"],
  ])("fails closed for %s", async (_case, membership, statusCode, code) => {
    const provider = new ExternalIdentityProvider(
      {
        ...base,
        githubOauthClientId: "id",
        githubOauthClientSecret: "secret",
        githubOauthAllowedOrganization: "theam",
        githubOauthTokenUrl: "https://github.test/login/oauth/access_token",
        githubOauthApiUrl: "https://api.github.test",
      },
      validGithubFetch([], membership),
    );

    await expect(provider.exchange("code", transaction)).rejects.toMatchObject({
      statusCode,
      code,
    });
  });

  it("fails closed when GitHub returns no verified email", async () => {
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("access_token")) return response({ access_token: "secret" });
      if (url.endsWith("/user/emails"))
        return response([{ email: "owner@example.com", verified: false, primary: true }]);
      if (url.includes("/user/installations")) return response({ installations: [] });
      return response({ id: 1, login: "owner" });
    };
    const provider = new ExternalIdentityProvider(
      { ...base, githubOauthClientId: "id", githubOauthClientSecret: "secret" },
      fakeFetch,
    );
    await expect(provider.exchange("code", transaction)).rejects.toMatchObject({
      code: "auth_failed",
      statusCode: 401,
    });
  });
});

describe("commercial OIDC broker integration", () => {
  it("validates signature, nonce, audience and instance-bound GitHub claims", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const publicJwk = { ...(await exportJWK(publicKey)), kid: "broker", alg: "ES256" };
    const claims = {
      nonce: transaction.nonce,
      github_user_id: 123,
      github_login: "octocat",
      email: "owner@example.com",
      email_verified: true,
      github_account_id: 789,
      github_installation_id: 456,
      facility_instance_id: "instance_1",
    };
    const sign = (overrides: Partial<typeof claims> = {}) =>
      new SignJWT({ ...claims, ...overrides })
        .setProtectedHeader({ alg: "ES256", kid: "broker" })
        .setIssuer("https://broker.test")
        .setAudience("facility-client")
        .setSubject("github:123")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
    let idToken = await sign();
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration"))
        return response({
          issuer: "https://broker.test",
          authorization_endpoint: "https://broker.test/authorize",
          token_endpoint: "https://broker.test/token",
          jwks_uri: "https://broker.test/jwks",
        });
      if (url.endsWith("/token")) return response({ id_token: idToken });
      if (url.endsWith("/jwks")) return response({ keys: [publicJwk] });
      return response({}, 404);
    };
    const provider = new ExternalIdentityProvider(
      {
        ...base,
        authIdentityProvider: "oidc",
        oidcIssuer: "https://broker.test",
        oidcClientId: "facility-client",
        facilityInstanceId: "instance_1",
      },
      fakeFetch,
    );
    await expect(provider.exchange("code", transaction)).resolves.toMatchObject({
      githubUserId: "123",
      verifiedEmails: ["owner@example.com"],
      installations: [{ installationId: 456, accountId: 789 }],
    });
    idToken = await sign({ facility_instance_id: "another_instance" });
    await expect(provider.exchange("code", transaction)).rejects.toMatchObject({
      statusCode: 403,
      code: "identity_mismatch",
    });
    idToken = await sign({ nonce: "replayed-nonce" });
    await expect(provider.exchange("code", transaction)).rejects.toMatchObject({
      statusCode: 403,
      code: "identity_mismatch",
    });
  });
});

function response(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function validGithubFetch(calls: string[], membership: Response): typeof fetch {
  return async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/login/oauth/access_token")) return response({ access_token: "secret" });
    if (url.endsWith("/user/emails"))
      return response([{ email: "owner@example.com", verified: true, primary: true }]);
    if (url.includes("/user/installations"))
      return response({ installations: [{ id: 456, account: { id: 789 } }] });
    if (url.includes("/user/memberships/orgs/")) return membership;
    if (url.endsWith("/user")) return response({ id: 123, login: "octocat" });
    return response({}, 404);
  };
}
