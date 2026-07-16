import { generateApiKey, newId } from "@facility/core";
import { apiKeys, orgMembers, orgs, roles, users } from "@facility/db";
import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, notFound } from "../../errors.js";
import type { Principal } from "../../types.js";
import {
  AnyObject,
  ApiKeyPublicSchema,
  assertBareRowProjectScope,
  assertPermissionsGrantable,
  assertRoleAssignable,
  CreatedApiKeySchema,
  definedFields,
  IdParams,
  MemberRowSchema,
  MeSchema,
  Ok,
  OrgMemberSchema,
  OrgSchema,
  PageQuery,
  type PageQueryValue,
  principal,
  publicRow,
  RoleSchema,
  assertProjectInOrg as sharedAssertProjectInOrg,
  type V1RouteContext,
} from "./shared.js";

export async function registerMeMembersRolesRoutes(app: FastifyInstance, context: V1RouteContext) {
  const { db } = context;
  const assertProjectInOrg = (
    p: Principal,
    projectId: string | null | undefined,
    statusCode?: number,
  ) => sharedAssertProjectInOrg(db, p, projectId, statusCode);
  app.get(
    "/v1/me",
    {
      config: { permission: "org:read" },
      schema: {
        response: {
          200: MeSchema,
        },
      },
    },
    async (request) => {
      const p = principal(request);
      const org = (await db.select().from(orgs).where(eq(orgs.id, p.orgId)).limit(1))[0];
      return { principal: p, org: org ?? null, permissions: p.permissions };
    },
  );

  app.get(
    "/v1/org",
    {
      config: { permission: "org:read", orgAdmin: true },
      schema: { response: { 200: OrgSchema } },
    },
    async (request) => {
      const p = principal(request);
      return (await db.select().from(orgs).where(eq(orgs.id, p.orgId)).limit(1))[0] ?? null;
    },
  );

  app.patch(
    "/v1/org",
    {
      config: { permission: "org:write", auditAction: "org.updated", orgAdmin: true },
      schema: {
        body: z.object({ name: z.string().optional(), settings: AnyObject.optional() }),
        response: { 200: OrgSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const body = request.body as { name?: string; settings?: Record<string, unknown> };
      return (
        await db
          .update(orgs)
          .set({ name: body.name, settings: body.settings, updatedAt: new Date() })
          .where(eq(orgs.id, p.orgId))
          .returning()
      )[0];
    },
  );

  app.get(
    "/v1/members",
    {
      config: { permission: "members:read", orgAdmin: true },
      schema: { querystring: PageQuery, response: { 200: z.array(MemberRowSchema) } },
    },
    async (request) => {
      const p = principal(request);
      const query = request.query as PageQueryValue;
      return db
        .select({ member: orgMembers, user: users, role: roles })
        .from(orgMembers)
        .innerJoin(users, eq(orgMembers.userId, users.id))
        .innerJoin(roles, eq(orgMembers.roleId, roles.id))
        .where(eq(orgMembers.orgId, p.orgId))
        .orderBy(asc(users.email), asc(orgMembers.id))
        .limit(query.limit)
        .offset(query.offset);
    },
  );

  app.post(
    "/v1/members",
    {
      config: { permission: "members:write", auditAction: "member.added", orgAdmin: true },
      schema: {
        body: z.object({ email: z.string().email(), roleId: z.string() }),
        response: { 200: OrgMemberSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const body = request.body as { email: string; roleId: string };
      // Cannot add a member into a role more privileged than the caller.
      await assertRoleAssignable(db, p, body.roleId);
      const existing = (
        await db.select().from(users).where(eq(users.email, body.email)).limit(1)
      )[0];
      const user =
        existing ??
        (
          await db
            .insert(users)
            .values({ id: newId("user"), email: body.email, status: "active" })
            .returning()
        )[0];
      if (!user) throw new ApiError(500, "insert_failed", "Could not create user");
      return (
        await db
          .insert(orgMembers)
          .values({ id: newId("member"), orgId: p.orgId, userId: user.id, roleId: body.roleId })
          .onConflictDoUpdate({
            target: [orgMembers.orgId, orgMembers.userId],
            set: { roleId: body.roleId, updatedAt: new Date() },
          })
          .returning()
      )[0];
    },
  );

  app.patch(
    "/v1/members/:userId",
    {
      config: { permission: "members:write", auditAction: "member.updated", orgAdmin: true },
      schema: {
        params: IdParams,
        body: z.object({ roleId: z.string() }),
        response: { 200: OrgMemberSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { userId } = request.params as { userId: string };
      const { roleId } = request.body as { roleId: string };
      // Cannot re-assign a member (incl. self) into a role you cannot grant.
      await assertRoleAssignable(db, p, roleId);
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`facility:last-owner:${p.orgId}`}, 0))`,
        );
        const current = (
          await tx
            .select({ member: orgMembers, roleName: roles.name })
            .from(orgMembers)
            .innerJoin(roles, eq(orgMembers.roleId, roles.id))
            .where(and(eq(orgMembers.orgId, p.orgId), eq(orgMembers.userId, userId)))
            .limit(1)
        )[0];
        if (!current) throw notFound("Member not found");
        const nextRole = (
          await tx
            .select({ name: roles.name })
            .from(roles)
            .where(and(eq(roles.id, roleId), or(isNull(roles.orgId), eq(roles.orgId, p.orgId))))
            .limit(1)
        )[0];
        if (!nextRole) throw notFound("Role not found");
        if (current.roleName === "owner" && nextRole.name !== "owner") {
          await assertAnotherOwner(tx, p.orgId, userId);
        }
        const row = (
          await tx
            .update(orgMembers)
            .set({ roleId, updatedAt: new Date() })
            .where(and(eq(orgMembers.orgId, p.orgId), eq(orgMembers.userId, userId)))
            .returning()
        )[0];
        if (!row) throw notFound("Member not found");
        return row;
      });
    },
  );

  app.delete(
    "/v1/members/:userId",
    {
      config: { permission: "members:write", auditAction: "member.removed", orgAdmin: true },
      schema: { params: IdParams, response: { 200: Ok } },
    },
    async (request) => {
      const p = principal(request);
      const { userId } = request.params as { userId: string };
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`facility:last-owner:${p.orgId}`}, 0))`,
        );
        const current = (
          await tx
            .select({ roleName: roles.name })
            .from(orgMembers)
            .innerJoin(roles, eq(orgMembers.roleId, roles.id))
            .where(and(eq(orgMembers.orgId, p.orgId), eq(orgMembers.userId, userId)))
            .limit(1)
        )[0];
        if (!current) throw notFound("Member not found");
        if (current.roleName === "owner") await assertAnotherOwner(tx, p.orgId, userId);
        await tx
          .delete(orgMembers)
          .where(and(eq(orgMembers.orgId, p.orgId), eq(orgMembers.userId, userId)));
        return { ok: true };
      });
    },
  );

  app.get(
    "/v1/roles",
    {
      config: { permission: "roles:read", orgAdmin: true },
      schema: { querystring: PageQuery, response: { 200: z.array(RoleSchema) } },
    },
    async (request) => {
      const p = principal(request);
      const query = request.query as PageQueryValue;
      return db
        .select()
        .from(roles)
        .where(or(isNull(roles.orgId), eq(roles.orgId, p.orgId)))
        .orderBy(asc(roles.name), asc(roles.id))
        .limit(query.limit)
        .offset(query.offset);
    },
  );

  app.post(
    "/v1/roles",
    {
      config: { permission: "roles:write", auditAction: "role.created", orgAdmin: true },
      schema: {
        body: z.object({
          name: z.string(),
          description: z.string().optional(),
          permissions: z.array(z.string()),
        }),
        response: { 200: RoleSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const body = request.body as { name: string; description?: string; permissions: string[] };
      assertPermissionsGrantable(p, body.permissions);
      return (
        await db
          .insert(roles)
          .values({
            id: newId("role"),
            orgId: p.orgId,
            name: body.name,
            description: body.description,
            permissions: body.permissions,
          })
          .returning()
      )[0];
    },
  );

  app.patch(
    "/v1/roles/:roleId",
    {
      config: { permission: "roles:write", auditAction: "role.updated", orgAdmin: true },
      schema: {
        params: IdParams,
        body: z.object({
          description: z.string().optional(),
          permissions: z.array(z.string()).optional(),
        }),
        response: { 200: RoleSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { roleId } = request.params as { roleId: string };
      const body = request.body as { description?: string; permissions?: string[] };
      const role = (
        await db
          .select()
          .from(roles)
          .where(and(eq(roles.id, roleId), or(eq(roles.orgId, p.orgId), isNull(roles.orgId))))
          .limit(1)
      )[0];
      if (!role) throw notFound("Role not found");
      if (!role.orgId) throw new ApiError(400, "bundled_immutable", "Bundled roles are immutable");
      if (body.permissions) assertPermissionsGrantable(p, body.permissions);
      return (
        await db
          .update(roles)
          .set(
            definedFields({
              description: body.description,
              permissions: body.permissions,
              updatedAt: new Date(),
            }),
          )
          .where(and(eq(roles.id, roleId), eq(roles.orgId, p.orgId)))
          .returning()
      )[0];
    },
  );

  app.delete(
    "/v1/roles/:roleId",
    {
      config: { permission: "roles:write", auditAction: "role.deleted", orgAdmin: true },
      schema: { params: IdParams, response: { 200: Ok } },
    },
    async (request) => {
      const p = principal(request);
      const { roleId } = request.params as { roleId: string };
      const role = (
        await db
          .select()
          .from(roles)
          .where(and(eq(roles.id, roleId), or(eq(roles.orgId, p.orgId), isNull(roles.orgId))))
          .limit(1)
      )[0];
      if (role && !role.orgId)
        throw new ApiError(400, "bundled_immutable", "Bundled roles are immutable");
      await db.delete(roles).where(and(eq(roles.id, roleId), eq(roles.orgId, p.orgId)));
      return { ok: true };
    },
  );

  app.get(
    "/v1/keys",
    {
      config: { permission: "keys:issue" },
      schema: { querystring: PageQuery, response: { 200: z.array(ApiKeyPublicSchema) } },
    },
    async (request) => {
      const p = principal(request);
      const query = request.query as PageQueryValue;
      const clauses = [eq(apiKeys.orgId, p.orgId)];
      if (p.projectId) clauses.push(eq(apiKeys.projectId, p.projectId));
      return (
        await db
          .select()
          .from(apiKeys)
          .where(and(...clauses))
          .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id))
          .limit(query.limit)
          .offset(query.offset)
      ).map(publicRow);
    },
  );

  app.post(
    "/v1/keys",
    {
      config: { permission: "keys:issue" },
      schema: {
        body: z.object({ name: z.string(), roleId: z.string(), projectId: z.string().optional() }),
        response: { 200: CreatedApiKeySchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const body = request.body as { name: string; roleId: string; projectId?: string };
      await assertRoleAssignable(db, p, body.roleId);
      await assertProjectInOrg(p, body.projectId);
      const projectId = p.projectId ?? body.projectId;
      const key = await generateApiKey("fak");
      const row = (
        await db
          .insert(apiKeys)
          .values({
            id: key.id,
            orgId: p.orgId,
            name: body.name,
            prefix: key.lookup,
            last4: key.last4,
            hash: key.hash,
            scopeType: projectId ? "project" : "org",
            projectId,
            roleId: body.roleId,
            createdBy: p.id,
          })
          .returning()
      )[0];
      await request.audit(
        "key.issued",
        { type: "key", id: key.id },
        { name: body.name, last4: key.last4 },
      );
      return { ...publicRow(row ?? {}), secret: key.secret };
    },
  );

  app.delete(
    "/v1/keys/:keyId",
    {
      config: { permission: "keys:issue" },
      schema: { params: IdParams, response: { 200: Ok } },
    },
    async (request) => {
      const p = principal(request);
      const { keyId } = request.params as { keyId: string };
      const key = (
        await db
          .select()
          .from(apiKeys)
          .where(and(eq(apiKeys.orgId, p.orgId), eq(apiKeys.id, keyId)))
          .limit(1)
      )[0];
      if (!key) throw notFound("Key not found");
      assertBareRowProjectScope(p, key.projectId, "Key not found");
      await db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiKeys.orgId, p.orgId), eq(apiKeys.id, keyId)));
      await request.audit("key.revoked", { type: "key", id: keyId });
      return { ok: true };
    },
  );
}

async function assertAnotherOwner(
  db: Parameters<Parameters<FastifyInstance["facilityDb"]["transaction"]>[0]>[0],
  orgId: string,
  excludedUserId: string,
) {
  const other = (
    await db
      .select({ id: orgMembers.id })
      .from(orgMembers)
      .innerJoin(roles, eq(orgMembers.roleId, roles.id))
      .where(
        and(
          eq(orgMembers.orgId, orgId),
          sql`${orgMembers.userId} <> ${excludedUserId}`,
          eq(roles.name, "owner"),
        ),
      )
      .limit(1)
  )[0];
  if (!other) {
    throw new ApiError(
      409,
      "last_owner_required",
      "The organization must retain at least one owner",
    );
  }
}
