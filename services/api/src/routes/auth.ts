import { randomBytes } from "node:crypto";
import { newId, open, seal } from "@facility/core";
import {
  githubInstallations,
  insertAuditEvent,
  orgMembers,
  orgs,
  roles,
  seedBundledRegistryForOrg,
  userIdentities,
  users,
} from "@facility/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { mintSessionCookie } from "../app.js";
import { type AuthTransaction, ExternalIdentityProvider } from "../auth/identity-provider.js";
import { ApiError } from "../errors.js";
import type { AppConfig, ExternalIdentity } from "../types.js";

const EmptyResponse = z.object({ ok: z.boolean() });
const STATE_COOKIE = "facility_oauth_state";
const SESSION_COOKIE = "facility_session";

export async function registerAuthRoutes(
  app: FastifyInstance,
  config: AppConfig,
  options: { fetch?: typeof fetch } = {},
) {
  const provider = new ExternalIdentityProvider(config, options.fetch);

  app.get(
    "/auth/login",
    {
      config: { public: true },
      schema: {
        querystring: z.object({ returnTo: z.string().optional() }),
        response: { 302: z.unknown(), 501: z.object({ error: z.unknown() }) },
      },
    },
    async (request, reply) => {
      const { returnTo } = request.query as { returnTo?: string };
      const transaction: AuthTransaction = {
        state: randomBytes(24).toString("base64url"),
        verifier: randomBytes(48).toString("base64url"),
        nonce: randomBytes(24).toString("base64url"),
        returnTo: safeReturnTo(returnTo),
      };
      const sealed = await seal(JSON.stringify(transaction), config.secretMasterKey);
      reply.setCookie(STATE_COOKIE, sealed, cookieOptions(config, 600));
      return reply.redirect(await provider.authorizationUrl(transaction));
    },
  );

  app.get(
    "/auth/callback",
    {
      config: { public: true },
      schema: {
        querystring: z.object({
          code: z.string().optional(),
          state: z.string().optional(),
          error: z.string().optional(),
        }),
        response: { 302: z.unknown(), 401: z.unknown(), 403: z.unknown(), 501: z.unknown() },
      },
    },
    async (request, reply) => {
      const query = request.query as { code?: string; state?: string; error?: string };
      if (query.error) throw new ApiError(401, "auth_denied", "Authentication was denied");
      if (!query.code) throw new ApiError(401, "missing_code", "Authorization code is required");
      const stateCookie = request.cookies[STATE_COOKIE];
      let transaction: AuthTransaction;
      try {
        transaction = z
          .object({
            state: z.string(),
            verifier: z.string(),
            nonce: z.string(),
            returnTo: z.string(),
          })
          .parse(JSON.parse(await open(stateCookie ?? "", config.secretMasterKey)));
      } catch {
        throw new ApiError(401, "bad_state", "OAuth state is missing or invalid");
      }
      if (transaction.state !== query.state)
        throw new ApiError(401, "bad_state", "OAuth state mismatch");
      reply.clearCookie(STATE_COOKIE, { path: "/" });

      let identity: ExternalIdentity;
      try {
        identity = await provider.exchange(query.code, transaction);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        request.log.warn({ err: error }, "external identity exchange failed");
        throw new ApiError(401, "auth_failed", "Authentication failed");
      }
      const session = await ensureGithubUser(app.facilityDb, identity);
      reply.setCookie(
        SESSION_COOKIE,
        await mintSessionCookie(config, session.userId, session.orgId),
        cookieOptions(config, 7 * 24 * 60 * 60),
      );
      await insertAuditEvent(app.facilityDb, {
        orgId: session.orgId,
        actor: { type: "user", id: session.userId },
        action: "auth.login",
        target: { type: "user", id: session.userId },
        payload: { via: config.authIdentityProvider ?? "github" },
        ip: request.ip,
        userAgent: request.headers["user-agent"],
      });
      return reply.redirect(
        new URL(transaction.returnTo, config.webUrl ?? config.publicUrl).toString(),
      );
    },
  );

  app.post(
    "/auth/logout",
    { config: { public: true }, schema: { response: { 200: EmptyResponse } } },
    async (request, reply) => {
      if (request.principal)
        await request.audit("auth.logout", {
          type: request.principal.type,
          id: request.principal.id,
        });
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return { ok: true };
    },
  );

  app.get(
    "/auth/default-org",
    {
      config: { permission: "org:read" },
      schema: { response: { 200: z.object({ id: z.string(), slug: z.string() }) } },
    },
    async (request) => {
      const principal = request.principal;
      if (!principal) throw new ApiError(401, "unauthorized", "Authentication required");
      const org = (
        await app.facilityDb.select().from(orgs).where(eq(orgs.id, principal.orgId)).limit(1)
      )[0];
      if (!org) throw new ApiError(404, "not_found", "Organization not found");
      return { id: org.id, slug: org.slug };
    },
  );
}

