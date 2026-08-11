import { can, PermissionSchema, validateProviderBaseUrl } from "@facility/core";
import { projects, roles, runs } from "@facility/db";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { verifyAssistantTurn } from "../../assistant/turn-registry.js";
import { ApiError, notFound } from "../../errors.js";
import type { AppConfig, Principal } from "../../types.js";

export type V1RouteContext = {
  db: FastifyInstance["facilityDb"];
  config: AppConfig;
};

export type ProposalOpener = {
  actor: { type: string; id: string };
  /** Extra provenance for the seq-1 open event (onBehalfOf when agent-opened). */
  data: Record<string, unknown>;
};

/**
 * Who opens a proposal: normally the calling principal — but when the request
 * carries a valid in-process assistant-turn binding (headers set only by the
 * loop, token never leaves this process), the AGENT run is the requester and
 * the human stays a distinct approver by construction. Dual control then
 * means "a human distinct from the proposing agent", which is the intended
 * semantics for single-operator orgs. Fails closed: any mismatch falls back
 * to the calling principal, keeping today's strictness for manual flows.
 */
export async function proposalOpener(
  db: FastifyInstance["facilityDb"],
  request: FastifyRequest,
  p: Principal,
): Promise<ProposalOpener> {
  const human: ProposalOpener = { actor: { type: p.type, id: p.id }, data: {} };
  const runId = singleHeader(request.headers["x-facility-assistant-run"]);
  const token = singleHeader(request.headers["x-facility-assistant-token"]);
  if (!runId || !token || !verifyAssistantTurn(runId, token)) return human;
  const run = (
    await db
      .select({ mode: runs.mode, status: runs.status, createdBy: runs.createdBy })
      .from(runs)
      .where(and(eq(runs.orgId, p.orgId), eq(runs.id, runId)))
      .limit(1)
  )[0];
  const createdBy = (run?.createdBy ?? null) as { type?: string; id?: string } | null;
  if (
    run?.mode !== "assistant" ||
    run.status !== "running" ||
    createdBy?.type !== p.type ||
    createdBy?.id !== p.id
  ) {
    return human;
  }
  return {
    actor: { type: "agent", id: runId },
    data: { onBehalfOf: { type: p.type, id: p.id } },
  };
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export const AnyObject = z.record(z.string(), z.unknown());
export const IsoDateTime = z.string().refine((value) => Number.isFinite(Date.parse(value)), {
  message: "Expected a valid ISO 8601 date or date-time",
});
export const JsonValue = z.unknown();
export const DateValue = z.date();
export const Ok = z.object({ ok: z.boolean() });
export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type PageQueryValue = z.infer<typeof PageQuery>;
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

export const ProjectSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  systemVersion: z.string(),
  settings: AnyObject,
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
  fingerprint: AnyObject.nullable(),
  fingerprintVerifiedAt: DateValue.nullable(),
  renderAnswers: AnyObject.nullable(),
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
  trigger: AnyObject,
  sandbox: AnyObject,
  receipt: z
    .object({
      // Every Facility-finished run has gateway-authoritative usage and event
      // aggregates. Harnesses may add provider-specific receipt fields, so keep
      // the envelope extensible while publishing the stable fields clients can
      // safely rely on.
      usage: z
        .object({
          input_tokens: z.number().int().nonnegative(),
          output_tokens: z.number().int().nonnegative(),
          cache_read: z.number().int().nonnegative().optional(),
          cache_write: z.number().int().nonnegative().optional(),
          cost_cents: z.number().int().nonnegative(),
          cost_source: z.string(),
        })
        .passthrough()
        .optional(),
      events: z
        .object({
          count: z.number().int().nonnegative(),
          checks: z.number().int().nonnegative(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .nullable(),
  gh: AnyObject,
  engineSessionId: z.string().nullable(),
  transcriptUri: z.string().nullable(),
  sessionStateUri: z.string().nullable(),
  error: z.string().nullable(),
  queuedAt: DateValue,
  startedAt: DateValue.nullable(),
  endedAt: DateValue.nullable(),
  createdBy: AnyObject,
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
  data: AnyObject,
});

export const ConversationSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  projectId: z.string(),
  agentDefId: z.string(),
  title: z.string().nullable(),
  lastRunId: z.string().nullable(),
  engineSessionId: z.string().nullable(),
  status: z.string(),
  kind: z.string(),
  createdBy: JsonValue,
  createdAt: DateValue,
  updatedAt: DateValue,
});

export const ConversationMessageSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  conversationId: z.string(),
  seq: z.number(),
  role: z.string(),
  body: z.string(),
  runId: z.string().nullable(),
  createdAt: DateValue,
});

