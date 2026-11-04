import { createHash, randomUUID } from "node:crypto";
import {
  newId,
  type StoryWorkflowPolicy,
  StoryWorkflowPolicySchema,
  type StoryWorkflowPolicyState,
  StoryWorkflowPolicyStateSchema,
} from "@facility/core";
import { auditEvents, type FacilityDb, projectRepositories, projects, turns } from "@facility/db";
import { and, eq, sql } from "drizzle-orm";
import type { AgentCatalogService } from "../agents/catalog.js";
import { authorizePrincipal } from "../auth/workspace-execution.js";
import { ApiError } from "../errors.js";
import type { InteractivePlanActor } from "./plan-confirmation.js";
import {
  verifyWorkflowConfirmationProof,
  WORKFLOW_CONFIRMATION_TTL_MS,
  workflowConfirmationProof,
} from "./workflow-confirmation.js";

export type WorkflowProjectScope = { orgId: string; projectId: string };
export type WorkflowScope = WorkflowProjectScope & { storyId: string };
export const WORKFLOW_POLICY_SETTING = "storyWorkflow";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export function workflowDigest(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
export function workflowPolicyFromSettings(settings: unknown): StoryWorkflowPolicyState {
  const value =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>)[WORKFLOW_POLICY_SETTING]
      : undefined;
  if (value === undefined) return { revision: 0, policy: StoryWorkflowPolicySchema.parse({}) };
  const parsed = StoryWorkflowPolicyStateSchema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      409,
      "workflow_policy_invalid",
      "A project owner must repair the workflow policy before starting work",
    );
  return parsed.data;
}
export async function workflowProject(db: FacilityDb, scope: WorkflowProjectScope) {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.orgId, scope.orgId), eq(projects.id, scope.projectId)))
    .limit(1);
  if (!project) throw new ApiError(404, "not_found", "Project not found");
  return project;
}
export async function readWorkflowPolicy(db: FacilityDb, scope: WorkflowProjectScope) {
  return workflowPolicyFromSettings((await workflowProject(db, scope)).settings);
}
export async function lockWorkflowProject(db: FacilityDb, scope: WorkflowProjectScope) {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`${scope.orgId}:${scope.projectId}`}))`,
  );
}
export async function lockWorkflowStory(db: FacilityDb, scope: WorkflowScope) {
  await lockWorkflowProject(db, scope);
  await lockStory(db, scope);
}
async function lockStory(db: FacilityDb, scope: WorkflowScope) {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`facility:story:${scope.orgId}:${scope.projectId}:${scope.storyId}`}))`,
  );
}
/** Always fence policy changes. Ungated admission preserves the existing
 * reservation/cancellation ordering and must not wait on the story fence. */
