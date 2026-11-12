import { type PlanExecutionObservation, PlanExecutionObservationSchema } from "@facility/core";
import type { storyEvidenceEvents, storyPlanDecisions, turns } from "@facility/db";
import { PlanExecutionAuthorizationSchema } from "./workflow-execution.js";

type Evidence = Pick<
  typeof storyEvidenceEvents.$inferSelect,
  | "orgId"
  | "projectId"
  | "storyId"
  | "turnId"
  | "source"
  | "type"
  | "externalKey"
  | "data"
  | "occurredAt"
>;
type Turn = Pick<
  typeof turns.$inferSelect,
  | "orgId"
  | "projectId"
  | "storyId"
  | "id"
  | "agentName"
  | "engine"
  | "model"
  | "manifestHash"
  | "state"
  | "startedAt"
  | "endedAt"
>;
type Decision = Pick<
  typeof storyPlanDecisions.$inferSelect,
  | "orgId"
  | "projectId"
  | "storyId"
  | "id"
  | "intent"
  | "decisionRevision"
  | "planRevision"
  | "planDigest"
>;

/** Only a recorded native admission can link a turn to a human approval. */
export function observePlanExecution(
  evidence: Evidence,
  turn: Turn | null,
  decision: Decision,
): PlanExecutionObservation | null {
  const authorization = PlanExecutionAuthorizationSchema.safeParse(evidence.data);
  if (
    !turn ||
    !authorization.success ||
    decision.intent !== "approve" ||
    evidence.source !== "facility" ||
    evidence.type !== "workflow.execution_authorized" ||
    evidence.externalKey !== `workflow:execution:${turn.id}` ||
    evidence.turnId !== turn.id ||
    [evidence, turn].some(
      (row) =>
        row.orgId !== decision.orgId ||
        row.projectId !== decision.projectId ||
        row.storyId !== decision.storyId,
    ) ||
    authorization.data.decisionId !== decision.id ||
    authorization.data.decisionRevision !== decision.decisionRevision ||
    authorization.data.planRevision !== decision.planRevision ||
    authorization.data.planDigest !== decision.planDigest ||
    authorization.data.agentName !== turn.agentName ||
    authorization.data.manifestHash !== turn.manifestHash
  )
    return null;
  const result = PlanExecutionObservationSchema.safeParse({
    turnId: turn.id,
    agentName: turn.agentName,
    engine: turn.engine,
    model: turn.model,
    manifestHash: turn.manifestHash,
    state: turn.state,
    authorizedAt: evidence.occurredAt.toISOString(),
    startedAt: turn.startedAt?.toISOString() ?? null,
    endedAt: turn.endedAt?.toISOString() ?? null,
  });
  return result.success ? result.data : null;
}