export const ProposalSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  projectId: z.string().nullable(),
  runId: z.string().nullable(),
  actionTypeId: z.string(),
  /** Stable, human-readable action type name resolved from actionTypeId. */
  actionType: z.string(),
  payload: AnyObject,
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
  actor: AnyObject,
  data: AnyObject,
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

export const ProviderPublicSchema = z.object({
  id: z.string(),
  provider: z.string(),
  name: z.string(),
  authMode: z.enum(["api_key", "oauth"]),
  baseUrl: z.string().nullable(),
  createdAt: DateValue,
});

export const AuditEventSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  projectId: z.string().nullable().optional(),
  seq: z.number(),
  actor: z.object({
    type: z.enum(["user", "key", "agent", "system"]),
    id: z.string().optional(),
    name: z.string().optional(),
  }),
  action: z.string(),
  target: z.object({ type: z.string(), id: z.string().optional() }),
  payload: AnyObject,
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  prevHash: z.string().nullable(),
  hash: z.string(),
  createdAt: DateValue,
});

export const OutcomeSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  runId: z.string().nullable(),
  projectId: z.string(),
  repo: z.string(),
  prNumber: z.number().int(),
  agentLane: z.string(),
  openedAt: DateValue,
  terminalAt: DateValue.nullable(),
  fate: z.string().nullable(),
  reviewRounds: z.number().int(),
  fixupCommits: z.number().int(),
  hoursToTerminal: z.number().nullable(),
  createdAt: DateValue,
  updatedAt: DateValue,
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

export const AgentDefSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  projectId: z.string(),
  name: z.string(),
  engine: z.string(),
  model: AnyObject,
  contractItemId: z.string(),
  harnessItemId: z.string().nullable(),
  triggers: z.array(AnyObject),
  sandboxProfileId: z.string().nullable(),
  permissions: z.array(z.string()),
  enabled: z.boolean(),
  createdAt: DateValue,
  updatedAt: DateValue,
});

export const SandboxProfileSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  projectId: z.string().nullable(),
  name: z.string(),
  driver: z.string(),
  image: z.string(),
  setup: AnyObject,
  resources: AnyObject,
  network: AnyObject,
  createdAt: DateValue,
  updatedAt: DateValue,
});

export const VirtualKeyPublicSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  projectId: z.string(),
  runId: z.string().nullable(),
  name: z.string(),
  prefix: z.string(),
  last4: z.string(),
  allowedModels: z.array(z.string()).nullable(),
  budgetId: z.string().nullable(),
  revokedAt: DateValue.nullable(),
  expiresAt: DateValue.nullable(),
  createdAt: DateValue,
  updatedAt: DateValue,
});
export const CreatedVirtualKeySchema = VirtualKeyPublicSchema.extend({ secret: z.string() });

export const KbSpaceSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  projectId: z.string(),
  charterMd: z.string(),
  activeMd: z.string(),
  config: AnyObject,
  charterUpdatedAt: DateValue.nullable(),
  activeUpdatedAt: DateValue.nullable(),
  createdAt: DateValue,
  updatedAt: DateValue,
});

export const KbSpaceDocVersionSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  spaceId: z.string(),
  doc: z.string(),
  version: z.number().int(),
  bodyMd: z.string(),
  savedBy: JsonValue.nullable(),
  createdAt: DateValue,
});

export const KbEntrySchema = z.object({
  id: z.string(),
  orgId: z.string(),
  spaceId: z.string(),
  type: z.string(),
  number: z.number().int(),
  slug: z.string(),
  frontmatter: AnyObject,
  bodyMd: z.string(),
  status: z.string().nullable(),
  supersedes: z.string().nullable(),
  createdAt: DateValue,
  updatedAt: DateValue,
});

