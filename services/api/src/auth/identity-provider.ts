import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { z } from "zod";
import { ApiError } from "../errors.js";
import type { AppConfig, ExternalIdentity } from "../types.js";

export type AuthTransaction = {
  state: string;
  verifier: string;
  nonce: string;
  returnTo: string;
};

type OidcMetadata = {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
};

export class ExternalIdentityProvider {
  readonly config: AppConfig;
  readonly fetch: typeof fetch;
  #metadata?: OidcMetadata;

  constructor(config: AppConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  get configured() {
    return (this.config.authIdentityProvider ?? "github") === "github"
      ? Boolean(this.config.githubOauthClientId && this.config.githubOauthClientSecret)
      : Boolean(
          this.config.oidcIssuer && this.config.oidcClientId && this.config.facilityInstanceId,
        );
  }

  async authorizationUrl(transaction: AuthTransaction) {
    if (!this.configured)
      throw new ApiError(501, "auth_unconfigured", "Login is not configured", undefined, true);
    const challenge = await pkceChallenge(transaction.verifier);
    if ((this.config.authIdentityProvider ?? "github") === "github") {
      const url = new URL(
        this.config.githubOauthAuthorizeUrl ?? "https://github.com/login/oauth/authorize",
      );
      url.search = new URLSearchParams({
        client_id: requiredConfig(this.config.githubOauthClientId),
        redirect_uri: callbackUrl(this.config),
        state: transaction.state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString();
      return url.toString();
    }
    const metadata = await this.oidcMetadata();
    const url = new URL(metadata.authorization_endpoint);
    url.search = new URLSearchParams({
      client_id: requiredConfig(this.config.oidcClientId),
      redirect_uri: callbackUrl(this.config),
      response_type: "code",
      scope: "openid profile email facility_instance",
      state: transaction.state,
      nonce: transaction.nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return url.toString();
  }

  async exchange(code: string, transaction: AuthTransaction): Promise<ExternalIdentity> {
    return (this.config.authIdentityProvider ?? "github") === "github"
      ? this.exchangeGithub(code, transaction.verifier)
      : this.exchangeOidc(code, transaction);
  }

  private async exchangeGithub(code: string, verifier: string): Promise<ExternalIdentity> {
    const tokenResponse = await this.fetch(
      this.config.githubOauthTokenUrl ?? "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: requiredConfig(this.config.githubOauthClientId),
          client_secret: requiredConfig(this.config.githubOauthClientSecret),
          redirect_uri: callbackUrl(this.config),
          code,
          code_verifier: verifier,
        }),
      },
    );
    const tokenBody = z
      .object({ access_token: z.string().min(1), token_type: z.string().optional() })
      .safeParse(await json(tokenResponse));
    if (!tokenResponse.ok || !tokenBody.success)
      throw new ApiError(401, "auth_failed", "GitHub authentication failed");
    const headers = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${tokenBody.data.access_token}`,
      "x-github-api-version": "2022-11-28",
    };
    const [userResponse, emailsResponse, installations] = await Promise.all([
      this.fetch(`${this.config.githubOauthApiUrl ?? "https://api.github.com"}/user`, { headers }),
      this.fetch(`${this.config.githubOauthApiUrl ?? "https://api.github.com"}/user/emails`, {
        headers,
      }),
      this.githubInstallations(headers),
      this.verifyGithubOrganizationMembership(headers),
    ]);
    const user = z
      .object({
        id: z.number().int().positive(),
        login: z.string().min(1),
        name: z.string().nullable().optional(),
        avatar_url: z.string().url().optional(),
      })
      .safeParse(await json(userResponse));
    const emails = z
      .array(z.object({ email: z.string().email(), verified: z.boolean(), primary: z.boolean() }))
      .safeParse(await json(emailsResponse));
    const verifiedEmails = emails.success
      ? [...new Set(emails.data.filter((entry) => entry.verified).map(normalizedEmail))]
      : [];
    const email = emails.success
      ? (emails.data.find((entry) => entry.primary && entry.verified)?.email ?? verifiedEmails[0])
      : undefined;
    if (!userResponse.ok || !emailsResponse.ok || !user.success || !email || !installations) {
      throw new ApiError(
        401,
        "auth_failed",
        "GitHub identity or installation access could not be verified",
      );
    }
    return {
      provider: "github",
      githubUserId: String(user.data.id),
      login: user.data.login,
      email: normalizedEmail(email),
      emailVerified: true,
      verifiedEmails,
      name: user.data.name ?? undefined,
      avatarUrl: user.data.avatar_url,
      installations: installations.map((installation) => ({
        installationId: installation.id,
        accountId: installation.account.id,
      })),
    };
  }

  private async verifyGithubOrganizationMembership(headers: Record<string, string>) {
    const organization = this.config.githubOauthAllowedOrganization;
    if (!organization) return;

    const response = await this.fetch(
      `${this.config.githubOauthApiUrl ?? "https://api.github.com"}/user/memberships/orgs/${organization}`,
      { headers },
    );
    const membership = z
      .object({
        state: z.string(),
        organization: z.object({ login: z.string() }),
      })
      .safeParse(await json(response));

    if (response.status === 404 || (membership.success && membership.data.state !== "active")) {
      throw new ApiError(
        403,
        "organization_membership_required",
        `Active membership in the ${organization} GitHub organization is required`,
      );
    }
    if (
      !response.ok ||
      !membership.success ||
      membership.data.organization.login.toLowerCase() !== organization
    ) {
      throw new ApiError(
        401,
        "auth_failed",
        "GitHub organization membership could not be verified",
      );
    }
  }

  private async githubInstallations(headers: Record<string, string>) {
    const endpoint = new URL(
      `${this.config.githubOauthApiUrl ?? "https://api.github.com"}/user/installations`,
    );
    endpoint.searchParams.set("per_page", "100");
    const installations: Array<{ id: number; account: { id: number } }> = [];
    let next: URL | undefined = endpoint;
    // A hard ceiling prevents a malicious or broken upstream from creating an
    // unbounded callback request. Ten thousand installations is already well
    // beyond a realistic human account.
    for (let page = 0; next && page < 100; page += 1) {
      const response = await this.fetch(next, { headers });
      const body = z
        .object({
          installations: z.array(
            z.object({
              id: z.number().int().positive(),
              account: z.object({ id: z.number().int().positive() }),
            }),
          ),
        })
        .safeParse(await json(response));
      if (!response.ok || !body.success) return undefined;
      installations.push(...body.data.installations);
      const nextUrl = nextLink(response.headers.get("link"));
      if (!nextUrl) return installations;
      const parsed = new URL(nextUrl);
      if (parsed.origin !== endpoint.origin || parsed.pathname !== endpoint.pathname)
        return undefined;
      next = parsed;
    }
    return next ? undefined : installations;
  }

  private async exchangeOidc(
    code: string,
    transaction: AuthTransaction,
  ): Promise<ExternalIdentity> {
    const metadata = await this.oidcMetadata();
    const response = await this.fetch(metadata.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: requiredConfig(this.config.oidcClientId),
        ...(this.config.oidcClientSecret ? { client_secret: this.config.oidcClientSecret } : {}),
        redirect_uri: callbackUrl(this.config),
        code,
        code_verifier: transaction.verifier,
      }),
    });
    const body = z.object({ id_token: z.string().min(1) }).safeParse(await json(response));
    if (!response.ok || !body.success)
      throw new ApiError(401, "auth_failed", "OIDC authentication failed");
    let payload: Record<string, unknown>;
    try {
      const verified = await jwtVerify(
        body.data.id_token,
        createRemoteJWKSet(new URL(metadata.jwks_uri), { [customFetch]: this.fetch }),
        {
          issuer: metadata.issuer,
          audience: this.config.oidcClientId,
          requiredClaims: ["exp", "iat", "sub", "nonce"],
        },
      );
      payload = verified.payload;
    } catch {
      throw new ApiError(401, "auth_failed", "OIDC identity token is invalid");
    }
    const claims = z
      .object({
        nonce: z.literal(transaction.nonce),
        github_user_id: z.union([z.string(), z.number()]).transform(String),
        github_login: z.string().min(1),
        email: z.string().email(),
        email_verified: z.literal(true),
        github_account_id: z.coerce.number().int().positive(),
        github_installation_id: z.coerce.number().int().positive(),
        facility_instance_id: z.literal(requiredConfig(this.config.facilityInstanceId)),
        name: z.string().optional(),
        picture: z.string().url().optional(),
      })
      .safeParse(payload);
    if (!claims.success)
      throw new ApiError(
        403,
        "identity_mismatch",
        "OIDC identity is not valid for this Facility instance",
      );
    const email = normalizedEmail(claims.data.email);
    return {
      provider: "github",
      githubUserId: claims.data.github_user_id,
      login: claims.data.github_login,
      email,
      emailVerified: true,
      verifiedEmails: [email],
      name: claims.data.name,
      avatarUrl: claims.data.picture,
      installations: [
        {
          installationId: claims.data.github_installation_id,
          accountId: claims.data.github_account_id,
        },
      ],
    };
  }

  private async oidcMetadata(): Promise<OidcMetadata> {
    if (this.#metadata) return this.#metadata;
    const issuer = requiredConfig(this.config.oidcIssuer);
    const response = await this.fetch(`${issuer}/.well-known/openid-configuration`);
    const metadata = z
      .object({
        issuer: z.literal(issuer),
        authorization_endpoint: z.string().url(),
        token_endpoint: z.string().url(),
        jwks_uri: z.string().url(),
      })
      .safeParse(await json(response));
    if (!response.ok || !metadata.success)
      throw new ApiError(
        503,
        "identity_provider_unavailable",
        "OIDC provider metadata is unavailable",
      );
    this.#metadata = metadata.data;
    return metadata.data;
  }
}

async function json(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

export async function pkceChallenge(verifier: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return Buffer.from(digest).toString("base64url");
}

function callbackUrl(config: AppConfig) {
  return (
    config.authCallbackUrl ??
    `${(config.webUrl ?? config.publicUrl).replace(/\/$/, "")}/api/auth/callback`
  );
}

function requiredConfig(value: string | undefined): string {
  if (!value)
    throw new ApiError(501, "auth_unconfigured", "Login is not configured", undefined, true);
  return value;
}

function normalizedEmail(value: { email: string } | string): string {
  return (typeof value === "string" ? value : value.email).trim().toLowerCase();
}

function nextLink(header: string | null): string | undefined {
  const entry = header?.split(",").find((value) => /;\s*rel="next"\s*$/.test(value));
  return entry?.match(/<([^>]+)>/)?.[1];
}
