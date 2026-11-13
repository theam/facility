import { createHash } from "node:crypto";
import {
  type DeliveryBriefSource,
  type DeliveryDecisionBriefProjection,
  readDeliveryDecisionBrief,
  type StoryDelivery,
} from "@facility/core";
import { type FacilityDb, storyMessages, turns } from "@facility/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

export type BriefDeliveryObservation = {
  scopeRevision: number;
  candidate: StoryDelivery["candidate"];
  pullRequests: Array<
    Pick<
      StoryDelivery["pullRequests"][number],
      "repositoryId" | "number" | "headSha" | "required" | "primary" | "state" | "stale"
    >
  >;
};
export function projectDeliveryBrief(
  body: string,
  source: DeliveryBriefSource,
  observation: BriefDeliveryObservation,
  bodyComplete = true,
): DeliveryDecisionBriefProjection {
  const parsed = bodyComplete
    ? readDeliveryDecisionBrief(body)
    : { status: "invalid" as const, reason: "too_large" as const };
  if (parsed.status !== "available")
    return {
      status: "invalid",
      source,
      reason: parsed.status === "invalid" ? parsed.reason : "malformed",
    };
  const saved = { source, subject: parsed.value.subject, brief: parsed.value.brief };
  const { subject } = saved;
  if (!source.turn) return { status: "unverifiable", ...saved, reason: "source_unavailable" };
  if (subject.scopeRevision !== observation.scopeRevision)
    return { status: "stale", ...saved, reason: "scope_changed" };
  const refs = (pulls: BriefDeliveryObservation["pullRequests"] | typeof subject.pullRequests) =>
    pulls
      .map(({ repositoryId, number, headSha, required, primary }) => ({
        repositoryId,
        number,
        headSha,
        required,
        primary,
      }))
      .sort((a, b) => a.repositoryId.localeCompare(b.repositoryId) || a.number - b.number);
  if (
    observation.pullRequests.some((pull) => pull.state === "unobserved" || !pull.headSha) ||
    !observation.candidate.revision
  )
    return { status: "unverifiable", ...saved, reason: "observations_unavailable" };
  if (JSON.stringify(refs(subject.pullRequests)) !== JSON.stringify(refs(observation.pullRequests)))
    return { status: "stale", ...saved, reason: "heads_changed" };
  if (subject.candidateRevision !== observation.candidate.revision)
    return { status: "stale", ...saved, reason: "candidate_changed" };
  if (
    observation.pullRequests.some((pull) => pull.stale) ||
    observation.candidate.state === "stale"
  )
    return { status: "unverifiable", ...saved, reason: "observations_stale" };
  if (observation.candidate.state !== "recorded")
    return { status: "unverifiable", ...saved, reason: "observations_unavailable" };
  return { status: "available", ...saved };
}

/** Only selected stories, latest marked message each, at most 100,001 characters.
 * No model, provider or mutable PR description is involved. */
export async function readDeliveryBriefs(
  db: FacilityDb,
  scope: { orgId: string; projectId: string },
  observations: Map<string, BriefDeliveryObservation>,
): Promise<Map<string, DeliveryDecisionBriefProjection>> {
  const result = new Map<string, DeliveryDecisionBriefProjection>();
  if (!observations.size) return result;
  const rows = await db
    .selectDistinctOn([storyMessages.storyId], {
      storyId: storyMessages.storyId,
      id: storyMessages.id,
      seq: storyMessages.seq,
      createdAt: storyMessages.createdAt,
      body: sql<string>`left(${storyMessages.body}, 100001)`,
      complete: sql<boolean>`length(${storyMessages.body}) <= 100000`,
      turn: {
        id: turns.id,
        agentName: turns.agentName,
        engine: turns.engine,
        model: turns.model,
        state: turns.state,
      },
    })
    .from(storyMessages)
    .leftJoin(
      turns,
      and(
        eq(turns.orgId, scope.orgId),
        eq(turns.projectId, scope.projectId),
        eq(turns.storyId, storyMessages.storyId),
        eq(turns.id, storyMessages.turnId),
      ),
    )
    .where(
      and(
        eq(storyMessages.orgId, scope.orgId),
        eq(storyMessages.projectId, scope.projectId),
        inArray(storyMessages.storyId, [...observations.keys()]),
        eq(storyMessages.role, "agent"),
        sql`${storyMessages.metadata} ->> 'deliveryDecisionBrief' = '1'`,
      ),
    )
    .orderBy(storyMessages.storyId, desc(storyMessages.seq));
  for (const row of rows) {
    const observation = observations.get(row.storyId);
    if (!observation) continue;
    const source: DeliveryBriefSource = {
      messageId: row.id,
      seq: row.seq,
      createdAt: row.createdAt.toISOString(),
      digest: row.complete ? createHash("sha256").update(row.body).digest("hex") : null,
      turn:
        row.turn?.state === "succeeded"
          ? {
              id: row.turn.id,
              agentName: row.turn.agentName,
              engine: row.turn.engine,
              model: row.turn.model,
            }
          : null,
    };
    result.set(row.storyId, projectDeliveryBrief(row.body, source, observation, row.complete));
  }
  return result;
}