export const KbEntryVersionSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  entryId: z.string(),
  version: z.number().int(),
  slug: z.string(),
  frontmatter: AnyObject,
  bodyMd: z.string(),
  status: z.string().nullable(),
  savedBy: JsonValue.nullable(),
  createdAt: DateValue,
});

export const KbEntryDraftSchema = z.object({
  id: z.literal("__draft__"),
  type: z.string(),
  number: z.number().int(),
  slug: z.string(),
  frontmatter: AnyObject,
  bodyMd: z.string(),
  status: z.string().optional(),
  supersedes: z.null(),
});

export const KbDecisionSchema = KbEntrySchema.extend({
  artifactId: z.string(),
  /** Artifact id of the decision that superseded this one, when retired. */
  supersededBy: z.string().nullable(),
  /** Still governing: not superseded and not marked superseded itself. */
  active: z.boolean(),
});

export const KbNeighborSchema = z.object({
  id: z.string(),
  artifactId: z.string(),
  type: z.string(),
  number: z.number().int(),
  slug: z.string(),
  status: z.string().nullable(),
  relation: z.enum(["supersedes", "superseded-by", "linked"]),
});

export const TaskSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  projectId: z.string(),
  kbEntryId: z.string().nullable(),
  title: z.string(),
  bodyMd: z.string(),
  wsjf: AnyObject,
  gh: AnyObject.nullable(),
  status: z.string(),
  createdAt: DateValue,
  updatedAt: DateValue,
});

export const SteerMessageSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  runId: z.string(),
  authorUserId: z.string().nullable(),
  body: z.string(),
  deliveredAt: DateValue.nullable(),
  createdAt: DateValue,
  updatedAt: DateValue,
});

export const WebhookDeliverySchema = z.object({
  id: z.string(),
  orgId: z.string(),
  integrationId: z.string(),
  eventType: z.string(),
  dedupeKey: z.string(),
  payload: AnyObject,
  status: z.string(),
  attempts: z.number().int(),
  nextAttemptAt: DateValue,
  responseStatus: z.number().int().nullable(),
  error: z.string().nullable(),
  deliveredAt: DateValue.nullable(),
  createdAt: DateValue,
  updatedAt: DateValue,
});

export const PlatformIssueSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  projectId: z.string().nullable(),
  kind: z.string(),
  severity: z.string(),
  fingerprint: z.string(),
  title: z.string(),
  bodyMd: z.string(),
  state: z.string(),
  firstSeen: DateValue,
  lastSeen: DateValue,
  count: z.number().int(),
  createdAt: DateValue,
  updatedAt: DateValue,
});

export const ValidationIssueSchema = z.object({
  code: z.string(),
  message: z.string(),
  entryId: z.string().optional(),
});

export const ValidationReportSchema = z.object({
  ok: z.boolean(),
  errors: z.array(ValidationIssueSchema),
  warnings: z.array(ValidationIssueSchema),
});

export const AnalyticsRowSchema = z.object({
  bucket: z.string(),
  runsStarted: z.number(),
  runsSucceeded: z.number(),
  runsFailed: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costCents: z.number(),
  outcomesTotal: z.number(),
  outcomesAssessed: z.number(),
  outcomesAccepted: z.number(),
  outcomesMerged: z.number(),
  outcomesOneShot: z.number(),
  acceptance: z.number().nullable(),
  oneShot: z.number().nullable(),
});

export const AnalyticsOverviewSchema = z.object({
  liveAgents: z.number(),
  spendMtdCents: z.number(),
  outcomes30d: z.object({
    total: z.number(),
    assessed: z.number(),
    accepted: z.number(),
    merged: z.number(),
    oneShot: z.number(),
  }),
  acceptance30d: z.number().nullable(),
  oneShot30d: z.number().nullable(),
  projects: z.array(
    z.object({
      projectId: z.string(),
      projectName: z.string(),
      spendCents: z.number(),
      runsStarted: z.number(),
      outcomesTotal: z.number(),
      outcomesAssessed: z.number(),
      outcomesAccepted: z.number(),
      outcomesMerged: z.number(),
      outcomesOneShot: z.number(),
    }),
  ),
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
