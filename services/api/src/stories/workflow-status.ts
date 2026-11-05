import { AgentManifestSchema } from "@facility/agents";
import type { StoryWorkflowStatus } from "@facility/core";
import { agentManifests, type FacilityDb, projectRepositories, turns } from "@facility/db";
import { and, asc, eq, inArray, like } from "drizzle-orm";
import { ApiError } from "../errors.js";
import { readDeliveryAcceptance } from "./delivery-acceptance.js";
import {
  matchesPlanAgent,
  matchesPlanRepositoryScope,
  repositoryScopeDifference,
} from "./plan-scope.js";
import { authorizePlanExecution, readWorkflowPlan } from "./workflow-execution.js";
import {
  readWorkflowPolicy,
  type WorkflowProjectScope,
  type WorkflowScope,
} from "./workflow-policy.js";

export async function readStoryWorkflow(
  db: FacilityDb,
  scope: WorkflowScope,
): Promise<StoryWorkflowStatus> {
  return db.transaction(
    async (rawTx) => {
      const tx = rawTx as unknown as FacilityDb;
      const policy = await readWorkflowPolicy(tx, scope);
      const plan = await readWorkflowPlan(tx, scope);
      const acceptance = await readDeliveryAcceptance(tx, scope);
      const queuePage = await tx
        .select()
        .from(turns)
        .where(
          and(
            eq(turns.orgId, scope.orgId),
            eq(turns.projectId, scope.projectId),
            eq(turns.storyId, scope.storyId),
            eq(turns.state, "queued"),
          ),
        )
        .orderBy(asc(turns.createdAt), asc(turns.id))
        .limit(51);
      const queued = queuePage.slice(0, 50);
      const repositories = await tx
        .select()
        .from(projectRepositories)
        .where(
          and(
            eq(projectRepositories.orgId, scope.orgId),
            eq(projectRepositories.projectId, scope.projectId),
          ),
        )
        .orderBy(asc(projectRepositories.id));
      const primary = repositories.find((repository) => repository.role === "primary");
      const configured = queued.length
        ? await tx
            .select()
            .from(agentManifests)
            .where(
              and(
                eq(agentManifests.orgId, scope.orgId),
                eq(agentManifests.projectId, scope.projectId),
                inArray(agentManifests.name, [...new Set(queued.map((turn) => turn.agentName))]),
              ),
            )
        : [];
      let blockedReason: string | null = null;
      for (const turn of queued) {
        const retained = AgentManifestSchema.safeParse(turn.manifest);
        if (!retained.success) {
          blockedReason =
            "The retained agent configuration is unavailable. Inspect the queued turn before continuing.";
          break;
        }
        try {
          await authorizePlanExecution(tx, scope, retained.data, turn.createdBy, turn.id);
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          blockedReason = error.message;
          break;
        }
      }
      return {
        schemaVersion: 1,
        ...scope,
        policy,
        plan: plan.state,
        queuedAgents: queued.map((turn) => turn.agentName),
        blockedReason,
        acceptance,
        executionScope: {
          observedAt: new Date().toISOString(),
          planRevision: plan.state.revision,
          repositories: {
            matches:
              !!plan.plan &&
              matchesPlanRepositoryScope(plan.plan.repositories, repositories, primary?.id),
            connectedCount: repositories.length,
            ...repositoryScopeDifference(plan.plan?.repositories ?? [], repositories),
          },
          queuedWork: queued.map((turn) => {
            const current = AgentManifestSchema.safeParse(
              configured.find((row) => row.name === turn.agentName)?.manifest,
            );
            const retained = AgentManifestSchema.safeParse(turn.manifest);
            const selected = plan.plan?.agents.find((agent) => agent.name === turn.agentName);
            return {
              turnId: turn.id,
              agentName: turn.agentName,
              engine: turn.engine,
              model: turn.model,
              manifestHash: turn.manifestHash,
              createdAt: turn.createdAt.toISOString(),
              configuration:
                !retained.success || !current.success || !current.data.enabled
                  ? ("unavailable" as const)
                  : current.data.hash === retained.data.hash
                    ? ("current" as const)
                    : ("changed" as const),
              planAgent: !selected
                ? ("missing" as const)
                : retained.success &&
                    matchesPlanAgent(selected, retained.data) &&
                    primary?.id === selected.repositoryId
                  ? ("current" as const)
                  : ("changed" as const),
            };
          }),
          hasMore: queuePage.length > queued.length,
        },
      };
    },
    { isolationLevel: "repeatable read" },
  );
}

/** The durable worker sweep remains the fallback if publication is unavailable. */
export async function releaseWorkflowQueue(
  db: FacilityDb,
  scope: WorkflowProjectScope & { storyId?: string },
  enqueue: (queue: string, data: Record<string, unknown>) => Promise<unknown>,
) {
  try {
    const queued = await db
      .update(turns)
      .set({ retryAfter: null, updatedAt: new Date() })
      .where(
        and(
          eq(turns.orgId, scope.orgId),
          eq(turns.projectId, scope.projectId),
          eq(turns.state, "queued"),
          ...(scope.storyId ? [eq(turns.storyId, scope.storyId)] : []),
          like(turns.error, "workflow_%"),
        ),
      )
      .returning({ turnId: turns.id });
    for (const turn of queued) {
      try {
        await enqueue("turns.dispatch", {
          orgId: scope.orgId,
          projectId: scope.projectId,
          turnId: turn.turnId,
        });
      } catch {
        console.error(
          JSON.stringify({ event: "workflow.queue_publication_deferred", turnId: turn.turnId }),
        );
      }
    }
  } catch {
    console.error(
      JSON.stringify({ event: "workflow.queue_recovery_deferred", projectId: scope.projectId }),
    );
  }
}
