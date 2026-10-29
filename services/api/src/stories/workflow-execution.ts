import { type AgentManifest, AgentManifestSchema } from "@facility/agents";
import {
  agentManifests,
  type FacilityDb,
  projectRepositories,
  storyEvidenceEvents,
  storyPlanDecisions,
  storyPlanRevisions,
  storyPlanStates,
  turns,
} from "@facility/db";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { authorizePrincipal } from "../auth/workspace-execution.js";
import { ApiError } from "../errors.js";
import { appendStoryEvidence } from "./evidence.js";
import { planState } from "./plan-state.js";
import {
  type WorkflowScope,
  workflowDigest,
  workflowPolicyFromSettings,
  workflowProject,
} from "./workflow-policy.js";

export class WorkflowGateError extends ApiError {
  constructor(code: string, message: string) {
    super(409, code, message);
  }
}
const where = (scope: WorkflowScope) =>
  and(
    eq(storyPlanStates.orgId, scope.orgId),
    eq(storyPlanStates.projectId, scope.projectId),
    eq(storyPlanStates.storyId, scope.storyId),
  );
export async function readWorkflowPlan(db: FacilityDb, scope: WorkflowScope) {
  const [row] = await db.select().from(storyPlanStates).where(where(scope)).limit(1);
  const [plan] = row
    ? await db
        .select()
        .from(storyPlanRevisions)
        .where(
          and(
            eq(storyPlanRevisions.orgId, scope.orgId),
            eq(storyPlanRevisions.projectId, scope.projectId),
            eq(storyPlanRevisions.storyId, scope.storyId),
            eq(storyPlanRevisions.revision, row.revision),
          ),
        )
        .limit(1)
    : [];
  const [decision] = row
    ? await db
        .select()
        .from(storyPlanDecisions)
        .where(
          and(
            eq(storyPlanDecisions.orgId, scope.orgId),
            eq(storyPlanDecisions.projectId, scope.projectId),
            eq(storyPlanDecisions.storyId, scope.storyId),
            eq(storyPlanDecisions.decisionRevision, row.decisionRevision),
          ),
        )
        .limit(1)
    : [];
  return { state: planState(row, decision), plan, decision };
}
const Authorization = z
  .object({
    schemaVersion: z.literal(1),
    policyRevision: z.number().int(),
    planRevision: z.number().int(),
    planDigest: z.string(),
    decisionRevision: z.number().int(),
    decisionId: z.string(),
    authorizerId: z.string(),
    agentName: z.string(),
    manifestHash: z.string(),
    repositoryIds: z.array(z.string()),
  })
  .strict();
export type PlanExecutionAuthorization = z.infer<typeof Authorization>;
const ExecutionActor = z.object({
  type: z.enum(["user", "service", "system"]),
  id: z.string().min(1).max(200),
});

