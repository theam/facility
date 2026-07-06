import { can, PermissionSchema, validateProviderBaseUrl } from "@facility/core";
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
export const JsonValue = z.unknown();
export const DateValue = z.date();
export const Ok = z.object({ ok: z.boolean() });
export const IdParams = z.object({
  projectId: z.string().optional(),
  runId: z.string().optional(),
  itemId: z.string().optional(),
  versionId: z.string().optional(),
  proposalId: z.string().optional(),
  entryId: z.string().optional(),
  taskId: z.string().optional(),
  issueId: z.string().optional(),
  keyId: z.string().optional(),
  userId: z.string().optional(),
  roleId: z.string().optional(),
});

// Route-specific single-param schema so the generated OpenAPI for /v1/issues/:id/*
// lists only issueId, not the whole shared IdParams grab-bag.
export const IssueIdParams = z.object({ issueId: z.string() });

// The run.sandbox jsonb carries sealed run credentials + the runner-token hash.
// Strip them before returning a run to any `runs:read` principal — only the
// sandbox itself ever needs them (via the authenticated /internal bundle route).
const REDACTED_SANDBOX_FIELDS = ["sealedVirtualKey", "sealedPlatformKey", "runnerTokenHash"];
export function redactRunSecrets<T extends { sandbox?: unknown }>(run: T): T {
  const sandbox = run.sandbox;
  if (!sandbox || typeof sandbox !== "object" || Array.isArray(sandbox)) return run;
  const safe: Record<string, unknown> = { ...(sandbox as Record<string, unknown>) };
  for (const field of REDACTED_SANDBOX_FIELDS) delete safe[field];
  return { ...run, sandbox: safe };
}

export const OrgSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  settings: JsonValue,
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
  projectId: z.string().nullable().optional(),
  permissions: z.array(z.string()),
});

export const MeSchema = z.object({
  principal: PrincipalSchema,
  org: OrgSchema.nullable().optional(),
  permissions: z.array(z.string()),
});

export const ProjectSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  systemVersion: z.string(),
  settings: JsonValue,
  status: z.string(),
  createdAt: DateValue,
  updatedAt: DateValue,
});

export const ProjectRepoSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  projectId: z.string(),
  installationId: z.string().nullable(),
  owner: z.string(),
  name: z.string(),
  defaultBranch: z.string(),
  fingerprintStatus: z.string(),
  fingerprint: JsonValue.nullable(),
  fingerprintVerifiedAt: DateValue.nullable(),
  renderAnswers: JsonValue.nullable(),
  createdAt: DateValue,
  updatedAt: DateValue,
});

export const RunSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  projectId: z.string(),
  agentDefId: z.string().nullable(),
  mode: z.string(),
  engine: z.string(),
  status: z.string(),
  trigger: JsonValue,
  sandbox: JsonValue,
  receipt: JsonValue.nullable(),
  gh: JsonValue,
  engineSessionId: z.string().nullable(),
  transcriptUri: z.string().nullable(),
  error: z.string().nullable(),
  queuedAt: DateValue,
  startedAt: DateValue.nullable(),
  endedAt: DateValue.nullable(),
  createdBy: JsonValue,
  createdAt: DateValue,
  updatedAt: DateValue,
});

export const RunWithProjectSchema = RunSchema.extend({
  project: z.object({ id: z.string(), name: z.string(), slug: z.string() }),
});

export const RunEventSchema = z.object({
  orgId: z.string(),
  runId: z.string(),
  seq: z.number(),
  ts: DateValue,
  type: z.string(),
  data: JsonValue,
});

export const ProposalSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  projectId: z.string().nullable(),
  runId: z.string().nullable(),
  actionTypeId: z.string(),
  payload: JsonValue,
  contextMd: z.string(),
  state: z.string(),
  decidedBy: z.string().nullable(),
  decidedAt: DateValue.nullable(),
  expiresAt: DateValue,
  createdAt: DateValue,
  updatedAt: DateValue,
});

export const ProposalEventSchema = z.object({
  orgId: z.string(),
  proposalId: z.string(),
  seq: z.number(),
  ts: DateValue,
  type: z.string(),
  actor: JsonValue,
  data: JsonValue,
});

export const BudgetSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  scope: z.string(),
  projectId: z.string().nullable(),
  agentDefId: z.string().nullable(),
  period: z.string(),
  limitCents: z.number(),
  mode: z.string(),
  enabled: z.boolean(),
  createdAt: DateValue,
  updatedAt: DateValue,
});