export async function lockWorkflowExecution(
  db: FacilityDb,
  scope: WorkflowScope,
  agentName: string,
) {
  await lockWorkflowProject(db, scope);
  const { policy } = await readWorkflowPolicy(db, scope);
  if (policy.planApprovalAgents.includes(agentName) || policy.holdAfterFailure)
    await lockStory(db, scope);
}
export async function authorizeWorkflowHuman(
  db: FacilityDb,
  scope: WorkflowProjectScope,
  actor: InteractivePlanActor,
  configure = false,
) {
  await authorizePrincipal(
    db,
    scope,
    { type: "user", id: actor.id },
    configure ? ["projects:write", "repos:write"] : ["projects:write"],
    "workflow_authority_revoked",
  );
}
export type WorkflowPolicyConfirmation = {
  expected_revision: number;
  policy: StoryWorkflowPolicy;
  nonce: string;
  expires_at: string;
  proof: string;
};
function binding(scope: WorkflowProjectScope, body: Omit<WorkflowPolicyConfirmation, "proof">) {
  return {
    ...scope,
    purpose: "workflow_policy" as const,
    nonce: body.nonce,
    digest: workflowDigest([body.expected_revision, StoryWorkflowPolicySchema.parse(body.policy)]),
    expiresAt: new Date(body.expires_at),
  };
}
export async function checkWorkflowPolicyConfirmation(
  db: FacilityDb,
  scope: WorkflowProjectScope,
  body: WorkflowPolicyConfirmation,
  actor: InteractivePlanActor,
  masterKey: string,
  now = new Date(),
) {
  await authorizeWorkflowHuman(db, scope, actor, true);
  verifyWorkflowConfirmationProof(body.proof, binding(scope, body), actor, masterKey, now);
}
async function configuredAgents(
  catalog: AgentCatalogService,
  scope: WorkflowProjectScope,
  policy: StoryWorkflowPolicy,
) {
  if (!policy.planApprovalAgents.length) return null;
  const snapshot = await catalog.refreshSnapshot(scope.orgId, scope.projectId);
  if (!snapshot.repositoryId)
    throw new ApiError(
      409,
      "workflow_catalog_unverified",
      "Refresh the canonical configured agent catalog",
    );
  for (const name of policy.planApprovalAgents)
    if (!snapshot.manifests.some((agent) => agent.name === name && agent.enabled))
      throw new ApiError(
        409,
        "workflow_agent_unavailable",
        `Choose an enabled configured agent: ${name}`,
      );
  return snapshot.repositoryId;
}
export async function reviewWorkflowPolicy(
  db: FacilityDb,
  catalog: AgentCatalogService,
  scope: WorkflowProjectScope,
  expectedRevision: number,
  policy: StoryWorkflowPolicy,
  actor: InteractivePlanActor,
  masterKey: string,
  now = new Date(),
) {
  await authorizeWorkflowHuman(db, scope, actor, true);
  const state = await readWorkflowPolicy(db, scope);
  if (state.revision !== expectedRevision)
    throw new ApiError(
      409,
      "workflow_policy_changed",
      "Reload the current project workflow policy",
    );
  const parsed = StoryWorkflowPolicySchema.parse(policy);
  await configuredAgents(catalog, scope, parsed);
  const nonce = randomUUID(),
    expiresAt = new Date(now.getTime() + WORKFLOW_CONFIRMATION_TTL_MS);
  const request = {
    expected_revision: expectedRevision,
    policy: parsed,
    nonce,
    expires_at: expiresAt.toISOString(),
  };
  return {
    expectedRevision,
    policy: parsed,
    nonce,
    expiresAt: expiresAt.toISOString(),
    proof: workflowConfirmationProof(binding(scope, request), actor, masterKey),
  };
}
export async function confirmWorkflowPolicy(
  db: FacilityDb,
  catalog: AgentCatalogService,
  scope: WorkflowProjectScope,
  body: WorkflowPolicyConfirmation,
  actor: InteractivePlanActor,
  masterKey: string,
  now = new Date(),
) {
  verifyWorkflowConfirmationProof(body.proof, binding(scope, body), actor, masterKey, now);
  const policy = StoryWorkflowPolicySchema.parse(body.policy);
  const catalogRepositoryId = await configuredAgents(catalog, scope, policy);
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as FacilityDb;
    await lockWorkflowProject(tx, scope);
    await authorizeWorkflowHuman(tx, scope, actor, true);
    const project = await workflowProject(tx, scope);
    if (project.status !== "active")
      throw new ApiError(
        409,
        "workflow_project_inactive",
        "Restore the project before changing its execution policy",
      );
    const state = workflowPolicyFromSettings(project.settings);
    if (state.revision !== body.expected_revision)
      throw new ApiError(
        409,
        "workflow_policy_changed",
        "Reload and confirm the current project workflow policy",
      );
    const [running] = await tx
      .select({ id: turns.id })
      .from(turns)
      .where(
        and(
          eq(turns.orgId, scope.orgId),
          eq(turns.projectId, scope.projectId),
          eq(turns.state, "running"),
        ),
      )
      .limit(1);
    if (running)
      throw new ApiError(
        409,
        "workflow_execution_active",
        "Wait for running work to finish or cancel it before changing the workflow policy",
      );
    if (catalogRepositoryId) {
      const [primary] = await tx
        .select({ id: projectRepositories.id })
        .from(projectRepositories)
        .where(
          and(
            eq(projectRepositories.orgId, scope.orgId),
            eq(projectRepositories.projectId, scope.projectId),
            eq(projectRepositories.role, "primary"),
          ),
        )
        .limit(1);
      if (primary?.id !== catalogRepositoryId)
        throw new ApiError(
          409,
          "workflow_catalog_changed",
          "Review the configured agents after the repository change",
        );
    }
    const saved = { revision: state.revision + 1, policy };
    await tx
      .update(projects)
      .set({
        settings: sql`${projects.settings} || ${JSON.stringify({ [WORKFLOW_POLICY_SETTING]: saved })}::jsonb`,
        updatedAt: now,
      })
      .where(and(eq(projects.orgId, scope.orgId), eq(projects.id, scope.projectId)));
    await tx.insert(auditEvents).values({
      id: newId("evt"),
      ...scope,
      actor: { type: "user", id: actor.id },
      action: "project.workflow_policy.confirmed",
      target: { projectId: scope.projectId },
      payload: { ...saved, method: "interactive_session", confirmedAt: now.toISOString() },
    });
    return saved;
  });
}