/** Called under the shared project/story lock, before compute or provider admission. */
export async function authorizePlanExecution(
  db: FacilityDb,
  scope: WorkflowScope,
  agent: AgentManifest,
  actor: unknown,
  turnId?: string,
): Promise<PlanExecutionAuthorization | null> {
  const project = await workflowProject(db, scope);
  const state = workflowPolicyFromSettings(project.settings);
  let failure: typeof turns.$inferSelect | undefined;
  if (state.policy.holdAfterFailure) {
    [failure] = await db
      .select()
      .from(turns)
      .where(
        and(
          eq(turns.orgId, scope.orgId),
          eq(turns.projectId, scope.projectId),
          eq(turns.storyId, scope.storyId),
          inArray(turns.state, ["succeeded", "failed", "canceled"]),
          ...(turnId ? [ne(turns.id, turnId)] : []),
        ),
      )
      .orderBy(desc(turns.endedAt), desc(turns.createdAt))
      .limit(1);
    if (failure?.state === "succeeded") failure = undefined;
  }
  if (!state.policy.planApprovalAgents.includes(agent.name) && !failure) return null;
  if (project.status !== "active")
    throw new WorkflowGateError(
      "workflow_project_inactive",
      "Restore the project before releasing approved work",
    );
  const [configured] = await db
    .select()
    .from(agentManifests)
    .where(
      and(
        eq(agentManifests.orgId, scope.orgId),
        eq(agentManifests.projectId, scope.projectId),
        eq(agentManifests.name, agent.name),
      ),
    )
    .for("share")
    .limit(1);
  const currentAgent = AgentManifestSchema.safeParse(configured?.manifest);
  if (!currentAgent.success || !currentAgent.data.enabled || currentAgent.data.hash !== agent.hash)
    throw new WorkflowGateError(
      "workflow_agent_configuration_changed",
      "Reload the current enabled agent configuration and review its plan",
    );
  const parsedActor = ExecutionActor.safeParse(actor);
  if (!parsedActor.success)
    throw new WorkflowGateError(
      "workflow_execution_actor_invalid",
      "A current project principal must authorize this work",
    );
  const requester = parsedActor.data;
  const context = await readWorkflowPlan(db, scope);
  if (
    context.state.status !== "approved" ||
    !context.plan ||
    !context.decision ||
    context.decision.planDigest !== context.plan.digest
  )
    throw new WorkflowGateError(
      "workflow_plan_approval_required",
      "Review and approve the current plan before this agent starts",
    );
  const selected = context.plan.agents.find((candidate) => candidate.name === agent.name);
  if (
    !selected ||
    selected.manifestHash !== agent.hash ||
    selected.engine !== agent.engine ||
    selected.model !== agent.model
  )
    throw new WorkflowGateError(
      "workflow_plan_agent_changed",
      "Review a plan containing this exact configured agent version",
    );
  const repositories = await db
    .select()
    .from(projectRepositories)
    .where(
      and(
        eq(projectRepositories.orgId, scope.orgId),
        eq(projectRepositories.projectId, scope.projectId),
      ),
    )
    .orderBy(projectRepositories.id)
    .for("share");
  const primary = repositories.find((repository) => repository.role === "primary");
  if (
    !primary ||
    selected.repositoryId !== primary.id ||
    repositories.length !== context.plan.repositories.length ||
    repositories.some(
      (repository) =>
        !context.plan?.repositories.some(
          (approved) =>
            approved.repositoryId === repository.id &&
            approved.repository.toLowerCase() ===
              `${repository.owner}/${repository.name}`.toLowerCase(),
        ),
    )
  )
    throw new WorkflowGateError(
      "workflow_plan_repository_scope_changed",
      "Approve the full current project repository scope before granting native project execution",
    );
  if (failure && (!failure.endedAt || context.decision.confirmedAt <= failure.endedAt))
    throw new WorkflowGateError(
      "workflow_previous_turn_failed",
      "Review the failed or canceled work and confirm a new plan decision before releasing queued agents",
    );
  try {
    await authorizePrincipal(
      db,
      scope,
      { type: "user", id: context.decision.confirmedBy.id },
      ["projects:write", "workspaces:execute"],
      "workflow_plan_authorizer_revoked",
    );
    if (requester.type === "user")
      await authorizePrincipal(db, scope, { type: "user", id: requester.id }, [
        "workspaces:execute",
      ]);
    else if (requester.type === "service" && !requester.id.startsWith("github:"))
      await authorizePrincipal(db, scope, { type: "key", id: requester.id }, [
        "workspaces:execute",
      ]);
    // GitHub/scheduler actors are constructed by trusted trigger handlers. Their
    // queued execution still requires the current human plan authorizer above.
  } catch (error) {
    if (error instanceof ApiError)
      throw new WorkflowGateError(
        error.code,
        "A current execution-authorized project member must approve and delegate this work",
      );
    throw error;
  }
  return {
    schemaVersion: 1,
    policyRevision: state.revision,
    planRevision: context.plan.revision,
    planDigest: context.plan.digest,
    decisionRevision: context.decision.decisionRevision,
    decisionId: context.decision.id,
    authorizerId: context.decision.confirmedBy.id,
    agentName: agent.name,
    manifestHash: agent.hash,
    repositoryIds: repositories.map((repository) => repository.id),
  };
}
export async function recordPlanExecution(
  db: FacilityDb,
  scope: WorkflowScope,
  turnId: string,
  authorization: PlanExecutionAuthorization | null,
) {
  if (authorization)
    await appendStoryEvidence(db, {
      ...scope,
      turnId,
      source: "facility",
      type: "workflow.execution_authorized",
      externalKey: `workflow:execution:${turnId}`,
      data: authorization,
    });
}
export async function planExecutionStillAuthorized(
  db: FacilityDb,
  scope: WorkflowScope,
  turn: typeof turns.$inferSelect,
) {
  const [receipt] = await db
    .select()
    .from(storyEvidenceEvents)
    .where(
      and(
        eq(storyEvidenceEvents.orgId, scope.orgId),
        eq(storyEvidenceEvents.projectId, scope.projectId),
        eq(storyEvidenceEvents.storyId, scope.storyId),
        eq(storyEvidenceEvents.externalKey, `workflow:execution:${turn.id}`),
      ),
    )
    .limit(1);
  try {
    const expected = receipt ? Authorization.parse(receipt.data) : null;
    const actual = await authorizePlanExecution(
      db,
      scope,
      AgentManifestSchema.parse(turn.manifest),
      turn.createdBy,
      turn.id,
    );
    return workflowDigest(expected) === workflowDigest(actual);
  } catch (error) {
    if (
      error instanceof WorkflowGateError ||
      error instanceof z.ZodError ||
      error instanceof ApiError
    )
      return false;
    throw error;
  }
}
