import { AgentManifestSchema } from "@facility/agents";
import type { StoryWorkflowStatus } from "@facility/core";
import { type FacilityDb, turns } from "@facility/db";
import { and, eq, like } from "drizzle-orm";
import { ApiError } from "../errors.js";
import { readDeliveryAcceptance } from "./delivery-acceptance.js";
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
      const queued = await tx
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
        .limit(50);
      let blockedReason: string | null = null;
      for (const turn of queued) {
        try {
          await authorizePlanExecution(
            tx,
            scope,
            AgentManifestSchema.parse(turn.manifest),
            turn.createdBy,
            turn.id,
          );
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
