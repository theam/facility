import { randomBytes } from "node:crypto";
import { newId } from "@facility/core";
import {
  orgMembers,
  orgs,
  roles as rolesTable,
  seedBundledRegistryForOrg,
  users,
} from "@facility/db";
import { WorkOS } from "@workos-inc/node";
import { and, eq, isNull, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ensureDevUser, mintSessionCookie } from "../app.js";
import { ApiError } from "../errors.js";
import type { AppConfig } from "../types.js";

const EmptyResponse = z.object({ ok: z.boolean() });
const STATE_COOKIE = "facility_oauth_state";

export async function registerAuthRoutes(app: FastifyInstance, config: AppConfig) {
  const workos =
    config.workosApiKey && config.workosClientId ? new WorkOS(config.workosApiKey) : null;
  const redirectUri = config.workosRedirectUri ?? `${config.publicUrl}/auth/callback`;

  app.get(
    "/auth/login",
    {
      config: { public: true },
      schema: { response: { 302: z.unknown(), 501: z.object({ error: z.unknown() }) } },
    },
    async (_request, reply) => {
      if (!workos || !config.workosClientId) {
        throw new ApiError(
          501,
          "workos_unconfigured",
          "WorkOS login is not configured",
          undefined,
          true,
        );
      }
      // CSRF: bind the OAuth round-trip to a cookie-held nonce.
      const state = randomBytes(16).toString("hex");
      reply.setCookie(STATE_COOKIE, state, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: redirectUri.startsWith("https://"),
        maxAge: 600,
      });
      const url = workos.userManagement.getAuthorizationUrl({
        provider: "authkit",
        clientId: config.workosClientId,
        redirectUri,
        state,
      });
      return reply.redirect(url);
    },
  );

  app.get(
    "/auth/callback",
    {
      config: { public: true },
      schema: {
        querystring: z.object({ code: z.string().optional(), state: z.string().optional() }),
        response: { 302: z.unknown(), 401: z.unknown(), 403: z.unknown(), 501: z.unknown() },
      },
    },
    async (request, reply) => {
      if (!workos || !config.workosClientId) {
        throw new ApiError(501, "workos_unconfigured", "WorkOS is not configured", undefined, true);
      }
      const { code, state } = request.query as { code?: string; state?: string };
      if (!code) throw new ApiError(401, "missing_code", "Authorization code is required");
      const expectedState = request.cookies[STATE_COOKIE];
      if (!expectedState || expectedState !== state) {
        throw new ApiError(401, "bad_state", "OAuth state mismatch");
      }
      reply.clearCookie(STATE_COOKIE, { path: "/" });

      let workosUser: {
        id: string;
        email: string;
        firstName?: string | null;
        lastName?: string | null;
      };
      try {
        const result = await workos.userManagement.authenticateWithCode({
          clientId: config.workosClientId,
          code,
        });
        workosUser = result.user;
      } catch (error) {
        request.log.warn({ err: error }, "workos code exchange failed");
        throw new ApiError(401, "auth_failed", "WorkOS authentication failed");
      }

      const session = await ensureWorkosUser(
        app.facilityDb,
        {
          workosUserId: workosUser.id,
          email: workosUser.email,
          name:
            [workosUser.firstName, workosUser.lastName].filter(Boolean).join(" ").trim() ||
            undefined,
        },
        {
          autoJoin: config.facilityAutoJoin,
        },
      );
      const sealed = await mintSessionCookie(config, session.userId, session.orgId);
      reply.setCookie("facility_session", sealed, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: redirectUri.startsWith("https://"),
      });
      await request.audit("auth.login", { type: "user", id: session.userId }, { via: "workos" });
      return reply.redirect(config.webUrl ?? "/");
    },
  );

  app.post(
    "/auth/dev-login",
    {
      config: { public: true },
      schema: {
        body: z.object({ email: z.string().email() }),
        response: {
          200: z.object({ ok: z.boolean(), orgId: z.string(), userId: z.string() }),
        },
      },
    },
    async (request, reply) => {
      if (!config.facilityInsecureDev) {
        throw new ApiError(404, "not_found", "Dev login is disabled");
      }
      const { email } = request.body as { email: string };
      const session = await ensureDevUser(app.facilityDb, email);
      const sealed = await mintSessionCookie(config, session.userId, session.orgId);
      // The session value is sealed with authenticated encryption (libsodium
      // secretbox) — that IS the integrity layer, so no cookie signing on top.
      reply.setCookie("facility_session", sealed, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: config.publicUrl.startsWith("https://"),
      });
      await request.audit("auth.login", { type: "user", id: session.userId });
      return { ok: true, ...session };
    },
  );

  app.post(
    "/auth/logout",
    {
      config: { public: true },
      schema: { response: { 200: EmptyResponse } },
    },
    async (request, reply) => {
      if (request.principal) {
        await request.audit("auth.logout", {
          type: request.principal.type,
          id: request.principal.id,
        });
      }
      reply.clearCookie("facility_session", { path: "/" });
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

/**
 * Upsert a WorkOS-authenticated user and resolve their org. An existing member
 * keeps their org. Otherwise membership must be provisioned first, unless an
 * org explicitly admits the user's email domain or auto-join is opted in.
 */
export async function ensureWorkosUser(
  db: FastifyInstance["facilityDb"],
  input: { workosUserId: string; email: string; name?: string },
  options: { autoJoin?: boolean } = {},
): Promise<{ userId: string; orgId: string }> {
  const existing =
    (await db.select().from(users).where(eq(users.workosUserId, input.workosUserId)).limit(1))[0] ??
    (await db.select().from(users).where(eq(users.email, input.email)).limit(1))[0];

  const userId = existing?.id ?? newId("user");
  if (existing) {
    await db
      .update(users)
      .set({
        workosUserId: input.workosUserId,
        name: input.name ?? existing.name,
        updatedAt: new Date(),
      })
      .where(eq(users.id, existing.id));
  } else {
    await db.insert(users).values({
      id: userId,
      workosUserId: input.workosUserId,
      email: input.email,
      name: input.name,
      status: "active",
    });
  }

  const membership = (
    await db.select().from(orgMembers).where(eq(orgMembers.userId, userId)).limit(1)
  )[0];
  if (membership) return { userId, orgId: membership.orgId };

  const orgRows = await db.select().from(orgs);
  if (orgRows.length === 0) {
    return bootstrapFirstOrg(db, userId, input.email);
  }
  const autoJoinEnabled = options.autoJoin ?? process.env.FACILITY_AUTO_JOIN === "1";
  const domainMatch = orgRows.filter((org) => orgAllowsEmailDomain(org.settings, input.email));
  const org =
    domainMatch.length === 1
      ? domainMatch[0]
      : autoJoinEnabled && orgRows.length === 1
        ? orgRows[0]
        : null;
  if (!org)
    throw new ApiError(
      403,
      "not_invited",
      "No membership for this user; ask an admin to invite you",
    );
  const viewer = await findRole(db, "viewer", org.id);
  if (!viewer) throw new ApiError(500, "seed_required", "Bundled viewer role is not seeded");
  await db
    .insert(orgMembers)
    .values({ id: newId("user"), orgId: org.id, userId, roleId: viewer.id })
    .onConflictDoNothing();
  return { userId, orgId: org.id };
}

function orgAllowsEmailDomain(settings: unknown, email: string) {
  const domain = email.split("@")[1]?.trim().toLowerCase();
  if (!domain) return false;
  const object =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>)
      : {};
  const auth =
    object.auth && typeof object.auth === "object" && !Array.isArray(object.auth)
      ? (object.auth as Record<string, unknown>)
      : {};
  const values = [
    object.allowedDomain,
    object.allowedDomains,
    object["allowed-domain"],
    object["allowed-domains"],
    object.autoJoinDomain,
    object.autoJoinDomains,
    auth.allowedDomain,
    auth.allowedDomains,
    auth["allowed-domain"],
    auth["allowed-domains"],
  ].flatMap((value) => (Array.isArray(value) ? value : [value]));
  return values.some((value) => typeof value === "string" && value.trim().toLowerCase() === domain);
}

async function bootstrapFirstOrg(
  db: FastifyInstance["facilityDb"],
  userId: string,
  email: string,
): Promise<{ userId: string; orgId: string }> {
  const orgName = bootstrapOrgName(email);
  const slug = await uniqueOrgSlug(db, slugify(orgName));
  const org = (
    await db
      .insert(orgs)
      .values({ id: newId("org"), name: orgName, slug, settings: {} })
      .returning()
  )[0];
  if (!org) throw new ApiError(500, "bootstrap_failed", "Failed to create bootstrap org");
  const owner = await findRole(db, "owner", org.id);
  if (!owner) throw new ApiError(500, "seed_required", "Bundled owner role is not seeded");
  await db
    .insert(orgMembers)
    .values({ id: newId("user"), orgId: org.id, userId, roleId: owner.id })
    .onConflictDoNothing();
  await seedBundledRegistryForOrg(db, org.id);
  return { userId, orgId: org.id };
}

async function findRole(
  db: FastifyInstance["facilityDb"],
  name: "owner" | "viewer",
  orgId: string,
) {
  return (
    await db
      .select()
      .from(rolesTable)
      .where(
        and(eq(rolesTable.name, name), or(isNull(rolesTable.orgId), eq(rolesTable.orgId, orgId))),
      )
      .limit(1)
  )[0];
}

function bootstrapOrgName(email: string) {
  const configured = process.env.FACILITY_BOOTSTRAP_ORG_NAME?.trim();
  if (configured) return configured;
  const domain = email.split("@")[1]?.trim().toLowerCase();
  return domain?.split(".").filter(Boolean)[0] || "facility";
}

async function uniqueOrgSlug(db: FastifyInstance["facilityDb"], base: string) {
  let slug = base || "facility";
  let suffix = 2;
  while ((await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.slug, slug)).limit(1))[0]) {
    slug = `${base}-${suffix}`;
    suffix += 1;
  }
  return slug;
}

function slugify(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "facility"
  );
}