export const RegistryItemSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  scope: z.string(),
  projectId: z.string().nullable(),
  kind: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  latestVersion: z.number(),
  createdAt: DateValue,
  updatedAt: DateValue,
});

export const RegistryVersionSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  itemId: z.string(),
  version: z.number(),
  content: z.string(),
  contentHash: z.string(),
  changelog: z.string().nullable(),
  status: z.string(),
  createdBy: z.string().nullable(),
  createdAt: DateValue,
  updatedAt: DateValue,
});

export const RegistryItemWithVersionsSchema = RegistryItemSchema.extend({
  versions: z.array(RegistryVersionSchema),
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
    workosUserId: z.string().nullable(),
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
  secret: z.string().optional(),
});

export const ProviderPublicSchema = z.object({
  id: z.string(),
  provider: z.string(),
  name: z.string(),
  baseUrl: z.string().nullable(),
  createdAt: DateValue,
});

export const AuditEventSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  projectId: z.string().nullable().optional(),
  seq: z.number(),
  actor: JsonValue,
  action: z.string(),
  target: JsonValue,
  payload: JsonValue,
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  prevHash: z.string().nullable(),
  hash: z.string(),
  createdAt: DateValue,
});

export const LlmRequestSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  projectId: z.string(),
  runId: z.string().nullable(),
  taskId: z.string().nullable(),
  agentDefId: z.string().nullable(),
  virtualKeyId: z.string().nullable(),
  provider: z.string(),
  model: z.string(),
  status: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  costCents: z.number().nullable(),
  priced: z.boolean(),
  latencyMs: z.number(),
  requestUri: z.string().nullable(),
  responseUri: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: DateValue,
});

export const SpendRowSchema = z.object({
  bucket: z.string(),
  cost_cents: z.number(),
});

export function principal(request: { principal?: Principal }) {
  if (!request.principal) throw new ApiError(401, "unauthorized", "Authentication required");
  return request.principal;
}

export function publicRow<T extends Record<string, unknown>>(row: T) {
  const { hash: _hash, sealedSecret: _sealedSecret, sealed_secret: _sealedSecret2, ...rest } = row;
  return rest;
}

export async function validateApiProviderBaseUrl(value: string, allowLocalhostHttp: boolean) {
  try {
    return await validateProviderBaseUrl(value, { allowLocalhostHttp });
  } catch (error) {
    throw new ApiError(
      400,
      "invalid_provider_base_url",
      error instanceof Error ? error.message : "Invalid provider base URL",
    );
  }
}

export function assertProjectScope(p: Principal, projectId: string | null | undefined) {
  if (projectId && p.projectId && p.projectId !== projectId) {
    throw new ApiError(404, "not_found", "Project not found");
  }
}

export async function assertProjectInOrg(
  db: FastifyInstance["facilityDb"],
  p: Principal,
  projectId: string | null | undefined,
  statusCode = 400,
) {
  assertProjectScope(p, projectId);
  if (!projectId) return;
  const project = (
    await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.orgId, p.orgId), eq(projects.id, projectId)))
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
  p: Principal,
  projectId: string | null | undefined,
  message: string,
) {
  if (p.projectId && projectId !== p.projectId) {
    throw notFound(message);
  }
}

export async function assertRoleAssignable(
  dbx: FastifyInstance["facilityDb"],
  p: Principal,
  roleId: string,
) {
  const role = (await dbx.select().from(roles).where(eq(roles.id, roleId)).limit(1))[0];
  if (!role) throw new ApiError(400, "invalid_role", "Role does not exist");
  if (role.orgId && role.orgId !== p.orgId) {
    throw new ApiError(403, "role_not_in_org", "Role is not in this organization");
  }
  for (const permission of role.permissions) {
    if (!can(p.permissions, permission)) {
      throw new ApiError(
        403,
        "privilege_escalation",
        "Cannot issue a key more privileged than yourself",
      );
    }
  }
  return role;
}

// A principal may never grant a permission it does not itself hold, nor an
// unknown permission string. This is the same "no privilege escalation" rule
// assertRoleAssignable enforces for roles, applied to raw permission arrays.
export function assertPermissionsGrantable(p: Principal, permissions: string[]) {
  for (const permission of permissions) {
    if (!PermissionSchema.safeParse(permission).success) {
      throw new ApiError(400, "invalid_permission", `Unknown permission: ${permission}`);
    }
    if (!can(p.permissions, permission)) {
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

export function bearer(value: string | undefined) {
  if (!value?.startsWith("Bearer ")) return null;
  return value.slice("Bearer ".length);
}

export function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
