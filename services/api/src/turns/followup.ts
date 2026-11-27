import { createHmac, timingSafeEqual } from "node:crypto";
import { newId } from "@facility/core";
import {
  type FacilityDb,
  projects,
  sessionWaiters,
  stories,
  storyMessages,
  turnEvents,
  turns,
  workspaces,
} from "@facility/db";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { authorizeWorkspaceExecution } from "../auth/workspace-execution.js";
import { ApiError } from "../errors.js";
import { planExecutionStillAuthorized } from "../stories/workflow-execution.js";
import { WorkspaceVariablesService } from "../workspaces/variables.js";
import { appendTurnEvent } from "./events.js";

export const FOLLOWUP_TRIGGER = "followup";
export const FOLLOWUP_REQUESTED = "turn.followup_requested";
export const MAX_FOLLOWUP_WAKEUPS = 5;
export const FOLLOWUP_WINDOW_HOURS = 4;
const MIN_FOLLOWUP_DELAY_SECONDS = 30;
const TURN_TOKEN_LIFETIME_MS = 24 * 60 * 60_000;
const DISPATCH_WINDOW_MS = 15 * 60_000;

export const followupToolInput = z
  .object({
    delay_seconds: z
      .number()
      .int()
      .min(MIN_FOLLOWUP_DELAY_SECONDS)
      .max(3_600)
      .describe("Time before the next check"),
    reason: z.string().trim().min(1).max(160).describe("Short explanation shown to the user"),
    context: z
      .string()
      .trim()
      .min(1)
      .max(800)
      .describe("What to check and the job or task references needed to resume"),
  })
  .strict();

type Turn = typeof turns.$inferSelect;
type Story = typeof stories.$inferSelect;
export type FollowupRequest = {
  dueAt: string;
  reason: string;
  context: string;
  workspaceId: string;
};

function isInteractiveTurn(turn: Pick<Turn, "triggerType" | "createdBy">) {
  return ["ui", "mcp", "manual"].includes(turn.triggerType) && Boolean(followupActor(turn));
}

function followupActor(turn: Pick<Turn, "createdBy">) {
  const actor = turn.createdBy as { type?: string; id?: string } | null;
  if (!actor?.id) return undefined;
  if (actor.type === "user") return { type: "user" as const, id: actor.id };
  if (actor.type === "service") return { type: "key" as const, id: actor.id };
  return undefined;
}

export async function authorizeFollowupExecution(db: FacilityDb, turn: Turn) {
  const actor = followupActor(turn);
  if (!actor)
    throw new ApiError(403, "followup_actor_invalid", "Follow-up requires a current authorizer");
  await authorizeWorkspaceExecution(db, turn, actor, "followup_authorization_revoked");
  const [project] = await db
    .select({ status: projects.status })
    .from(projects)
    .where(and(eq(projects.orgId, turn.orgId), eq(projects.id, turn.projectId)))
    .for("share")
    .limit(1);
  if (project?.status !== "active")
    throw new ApiError(409, "followup_project_inactive", "The project is inactive");
}

export type FollowupChain = {
  rootTurnId: string;
  wakeups: number;
  expiresAt: Date;
};

/** Follow only settled predecessors in the same assignment. Older follow-ups
 * already use triggerKey for their predecessor, so they share this boundary. */
export async function readFollowupChain(db: FacilityDb, turn: Turn): Promise<FollowupChain | null> {
  let origin = turn;
  let wakeups = 0;
  while (origin.triggerType === FOLLOWUP_TRIGGER) {
    if (!origin.triggerKey || ++wakeups > MAX_FOLLOWUP_WAKEUPS) return null;
    const [previous] = await db
      .select()
      .from(turns)
      .where(
        and(
          eq(turns.id, origin.triggerKey),
          eq(turns.orgId, turn.orgId),
          eq(turns.projectId, turn.projectId),
          eq(turns.storyId, turn.storyId),
          eq(turns.conversationId, turn.conversationId),
          eq(turns.agentName, turn.agentName),
          eq(turns.manifestHash, turn.manifestHash),
          eq(turns.state, "succeeded"),
        ),
      )
      .limit(1);
    if (!previous) return null;
    origin = previous;
  }
  if (!isInteractiveTurn(origin) || !origin.startedAt) return null;
  return {
    rootTurnId: origin.id,
    wakeups,
    expiresAt: new Date(origin.startedAt.getTime() + FOLLOWUP_WINDOW_HOURS * 60 * 60_000),
  };
}

export function canScheduleFollowup(chain: FollowupChain, dueAt: Date) {
  return chain.wakeups < MAX_FOLLOWUP_WAKEUPS && dueAt < chain.expiresAt;
}