/** Resolve a verified GitHub identity to an explicitly provisioned Facility member. */
export async function ensureGithubUser(
  db: FastifyInstance["facilityDb"],
  identity: ExternalIdentity,
): Promise<{ userId: string; orgId: string }> {
  return db.transaction((tx) =>
    ensureGithubUserTransaction(tx as unknown as FastifyInstance["facilityDb"], identity),
  );
}

async function ensureGithubUserTransaction(
  db: FastifyInstance["facilityDb"],
  identity: ExternalIdentity,
): Promise<{ userId: string; orgId: string }> {
  const linked = (
    await db
      .select({ identity: userIdentities, user: users })
      .from(userIdentities)
      .innerJoin(users, eq(userIdentities.userId, users.id))
      .where(
        and(
          eq(userIdentities.provider, "github"),
          eq(userIdentities.providerSubject, identity.githubUserId),
        ),
      )
      .limit(1)
  )[0];
  const emailMatches = linked
    ? []
    : await db
        .select()
        .from(users)
        .where(
          and(
            eq(users.status, "active"),
            inArray(sql`lower(${users.email})`, identity.verifiedEmails),
          ),
        )
        .limit(2);
  if (!linked && emailMatches.length > 1) {
    throw new ApiError(
      403,
      "identity_conflict",
      "Multiple Facility users match verified GitHub emails",
    );
  }
  const invited = linked?.user ?? emailMatches[0];
  if (invited?.status !== "active") {
    throw new ApiError(
      403,
      "not_invited",
      "No active Facility invitation exists for this GitHub user",
    );
  }

  const memberships = await db
    .select({ member: orgMembers, role: roles, installation: githubInstallations })
    .from(orgMembers)
    .innerJoin(roles, eq(orgMembers.roleId, roles.id))
    .innerJoin(githubInstallations, eq(githubInstallations.orgId, orgMembers.orgId))
    .where(and(eq(orgMembers.userId, invited.id), isNull(githubInstallations.suspendedAt)))
    .orderBy(orgMembers.createdAt, orgMembers.orgId);
  const admitted = memberships.find(({ installation }) =>
    identity.installations.some(
      (candidate) =>
        candidate.installationId === installation.installationId &&
        candidate.accountId === installation.accountId,
    ),
  );
  if (!admitted)
    throw new ApiError(
      403,
      "installation_access_required",
      "GitHub App installation access is required for this Facility instance",
    );

  if (!linked) {
    const conflicting = (
      await db
        .select()
        .from(userIdentities)
        .where(and(eq(userIdentities.userId, invited.id), eq(userIdentities.provider, "github")))
        .limit(1)
    )[0];
    if (conflicting)
      throw new ApiError(
        403,
        "identity_conflict",
        "This Facility user is linked to another GitHub identity",
      );
    await db.insert(userIdentities).values({
      id: newId("user"),
      userId: invited.id,
      provider: "github",
      providerSubject: identity.githubUserId,
      login: identity.login,
      metadata: { accountIds: identity.installations.map((entry) => entry.accountId) },
    });
  } else if (linked.user.id !== invited.id) {
    throw new ApiError(
      403,
      "identity_conflict",
      "GitHub identity is linked to another Facility user",
    );
  }

  await db
    .update(users)
    .set({
      name: identity.name ?? invited.name,
      avatarUrl: identity.avatarUrl ?? invited.avatarUrl,
      updatedAt: new Date(),
    })
    .where(eq(users.id, invited.id));
  await db
    .update(userIdentities)
    .set({ login: identity.login, updatedAt: new Date() })
    .where(
      and(
        eq(userIdentities.provider, "github"),
        eq(userIdentities.providerSubject, identity.githubUserId),
      ),
    );
  await seedBundledRegistryForOrg(db, admitted.member.orgId);
  return { userId: invited.id, orgId: admitted.member.orgId };
}

function cookieOptions(config: AppConfig, maxAge: number) {
  const callback =
    config.authCallbackUrl ?? `${config.webUrl ?? config.publicUrl}/api/auth/callback`;
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: callback.startsWith("https://"),
    maxAge,
  };
}

function safeReturnTo(value: string | undefined) {
  if (!value || value === "/") return "/";
  return /^\/oauth\/interaction\/[A-Za-z0-9_-]+$/.test(value) ? value : "/";
}
