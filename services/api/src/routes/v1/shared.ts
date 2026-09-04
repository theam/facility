import { can, PermissionSchema } from "@facility/core";
import { projects, roles } from "@facility/db";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, notFound } from "../../errors.js";
import type { AppConfig, Principal } from "../../types.js";

export type V1RouteContext = {
  db: FastifyInstance["facilityDb"];
  config: AppConfig;
};

export const AnyObject = z.record(z.string(), z.unknown());
export const DateValue = z.date();
export const Ok = z.object({ ok: z.boolean() });
export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type PageQueryValue = z.infer<typeof PageQuery>;
export const IdParams = z.object({
  projectId: z.string().optional(),
  keyId: z.string().optional(),
  userId: z.string().optional(),
  roleId: z.string().optional(),
});

export const OrgSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  settings: AnyObject,
  createdAt: DateValue,
  updatedAt: DateValue,
});

export const PrincipalSchema = z.object({
  type: z.enum(["user", "key"]),
  id: z.string(),
  orgId: z.string(),
  userId: z.string().optional(),
  email: z.string().optional(),
  name: z.string().optional(),
  githubLogin: z.string().optional(),
  avatarUrl: z.string().optional(),
  projectId: z.string().nullable().optional(),
  permissions: z.array(z.string()),
});

export const MeSchema = z.object({
  principal: PrincipalSchema,
  org: OrgSchema.nullable(),
  permissions: z.array(z.string()),
});

export const RoleSchema = z.object({
  id: z.string(),
  orgId: z.string().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  permissions: z.array(z.string()),
  createdAt: DateValue,
  updatedAt: DateValue,
});

export const OrgMemberSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  userId: z.string(),
  roleId: z.string(),
  createdAt: DateValue,
  updatedAt: DateValue,
});

export const MemberRowSchema = z.object({
  member: OrgMemberSchema,
  user: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    avatarUrl: z.string().nullable(),
    status: z.string(),
    createdAt: DateValue,
    updatedAt: DateValue,
  }),
  role: RoleSchema,
});

export const ApiKeyPublicSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  prefix: z.string(),
  last4: z.string(),
  scopeType: z.string(),
  projectId: z.string().nullable(),
  roleId: z.string(),
  createdBy: z.string().nullable(),
  lastUsedAt: DateValue.nullable(),
  revokedAt: DateValue.nullable(),
  createdAt: DateValue,
  updatedAt: DateValue,
});
export const CreatedApiKeySchema = ApiKeyPublicSchema.extend({ secret: z.string() });

export function principal(request: { principal?: Principal }) {
  if (!request.principal) throw new ApiError(401, "unauthorized", "Authentication required");
  return request.principal;
}

export function publicRow<T extends Record<string, unknown>>(row: T) {
  const { hash: _hash, ...rest } = row;
  return rest;
}

export async function assertProjectInOrg(
  db: FastifyInstance["facilityDb"],
  actor: Principal,
  projectId: string | null | undefined,
  statusCode = 400,
) {
  if (!projectId) return;
  if (actor.projectId && actor.projectId !== projectId) {
    throw notFound("Project not found");
  }
  const project = (
    await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.orgId, actor.orgId), eq(projects.id, projectId)))
      .limit(1)
  )[0];
  if (!project) {
    throw new ApiError(
      statusCode,
      statusCode === 404 ? "not_found" : "project_not_in_org",
      "Project not found",
    );
  }
}

export function assertBareRowProjectScope(
  actor: Principal,
  projectId: string | null | undefined,
  message: string,
) {
  if (actor.projectId && projectId !== actor.projectId) throw notFound(message);
}

export async function assertRoleAssignable(
  db: FastifyInstance["facilityDb"],
  actor: Principal,
  roleId: string,
) {
  const role = (await db.select().from(roles).where(eq(roles.id, roleId)).limit(1))[0];
  if (!role) throw new ApiError(400, "invalid_role", "Role does not exist");
  if (role.orgId && role.orgId !== actor.orgId) {
    throw new ApiError(403, "role_not_in_org", "Role is not in this organization");
  }
  for (const permission of role.permissions) {
    if (!can(actor.permissions, permission)) {
      throw new ApiError(
        403,
        "privilege_escalation",
        "Cannot assign a role more privileged than yourself",
      );
    }
  }
  return role;
}

export function assertPermissionsGrantable(actor: Principal, permissions: string[]) {
  for (const permission of permissions) {
    if (!PermissionSchema.safeParse(permission).success) {
      throw new ApiError(400, "invalid_permission", `Unknown permission: ${permission}`);
    }
    if (!can(actor.permissions, permission)) {
      throw new ApiError(
        403,
        "privilege_escalation",
        `Cannot grant a permission you do not hold: ${permission}`,
      );
    }
  }
}

export function definedFields<T extends Record<string, unknown>>(fields: T) {
  return Object.fromEntries(
    Object.entries(fields).filter((entry): entry is [string, unknown] => entry[1] !== undefined),
  );
}