export function mayScheduleNextFollowup(chain: FollowupChain, now = new Date()) {
  return canScheduleFollowup(chain, new Date(now.getTime() + MIN_FOLLOWUP_DELAY_SECONDS * 1_000));
}

export function turnToolToken(secret: string, turnId: string, startedAt: Date) {
  const payload = `${turnId}.${startedAt.getTime()}`;
  const signature = createHmac("sha256", secret)
    .update(`facility:turn-tools:${payload}`)
    .digest("hex");
  return `facility-turn.${payload}.${signature}`;
}

export function verifyTurnToolToken(secret: string, header: string | undefined, now = Date.now()) {
  const match = header?.match(
    /^Bearer (facility-turn\.(turn_[a-z0-9]+)\.(\d{13})\.[a-f0-9]{64})$/i,
  );
  const [, token, turnId, timestamp] = match ?? [];
  if (!token || !turnId || !timestamp) return null;
  const startedAt = Number(timestamp);
  if (startedAt > now || now - startedAt >= TURN_TOKEN_LIFETIME_MS) return null;
  const expected = turnToolToken(secret, turnId, new Date(startedAt));
  if (!timingSafeEqual(Buffer.from(token), Buffer.from(expected))) return null;
  return { turnId, startedAt };
}

export function storyCanFollowUp(story: Story) {
  return (
    !story.deletedAt &&
    !story.archivedAt &&
    !story.completedAt &&
    !["archived", "done"].includes(story.status)
  );
}

export async function registerFollowup(
  db: FacilityDb,
  grant: { turnId: string; startedAt: number },
  input: z.infer<typeof followupToolInput>,
  masterKey: string,
  now = new Date(),
) {
  // Do not persist URLs, tokens or pasted multiline output in the handoff.
  const unsafe =
    // biome-ignore lint/suspicious/noControlCharactersInRegex: reject pasted multiline output
    /[\x00-\x1f\x7f]|:\/\/|\bBearer\s|\b(?:fak_|gh[pousr]_|github_pat_|sk-|xox[baprs]-|facility-turn\.)/i;
  const handoff = `${input.reason} ${input.context}`;
  if (unsafe.test(handoff) || handoff.includes(masterKey))
    throw new ApiError(
      400,
      "followup_content_invalid",
      "Use a brief reason and non-secret references without links",
    );
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as FacilityDb;
    const [turn] = await tx.select().from(turns).where(eq(turns.id, grant.turnId)).for("update");
    if (
      turn?.state !== "running" ||
      turn.startedAt?.getTime() !== grant.startedAt ||
      now.getTime() - grant.startedAt >= TURN_TOKEN_LIFETIME_MS
    ) {
      throw new ApiError(409, "followup_turn_inactive", "This turn cannot schedule a follow-up");
    }
    const [story] = await tx
      .select()
      .from(stories)
      .where(
        and(
          eq(stories.orgId, turn.orgId),
          eq(stories.projectId, turn.projectId),
          eq(stories.id, turn.storyId),
        ),
      );
    if (!story || !storyCanFollowUp(story))
      throw new ApiError(409, "followup_story_closed", "This story cannot accept follow-ups");
    await authorizeFollowupExecution(tx, turn);
    if (!(await planExecutionStillAuthorized(tx, turn, turn)))
      throw new ApiError(403, "followup_plan_revoked", "The turn's workflow authorization changed");
    const chain = await readFollowupChain(tx, turn);
    if (!chain)
      throw new ApiError(409, "followup_origin_missing", "The original assignment is unavailable");
    const existing = await readFollowupRequest(tx, turn);
    if (existing) {
      if (existing.reason !== input.reason || existing.context !== input.context)
        throw new ApiError(
          409,
          "followup_already_requested",
          "This turn already confirmed a follow-up",
        );
      return {
        due_at: existing.dueAt,
        expires_at: chain.expiresAt.toISOString(),
        followups_remaining: MAX_FOLLOWUP_WAKEUPS - chain.wakeups - 1,
      };
    }
    const dueAt = new Date(now.getTime() + input.delay_seconds * 1_000);
    if (!canScheduleFollowup(chain, dueAt))
      throw new ApiError(
        409,
        "followup_limit_reached",
        "This assignment has reached its automatic follow-up limit",
      );
    const [workspace] = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.orgId, turn.orgId),
          eq(workspaces.projectId, turn.projectId),
          eq(workspaces.storyId, turn.storyId),
          inArray(workspaces.state, ["running", "sleeping"]),
        ),
      )
      .limit(1);
    if (!workspace)
      throw new ApiError(409, "followup_workspace_missing", "No retained workspace to continue");
    const variables = await new WorkspaceVariablesService(tx, masterKey).values({
      orgId: turn.orgId,
      projectId: turn.projectId,
      workspaceId: workspace.id,
    });
    const projectEnvironmentPrefix = `FACILITY_PROJECT_${turn.projectId.toUpperCase()}_`;
    const injectedValues = Object.entries(process.env).flatMap(([name, value]) =>
      name.startsWith(projectEnvironmentPrefix) && value ? [value] : [],
    );
    if (
      [...Object.values(variables), ...injectedValues].some(
        (value) => value !== "" && (input.reason.includes(value) || input.context.includes(value)),
      )
    )
      throw new ApiError(
        400,
        "followup_content_invalid",
        "Use a brief reason and non-secret references without links",
      );
    const data: FollowupRequest = {
      dueAt: dueAt.toISOString(),
      reason: input.reason,
      context: input.context,
      workspaceId: workspace.id,
    };
    await appendTurnEvent(tx, {
      orgId: turn.orgId,
      projectId: turn.projectId,
      storyId: turn.storyId,
      turnId: turn.id,
      type: FOLLOWUP_REQUESTED,
      data,
    });
    return {
      due_at: data.dueAt,
      expires_at: chain.expiresAt.toISOString(),
      followups_remaining: MAX_FOLLOWUP_WAKEUPS - chain.wakeups - 1,
    };
  });
}

export async function readFollowupRequest(db: FacilityDb, turn: Turn, requestedByTurnId = turn.id) {
  const [request] = await db
    .select({ data: turnEvents.data })
    .from(turnEvents)
    .where(
      and(
        eq(turnEvents.orgId, turn.orgId),
        eq(turnEvents.projectId, turn.projectId),
        eq(turnEvents.storyId, turn.storyId),
        eq(turnEvents.turnId, requestedByTurnId),
        eq(turnEvents.type, FOLLOWUP_REQUESTED),
      ),
    )
    .limit(1);
  return request?.data as FollowupRequest | undefined;
}

/** Settle the predecessor and create its only successor in the same transaction. */
export async function queueFollowup(db: FacilityDb, turn: Turn, story: Story, now = new Date()) {
  if (turn.triggerType !== FOLLOWUP_TRIGGER && !isInteractiveTurn(turn)) return false;
  const request = await readFollowupRequest(db, turn);
  if (!request) return false;
  const chain = await readFollowupChain(db, turn);
  const scheduledFor = new Date(request.dueAt);
  const [pending] = await db
    .select({ id: storyMessages.id })
    .from(storyMessages)
    .where(
      and(
        eq(storyMessages.conversationId, turn.conversationId),
        eq(storyMessages.role, "user"),
        isNull(storyMessages.turnId),
      ),
    )
    .limit(1);
  // A connected person waiting for the native session goes ahead of automation.
  const canceled =
    !!pending ||
    !!(
      await db
        .select({ id: sessionWaiters.id })
        .from(sessionWaiters)
        .where(
          and(
            eq(sessionWaiters.orgId, turn.orgId),
            eq(sessionWaiters.projectId, turn.projectId),
            eq(sessionWaiters.storyId, turn.storyId),
            eq(sessionWaiters.waiting, true),
            gt(sessionWaiters.expiresAt, now),
          ),
        )
        .limit(1)
    )[0] ||
    !storyCanFollowUp(story) ||
    !chain ||
    !canScheduleFollowup(chain, scheduledFor) ||
    followupExpired(scheduledFor, now) ||
    now >= chain.expiresAt;
  await db.insert(turns).values({
    id: newId("turn"),
    orgId: turn.orgId,
    projectId: turn.projectId,
    storyId: turn.storyId,
    conversationId: turn.conversationId,
    agentName: turn.agentName,
    manifest: turn.manifest,
    manifestHash: turn.manifestHash,
    engine: turn.engine,
    model: turn.model,
    createdBy: turn.createdBy,
    triggerType: FOLLOWUP_TRIGGER,
    triggerKey: turn.id,
    scheduledFor,
    ...(canceled ? { state: "canceled", endedAt: now } : { retryAfter: scheduledFor }),
  });
  return !canceled;
}

export function followupExpired(scheduledFor: Date | null, now = new Date()) {
  return !scheduledFor || now.getTime() >= scheduledFor.getTime() + DISPATCH_WINDOW_MS;
}

/** Call while holding the story fence. A concurrent worker claims the same row. */
export async function cancelPendingFollowup(db: FacilityDb, story: Story, now = new Date()) {
  const [canceled] = await db
    .update(turns)
    .set({
      state: "canceled",
      endedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(turns.orgId, story.orgId),
        eq(turns.projectId, story.projectId),
        eq(turns.storyId, story.id),
        eq(turns.state, "queued"),
        eq(turns.triggerType, FOLLOWUP_TRIGGER),
      ),
    )
    .returning({ id: turns.id });
  return canceled;
}
