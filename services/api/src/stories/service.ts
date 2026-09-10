import { randomBytes } from "node:crypto";
import { type AgentManifest, AgentManifestSchema } from "@facility/agents";
import { newId } from "@facility/core";
import {
  attentionItems,
  type FacilityDb,
  previewSessions,
  stories,
  storyArtifacts,
  storyConversations,
  storyEvidenceEvents,
  storyMessages,
  turnEvents,
  turns,
  users,
  workspaces,
} from "@facility/db";
import { and, asc, desc, eq, inArray, isNull, lt, lte, notInArray, sql } from "drizzle-orm";
import { ACTIVITY_NOISE_TYPES, presentTurnEvent } from "../turns/activity.js";
import { stopInterruptedEngineProcess } from "../turns/engines.js";
import { appendTurnEvent } from "../turns/events.js";
import { appendWorkspaceEvent } from "../workspaces/events.js";
import type {
  CreateWorkspace,
  WorkspaceHandle,
  WorkspaceLocator,
  WorkspaceRuntime,
} from "../workspaces/runtime.js";
import { reconcileTurnBranch } from "./branch.js";

export type StoryActor = { type: "user" | "service" | "system"; id: string };

export type StartStoryInput = {
  orgId: string;
  projectId: string;
  repositoryId?: string;
  provider: "github" | "manual" | "schedule";
  externalId: string;
  title: string;
  branch?: string;
  agent: AgentManifest;
  message: string;
  messageDedupeKey: string;
  actor: StoryActor;
  workspace: Omit<CreateWorkspace, "id">;
  trigger?: {
    type: "manual" | "mcp" | "ui" | "github" | "schedule";
    key?: string;
    scheduledFor?: Date;
  };
};

export type StoryWorkspaceBundle = Awaited<ReturnType<StoryWorkspaceService["get"]>>;

/** How an agent response was recorded; older rows have no metadata and stay combined. */
export type StoryMessageMetadata = {
  content?: "final_response";
  engine?: string;
  model?: string;
  progressMessages?: number;
};

export type ConversationAuthor = {
  kind: "user" | "github" | "service" | "schedule" | "system" | "agent";
  id: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
};

export type ConversationTurn = {
  id: string;
  agentName: string;
  engine: string;
  model: string;
  state: string;
  error: string | null;
  triggerType: string;
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
};

export type ConversationContent = {
  kind: "final_response" | "combined_transcript" | "text";
  progressMessages: number | null;
  reportedModel: string | null;
};

export class StoryServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 409,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StoryServiceError";
  }
}

export class StoryWorkspaceService {
  constructor(
    private readonly db: FacilityDb,
    private readonly runtime: WorkspaceRuntime,
    private readonly onTurnQueued: (turn: typeof turns.$inferSelect) => Promise<void> = async () =>
      undefined,
  ) {}

  async start(input: StartStoryInput) {
    validateStartInput(input);
    const aggregate = await this.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as FacilityDb;
      await lockIdentity(
        tx,
        `${input.orgId}:${input.projectId}:${input.repositoryId ?? "none"}:${input.provider}:${input.externalId}`,
      );
      let story = (
        await tx
          .select()
          .from(stories)
          .where(
            and(
              eq(stories.orgId, input.orgId),
              eq(stories.projectId, input.projectId),
              input.repositoryId
                ? eq(stories.repositoryId, input.repositoryId)
                : isNull(stories.repositoryId),
              eq(stories.provider, input.provider),
              eq(stories.externalId, input.externalId),
            ),
          )
          .limit(1)
      )[0];
      if (!story) {
        story = (
          await tx
            .insert(stories)
            .values({
              id: newId("story"),
              orgId: input.orgId,
              projectId: input.projectId,
              repositoryId: input.repositoryId,
              provider: input.provider,
              externalId: input.externalId,
              title: input.title,
              status: "ready",
              branch: input.branch,
              createdBy: input.actor,
            })
            .returning()
        )[0];
      }
      if (!story)
        throw new StoryServiceError("story_create_failed", "story could not be created", 500);
      if (story.deletedAt) {
        throw new StoryServiceError(
          "story_workspace_deleted",
          "this story's workspace was explicitly deleted; start a new story identity",
        );
      }

      let conversation = (
        await tx
          .select()
          .from(storyConversations)
          .where(eq(storyConversations.storyId, story.id))
          .limit(1)
      )[0];
      if (!conversation) {
        conversation = (
          await tx
            .insert(storyConversations)
            .values({
              id: newId("sess"),
              orgId: input.orgId,
              projectId: input.projectId,
              storyId: story.id,
            })
            .returning()
        )[0];
      }
      if (!conversation) {
        throw new StoryServiceError(
          "conversation_create_failed",
          "story conversation could not be created",
          500,
        );
      }

      let workspace = (
        await tx
          .select()
          .from(workspaces)
          .where(
            and(
              eq(workspaces.orgId, input.orgId),
              eq(workspaces.storyId, story.id),
              inArray(workspaces.state, ["creating", "running", "sleeping", "error"]),
            ),
          )
          .limit(1)
      )[0];
      if (!workspace) {
        const workspaceId = newId("ws");
        workspace = (
          await tx
            .insert(workspaces)
            .values({
              id: workspaceId,
              orgId: input.orgId,
              projectId: input.projectId,
              storyId: story.id,
              provider: this.runtime.provider,
              volumeRef: pendingVolumeRef(this.runtime.provider, workspaceId),
              state: "creating",
              environment: workspaceConfiguration(input.workspace),
            })
            .returning()
        )[0];
      }
      if (!workspace) {
        throw new StoryServiceError(
          "workspace_create_failed",
          "workspace record could not be created",
          500,
        );
      }
      return { story, conversation, workspace };
    });

    let handle: WorkspaceHandle;
    const runtimeOperation =
      aggregate.workspace.state === "creating" || !aggregate.workspace.externalRef
        ? "create"
        : "wake";
    const runtimeStartedAt = performance.now();
    try {
      handle =
        runtimeOperation === "create"
          ? await this.runtime.create({
              id: aggregate.workspace.id,
              ...workspaceInput(aggregate.workspace),
            })
          : await this.runtime.wake(locatorFromRow(aggregate.workspace));
      await this.db
        .update(workspaces)
        .set({
          externalRef: handle.externalRef,
          volumeRef: handle.volumeRef,
          state: "running",
          error: null,
          lastActivityAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(workspaces.orgId, input.orgId),
            eq(workspaces.projectId, input.projectId),
            eq(workspaces.id, aggregate.workspace.id),
          ),
        );
      await appendWorkspaceEvent(this.db, aggregate.workspace.id, input.orgId, "workspace.ready", {
        provider: this.runtime.provider,
        computeRef: handle.computeRef,
        operation: runtimeOperation,
        durationMs: Math.round(performance.now() - runtimeStartedAt),
      });
    } catch (error) {
      await this.markRuntimeFailure(aggregate.story.id, aggregate.workspace.id, input, error);
      throw new StoryServiceError(
        "workspace_start_failed",
        error instanceof Error ? error.message : "workspace failed to start",
        503,
        { cause: error },
      );
    }

    const queued = await this.queueMessage({
      orgId: input.orgId,
      projectId: input.projectId,
      storyId: aggregate.story.id,
      body: input.message,
      dedupeKey: input.messageDedupeKey,
      agent: input.agent,
      actor: input.actor,
      trigger: input.trigger ?? { type: "manual" },
    });
    return { ...(await this.get(input.orgId, input.projectId, aggregate.story.id)), queued };
  }

  async queueMessage(input: {
    orgId: string;
    projectId: string;
    storyId: string;
    body: string;
    dedupeKey: string;
    agent: AgentManifest;
    actor: StoryActor;
    trigger: {
      type: "manual" | "mcp" | "ui" | "github" | "schedule";
      key?: string;
      scheduledFor?: Date;
    };
  }) {
    if (!input.body.trim()) {
      throw new StoryServiceError("message_invalid", "message must not be empty", 400);
    }
    if (!input.dedupeKey.trim() || input.dedupeKey.length > 200) {
      throw new StoryServiceError(
        "idempotency_key_invalid",
        "message idempotency key is invalid",
        400,
      );
    }

    const queued = await this.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as FacilityDb;
      await lockStory(tx, input.orgId, input.projectId, input.storyId);
      const story = await scopedStory(tx, input.orgId, input.projectId, input.storyId);
      if (story.deletedAt) {
        throw new StoryServiceError("story_workspace_deleted", "story workspace was deleted");
      }
      const conversation = (
        await tx
          .select()
          .from(storyConversations)
          .where(
            and(
              eq(storyConversations.orgId, input.orgId),
              eq(storyConversations.projectId, input.projectId),
              eq(storyConversations.storyId, input.storyId),
            ),
          )
          .limit(1)
      )[0];
      if (!conversation)
        throw new StoryServiceError("conversation_not_found", "story conversation not found", 404);

      const duplicate = (
        await tx
          .select()
          .from(storyMessages)
          .where(
            and(
              eq(storyMessages.conversationId, conversation.id),
              eq(storyMessages.dedupeKey, input.dedupeKey),
            ),
          )
          .limit(1)
      )[0];
      if (duplicate) {
        const turn = duplicate.turnId
          ? (await tx.select().from(turns).where(eq(turns.id, duplicate.turnId)).limit(1))[0]
          : undefined;
        return { message: duplicate, turn, queued: !turn, created: false };
      }

      const active = (
        await tx
          .select()
          .from(turns)
          .where(and(eq(turns.storyId, input.storyId), inArray(turns.state, ["queued", "running"])))
          .limit(1)
      )[0];
      const sequence = await allocateMessageSequence(tx, conversation.id);
      let turn: typeof turns.$inferSelect | undefined;
      if (!active) {
        turn = (
          await tx
            .insert(turns)
            .values({
              id: newId("turn"),
              orgId: input.orgId,
              projectId: input.projectId,
              storyId: input.storyId,
              conversationId: conversation.id,
              agentName: input.agent.name,
              manifestHash: input.agent.hash,
              manifest: input.agent,
              engine: input.agent.engine,
              model: input.agent.model,
              triggerType: input.trigger.type,
              triggerKey: input.trigger.key,
              scheduledFor: input.trigger.scheduledFor,
              createdBy: input.actor,
            })
            .returning()
        )[0];
      }
      const message = (
        await tx
          .insert(storyMessages)
          .values({
            id: newId("msg"),
            orgId: input.orgId,
            projectId: input.projectId,
            storyId: input.storyId,
            conversationId: conversation.id,
            seq: sequence,
            role: "user",
            body: input.body,
            actor: input.actor,
            turnId: turn?.id,
            requestedAgentName: input.agent.name,
            requestedTrigger: input.trigger,
            dedupeKey: input.dedupeKey,
          })
          .returning()
      )[0];
      if (!message)
        throw new StoryServiceError("message_create_failed", "message could not be stored", 500);
      await tx
        .update(stories)
        .set({
          status: "working",
          activeAgentName: turn?.agentName ?? story.activeAgentName,
          archivedAt: null,
          archivedFromStatus: null,
          updatedAt: new Date(),
        })
        .where(eq(stories.id, input.storyId));
      return { message, turn, queued: !turn, created: true };
    });
    if (queued.turn && queued.created) await this.onTurnQueued(queued.turn);
    return queued;
  }

  async completeTurn(input: {
    orgId: string;
    projectId: string;
    turnId: string;
    output: string;
    actor: StoryActor;
    metadata?: StoryMessageMetadata;
  }) {
    return this.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as FacilityDb;
      const turn = await scopedTurn(tx, input.orgId, input.projectId, input.turnId);
      await lockStory(tx, input.orgId, input.projectId, turn.storyId);
      const story = await scopedStory(tx, input.orgId, input.projectId, turn.storyId);
      if (turn.state === "succeeded") {
        await reconcileTurnBranch(tx, story, turn);
        return turn;
      }
      if (!["queued", "running"].includes(turn.state)) {
        throw new StoryServiceError("turn_not_active", "turn is not active");
      }
      const sequence = await allocateMessageSequence(tx, turn.conversationId);
      await tx.insert(storyMessages).values({
        id: newId("msg"),
        orgId: input.orgId,
        projectId: input.projectId,
        storyId: turn.storyId,
        conversationId: turn.conversationId,
        seq: sequence,
        role: "agent",
        body: input.output,
        actor: input.actor,
        turnId: turn.id,
        metadata: input.metadata ?? {},
      });
      const completed = (
        await tx
          .update(turns)
          .set({ state: "succeeded", endedAt: new Date(), error: null, updatedAt: new Date() })
          .where(and(eq(turns.orgId, input.orgId), eq(turns.id, turn.id)))
          .returning()
      )[0];
      await tx
        .update(stories)
        .set({
          status: lifecycleStatusAfterTurn(story.status, "working"),
          activeAgentName: null,
          updatedAt: new Date(),
        })
        .where(and(eq(stories.orgId, input.orgId), eq(stories.id, turn.storyId)));
      if (!completed) throw new StoryServiceError("turn_not_found", "completed turn not found");
      await reconcileTurnBranch(tx, story, completed);
      return completed;
    });
  }

  async failTurn(input: { orgId: string; projectId: string; turnId: string; error: string }) {
    return this.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as FacilityDb;
      const turn = await scopedTurn(tx, input.orgId, input.projectId, input.turnId);
      await lockStory(tx, input.orgId, input.projectId, turn.storyId);
      const story = await scopedStory(tx, input.orgId, input.projectId, turn.storyId);
      if (["succeeded", "failed", "canceled"].includes(turn.state)) return turn;
      const failed = (
        await tx
          .update(turns)
          .set({ state: "failed", error: input.error, endedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(turns.orgId, input.orgId), eq(turns.id, turn.id)))
          .returning()
      )[0];
      await tx
        .update(stories)
        .set({
          status: lifecycleStatusAfterTurn(story.status, "attention"),
          activeAgentName: null,
          updatedAt: new Date(),
        })
        .where(and(eq(stories.orgId, input.orgId), eq(stories.id, turn.storyId)));
      await tx.insert(attentionItems).values({
        id: newId("attn"),
        orgId: input.orgId,
        projectId: input.projectId,
        storyId: turn.storyId,
        turnId: turn.id,
        kind: "turn_error",
        title: `${turn.agentName} failed`,
        detail: input.error,
      });
      if (!failed) throw new StoryServiceError("turn_not_found", "failed turn not found");
      return failed;
    });
  }

  async cancelTurn(input: {
    orgId: string;
    projectId: string;
    storyId: string;
    turnId: string;
    actor: StoryActor;
  }) {
    const result = await this.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as FacilityDb;
      const turn = await scopedTurn(tx, input.orgId, input.projectId, input.turnId);
      if (turn.storyId !== input.storyId) {
        throw new StoryServiceError("turn_not_found", "turn not found", 404);
      }
      await lockStory(tx, input.orgId, input.projectId, input.storyId);
      if (["succeeded", "failed", "canceled"].includes(turn.state)) {
        return { turn, changed: false };
      }
      const now = new Date();
      const updated = (
        await tx
          .update(turns)
          .set({ state: "canceled", endedAt: now, error: null, updatedAt: now })
          .where(
            and(
              eq(turns.orgId, input.orgId),
              eq(turns.projectId, input.projectId),
              eq(turns.id, input.turnId),
              inArray(turns.state, ["queued", "running"]),
            ),
          )
          .returning()
      )[0];
      if (!updated) {
        return {
          turn: await scopedTurn(tx, input.orgId, input.projectId, input.turnId),
          changed: false,
        };
      }
      const story = await scopedStory(tx, input.orgId, input.projectId, input.storyId);
      const remainingAttention = (
        await tx
          .select({ id: attentionItems.id })
          .from(attentionItems)
          .where(
            and(
              eq(attentionItems.orgId, input.orgId),
              eq(attentionItems.projectId, input.projectId),
              eq(attentionItems.storyId, input.storyId),
              eq(attentionItems.status, "open"),
            ),
          )
          .limit(1)
      )[0];
      await tx
        .update(stories)
        .set({
          status: lifecycleStatusAfterTurn(
            story.status,
            remainingAttention ? "attention" : "ready",
          ),
          activeAgentName: null,
          updatedAt: now,
        })
        .where(and(eq(stories.orgId, input.orgId), eq(stories.id, input.storyId)));
      return { turn: updated, changed: true };
    });
    if (result.changed) {
      await appendTurnEvent(this.db, {
        orgId: input.orgId,
        projectId: input.projectId,
        storyId: input.storyId,
        turnId: input.turnId,
        type: result.turn.startedAt ? "turn.cancel_requested" : "turn.canceled",
        data: { actor: input.actor },
      });
    }
    return this.get(input.orgId, input.projectId, input.storyId);
  }

  async recoverInterruptedTurn(input: {
    orgId: string;
    projectId: string;
    turnId: string;
    staleBefore: Date;
  }) {
    const recovered = await this.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as FacilityDb;
      const turn = await scopedTurn(tx, input.orgId, input.projectId, input.turnId);
      await lockStory(tx, input.orgId, input.projectId, turn.storyId);
      const story = await scopedStory(tx, input.orgId, input.projectId, turn.storyId);
      const now = new Date();
      const updated = (
        await tx
          .update(turns)
          .set({
            state: "failed",
            error: "Worker heartbeat expired before the agent turn completed.",
            endedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(turns.orgId, input.orgId),
              eq(turns.projectId, input.projectId),
              eq(turns.id, input.turnId),
              eq(turns.state, "running"),
              lte(turns.updatedAt, input.staleBefore),
            ),
          )
          .returning()
      )[0];
      if (!updated) return undefined;
      await tx
        .update(stories)
        .set({
          status: lifecycleStatusAfterTurn(story.status, "attention"),
          activeAgentName: null,
          updatedAt: now,
        })
        .where(and(eq(stories.orgId, input.orgId), eq(stories.id, turn.storyId)));
      await tx.insert(attentionItems).values({
        id: newId("attn"),
        orgId: input.orgId,
        projectId: input.projectId,
        storyId: turn.storyId,
        turnId: turn.id,
        kind: "worker_interrupted",
        title: `${turn.agentName} was interrupted`,
        detail:
          "The worker heartbeat expired. The message, worktree, and native session files were retained; retry this attention item after inspecting any partial changes.",
      });
      return updated;
    });
    if (!recovered) return false;

    let processCleanup = "workspace unavailable";
    try {
      const workspace = (
        await this.db
          .select()
          .from(workspaces)
          .where(
            and(
              eq(workspaces.orgId, input.orgId),
              eq(workspaces.projectId, input.projectId),
              eq(workspaces.storyId, recovered.storyId),
            ),
          )
          .orderBy(desc(workspaces.createdAt))
          .limit(1)
      )[0];
      if (workspace?.externalRef) {
        processCleanup = await stopInterruptedEngineProcess(
          this.runtime,
          locatorFromRow(workspace),
          recovered.id,
        );
      }
    } catch (error) {
      processCleanup =
        error instanceof Error ? `cleanup failed: ${error.message}` : "cleanup failed";
    }
    await appendTurnEvent(this.db, {
      orgId: input.orgId,
      projectId: input.projectId,
      storyId: recovered.storyId,
      turnId: recovered.id,
      type: "turn.worker_interrupted",
      data: { processCleanup: processCleanup.slice(0, 1_000) },
    });
    return true;
  }

  async flagAttention(input: {
    orgId: string;
    projectId: string;
    storyId: string;
    turnId?: string;
    kind: string;
    title: string;
    detail: string;
  }) {
    return this.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as FacilityDb;
      await lockStory(tx, input.orgId, input.projectId, input.storyId);
      const story = await scopedStory(tx, input.orgId, input.projectId, input.storyId);
      await tx
        .update(stories)
        .set({
          status: lifecycleStatusAfterTurn(story.status, "attention"),
          activeAgentName: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(stories.orgId, input.orgId),
            eq(stories.projectId, input.projectId),
            eq(stories.id, input.storyId),
          ),
        );
      const attention = (
        await tx
          .insert(attentionItems)
          .values({
            id: newId("attn"),
            orgId: input.orgId,
            projectId: input.projectId,
            storyId: input.storyId,
            turnId: input.turnId,
            kind: input.kind,
            title: input.title,
            detail: input.detail,
          })
          .returning()
      )[0];
      if (!attention) {
        throw new StoryServiceError(
          "attention_create_failed",
          "attention item was not created",
          500,
        );
      }
      return attention;
    });
  }

  async resolveAttention(input: {
    orgId: string;
    projectId: string;
    storyId: string;
    kind: string;
    resolution?: string;
    actor?: StoryActor;
  }) {
    const now = new Date();
    const resolved = await this.db
      .update(attentionItems)
      .set({
        status: "resolved",
        resolution: input.resolution ?? "recovered",
        resolvedBy: input.actor,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(attentionItems.orgId, input.orgId),
          eq(attentionItems.projectId, input.projectId),
          eq(attentionItems.storyId, input.storyId),
          eq(attentionItems.kind, input.kind),
          eq(attentionItems.status, "open"),
        ),
      )
      .returning({ id: attentionItems.id });
    return resolved.length;
  }

  async resolveAttentionItem(input: {
    orgId: string;
    projectId: string;
    storyId: string;
    attentionId: string;
    resolution: string;
    actor: StoryActor;
  }) {
    const now = new Date();
    const resolved = await this.db
      .update(attentionItems)
      .set({
        status: "resolved",
        resolution: input.resolution,
        resolvedBy: input.actor,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(attentionItems.orgId, input.orgId),
          eq(attentionItems.projectId, input.projectId),
          eq(attentionItems.storyId, input.storyId),
          eq(attentionItems.id, input.attentionId),
          eq(attentionItems.status, "open"),
        ),
      )
      .returning({ id: attentionItems.id });
    return resolved.length;
  }

  async dismissAttention(input: {
    orgId: string;
    projectId: string;
    storyId: string;
    attentionId: string;
    actor: StoryActor;
  }) {
    await this.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as FacilityDb;
      await lockStory(tx, input.orgId, input.projectId, input.storyId);
      const story = await scopedStory(tx, input.orgId, input.projectId, input.storyId);
      const resolved = (
        await tx
          .update(attentionItems)
          .set({
            status: "resolved",
            resolution: "dismissed",
            resolvedBy: input.actor,
            resolvedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(attentionItems.orgId, input.orgId),
              eq(attentionItems.projectId, input.projectId),
              eq(attentionItems.storyId, input.storyId),
              eq(attentionItems.id, input.attentionId),
              eq(attentionItems.status, "open"),
            ),
          )
          .returning({ id: attentionItems.id })
      )[0];
      if (!resolved) {
        const existing = (
          await tx
            .select({ status: attentionItems.status })
            .from(attentionItems)
            .where(
              and(
                eq(attentionItems.orgId, input.orgId),
                eq(attentionItems.projectId, input.projectId),
                eq(attentionItems.storyId, input.storyId),
                eq(attentionItems.id, input.attentionId),
              ),
            )
            .limit(1)
        )[0];
        if (!existing)
          throw new StoryServiceError("attention_not_found", "attention item not found", 404);
        return;
      }
      const remaining = (
        await tx
          .select({ id: attentionItems.id })
          .from(attentionItems)
          .where(
            and(
              eq(attentionItems.orgId, input.orgId),
              eq(attentionItems.projectId, input.projectId),
              eq(attentionItems.storyId, input.storyId),
              eq(attentionItems.status, "open"),
            ),
          )
          .limit(1)
      )[0];
      if (!remaining && story.status === "attention") {
        const active = (
          await tx
            .select({ id: turns.id })
            .from(turns)
            .where(
              and(eq(turns.storyId, input.storyId), inArray(turns.state, ["queued", "running"])),
            )
            .limit(1)
        )[0];
        await tx
          .update(stories)
          .set({ status: active ? "working" : "ready", updatedAt: new Date() })
          .where(and(eq(stories.orgId, input.orgId), eq(stories.id, input.storyId)));
      }
    });
    return this.get(input.orgId, input.projectId, input.storyId);
  }

  async retryAttention(input: {
    orgId: string;
    projectId: string;
    storyId: string;
    attentionId: string;
    actor: StoryActor;
  }) {
    const attention = (
      await this.db
        .select()
        .from(attentionItems)
        .where(
          and(
            eq(attentionItems.orgId, input.orgId),
            eq(attentionItems.projectId, input.projectId),
            eq(attentionItems.storyId, input.storyId),
            eq(attentionItems.id, input.attentionId),
          ),
        )
        .limit(1)
    )[0];
    if (!attention)
      throw new StoryServiceError("attention_not_found", "attention item not found", 404);
    if (!attention.turnId || attention.kind === "agent_waiting") {
      throw new StoryServiceError(
        "attention_not_retryable",
        "This attention item needs a reply or dismissal rather than a retry",
      );
    }
    if (attention.status === "resolved" && attention.resolution !== "successful_retry") {
      throw new StoryServiceError("attention_resolved", "attention item is already resolved");
    }
    const failedTurn = await scopedTurn(this.db, input.orgId, input.projectId, attention.turnId);
    const queued = await this.queueMessage({
      orgId: input.orgId,
      projectId: input.projectId,
      storyId: input.storyId,
      body: `Retry requested for ${attention.title}.`,
      dedupeKey: `attention-retry:${attention.id}`,
      agent: AgentManifestSchema.parse(failedTurn.manifest),
      actor: input.actor,
      trigger: { type: "manual", key: `attention-retry:${attention.id}` },
    });
    return { ...(await this.get(input.orgId, input.projectId, input.storyId)), queued };
  }

  async activateNextMessage(input: {
    orgId: string;
    projectId: string;
    storyId: string;
    agent: AgentManifest;
    actor: StoryActor;
  }) {
    const turn = await this.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as FacilityDb;
      await lockStory(tx, input.orgId, input.projectId, input.storyId);
      const active = (
        await tx
          .select()
          .from(turns)
          .where(and(eq(turns.storyId, input.storyId), inArray(turns.state, ["queued", "running"])))
          .limit(1)
      )[0];
      if (active) return undefined;
      const message = (
        await tx
          .select()
          .from(storyMessages)
          .where(
            and(
              eq(storyMessages.orgId, input.orgId),
              eq(storyMessages.projectId, input.projectId),
              eq(storyMessages.storyId, input.storyId),
              isNull(storyMessages.turnId),
            ),
          )
          .orderBy(asc(storyMessages.seq))
          .limit(1)
      )[0];
      if (!message) return undefined;
      if (message.requestedAgentName !== input.agent.name) {
        throw new StoryServiceError(
          "queued_agent_mismatch",
          `next message requires agent ${message.requestedAgentName}`,
        );
      }
      const created = (
        await tx
          .insert(turns)
          .values({
            id: newId("turn"),
            orgId: input.orgId,
            projectId: input.projectId,
            storyId: input.storyId,
            conversationId: message.conversationId,
            agentName: input.agent.name,
            manifestHash: input.agent.hash,
            manifest: input.agent,
            engine: input.agent.engine,
            model: input.agent.model,
            triggerType: queuedTrigger(message.requestedTrigger).type,
            triggerKey: queuedTrigger(message.requestedTrigger).key,
            scheduledFor: queuedTrigger(message.requestedTrigger).scheduledFor,
            createdBy: input.actor,
          })
          .returning()
      )[0];
      if (!created)
        throw new StoryServiceError("turn_create_failed", "turn could not be created", 500);
      await tx
        .update(storyMessages)
        .set({ turnId: created.id })
        .where(and(eq(storyMessages.orgId, input.orgId), eq(storyMessages.id, message.id)));
      await tx
        .update(stories)
        .set({ status: "working", activeAgentName: created.agentName, updatedAt: new Date() })
        .where(and(eq(stories.orgId, input.orgId), eq(stories.id, input.storyId)));
      return created;
    });
    if (turn) await this.onTurnQueued(turn);
    return turn;
  }

  /**
   * The story bundle. `evidence: false` leaves out the recent turn events and
   * the composed timeline so a reader that pages evidence separately does not
   * download bounded-but-large payloads it will not show.
   */
  async get(
    orgId: string,
    projectId: string,
    storyId: string,
    options: { evidence?: boolean } = {},
  ) {
    const includeEvidence = options.evidence !== false;
    const story = await scopedStory(this.db, orgId, projectId, storyId);
    const [
      workspace,
      conversation,
      recentTurns,
      artifacts,
      attention,
      recentEvents,
      recentEvidence,
    ] = await Promise.all([
      this.db
        .select()
        .from(workspaces)
        .where(and(eq(workspaces.orgId, orgId), eq(workspaces.storyId, storyId)))
        .orderBy(desc(workspaces.createdAt))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      this.db
        .select()
        .from(storyConversations)
        .where(and(eq(storyConversations.orgId, orgId), eq(storyConversations.storyId, storyId)))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      this.db
        .select()
        .from(turns)
        .where(and(eq(turns.orgId, orgId), eq(turns.storyId, storyId)))
        .orderBy(desc(turns.createdAt))
        .limit(20),
      this.db
        .select()
        .from(storyArtifacts)
        .where(and(eq(storyArtifacts.orgId, orgId), eq(storyArtifacts.storyId, storyId)))
        .orderBy(desc(storyArtifacts.createdAt)),
      this.db
        .select()
        .from(attentionItems)
        .where(and(eq(attentionItems.orgId, orgId), eq(attentionItems.storyId, storyId)))
        .orderBy(desc(attentionItems.createdAt))
        .limit(50),
      includeEvidence
        ? this.db
            .select()
            .from(turnEvents)
            .where(and(eq(turnEvents.orgId, orgId), eq(turnEvents.storyId, storyId)))
            .orderBy(desc(turnEvents.createdAt))
            .limit(100)
        : Promise.resolve(undefined),
      includeEvidence
        ? this.db
            .select()
            .from(storyEvidenceEvents)
            .where(
              and(eq(storyEvidenceEvents.orgId, orgId), eq(storyEvidenceEvents.storyId, storyId)),
            )
            .orderBy(desc(storyEvidenceEvents.occurredAt))
            .limit(200)
        : Promise.resolve(undefined),
    ]);
    return {
      story,
      workspace,
      conversation,
      turns: recentTurns,
      artifacts,
      attention,
      events: recentEvents ? recentEvents.reverse() : undefined,
      timeline:
        recentEvents && recentEvidence
          ? storyTimeline(story, recentEvents, recentEvidence, artifacts, attention)
          : undefined,
    };
  }

  /**
   * One page of the shared conversation with the people, agents, and runs
   * behind each message resolved. `messages` is the contiguous page; `related`
   * carries the older messages that complete a run already present on this
   * page (a request whose response made the page), so a reader never sees a
   * response without the request that produced it. Related messages appear
   * again on the page that reaches them; readers merge by id.
   */
  async conversationPage(
    orgId: string,
    projectId: string,
    storyId: string,
    options: { after?: number; before?: number; order?: "asc" | "desc"; limit?: number } = {},
  ) {
    const limit = Math.min(200, Math.max(1, options.limit ?? 50));
    const rows = await this.conversation(orgId, projectId, storyId, {
      ...options,
      limit: limit + 1,
    });
    const hasMore = rows.length > limit;
    const contiguous = rows.slice(0, limit);
    const oldest = contiguous.at(-1);
    const pageTurnIds = [...new Set(contiguous.map((row) => row.turnId).filter(isString))];
    const related =
      options.order === "desc" && hasMore && oldest && pageTurnIds.length > 0
        ? await this.db
            .select()
            .from(storyMessages)
            .where(
              and(
                eq(storyMessages.orgId, orgId),
                eq(storyMessages.projectId, projectId),
                eq(storyMessages.storyId, storyId),
                inArray(storyMessages.turnId, pageTurnIds),
                lt(storyMessages.seq, oldest.seq),
              ),
            )
            .orderBy(desc(storyMessages.seq))
            .limit(40)
        : [];
    const page = [...contiguous, ...related];
    const turnIds = [...new Set(page.map((row) => row.turnId).filter(isString))];
    const userIds = [
      ...new Set(
        page
          .map((row) => actorOf(row.actor))
          .filter((actor) => actor.type === "user")
          .map((actor) => actor.id),
      ),
    ];
    const [turnRows, userRows] = await Promise.all([
      turnIds.length === 0
        ? Promise.resolve([])
        : this.db
            .select()
            .from(turns)
            .where(
              and(
                eq(turns.orgId, orgId),
                eq(turns.projectId, projectId),
                eq(turns.storyId, storyId),
                inArray(turns.id, turnIds),
              ),
            ),
      userIds.length === 0
        ? Promise.resolve([])
        : this.db
            .select({
              id: users.id,
              name: users.name,
              email: users.email,
              avatarUrl: users.avatarUrl,
            })
            .from(users)
            .where(inArray(users.id, userIds)),
    ]);
    const turnById = new Map(turnRows.map((turn) => [turn.id, turn]));
    const userById = new Map(userRows.map((user) => [user.id, user]));
    const enrich = (row: typeof storyMessages.$inferSelect) => {
      const turn = row.turnId ? (turnById.get(row.turnId) ?? null) : null;
      const metadata = messageMetadata(row.metadata);
      return {
        ...row,
        author: conversationAuthor(row, turn, userById),
        turn: turn ? conversationTurn(turn) : null,
        content: conversationContent(row.role, metadata),
      };
    };
    const messages = contiguous.map(enrich);
    const edge = messages.at(-1);
    return {
      messages,
      related: related.map(enrich),
      hasMore,
      nextCursor: hasMore && edge ? edge.seq : null,
    };
  }

  /**
   * Readable activity for one run, newest first. Raw payloads are not returned
   * here; `turnEvent` serves a single stored event on demand.
   */
  async turnActivity(
    orgId: string,
    projectId: string,
    storyId: string,
    turnId: string,
    options: { before?: number; limit?: number } = {},
  ) {
    const turn = await scopedTurn(this.db, orgId, projectId, turnId);
    if (turn.storyId !== storyId)
      throw new StoryServiceError("turn_not_found", "turn not found", 404);
    const limit = Math.min(50, Math.max(1, options.limit ?? 10));
    const rows = await this.db
      .select()
      .from(turnEvents)
      .where(
        and(
          eq(turnEvents.orgId, orgId),
          eq(turnEvents.projectId, projectId),
          eq(turnEvents.storyId, storyId),
          eq(turnEvents.turnId, turnId),
          notInArray(turnEvents.type, [...ACTIVITY_NOISE_TYPES]),
          options.before === undefined ? undefined : lt(turnEvents.seq, options.before),
        ),
      )
      .orderBy(desc(turnEvents.seq))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(presentTurnEvent);
    return {
      turn: conversationTurn(turn),
      items,
      hasMore,
      nextCursor: hasMore ? (items.at(-1)?.seq ?? null) : null,
    };
  }

  async turnEvent(orgId: string, projectId: string, storyId: string, turnId: string, seq: number) {
    const turn = await scopedTurn(this.db, orgId, projectId, turnId);
    if (turn.storyId !== storyId)
      throw new StoryServiceError("turn_not_found", "turn not found", 404);
    const row = (
      await this.db
        .select()
        .from(turnEvents)
        .where(
          and(
            eq(turnEvents.orgId, orgId),
            eq(turnEvents.projectId, projectId),
            eq(turnEvents.storyId, storyId),
            eq(turnEvents.turnId, turnId),
            eq(turnEvents.seq, seq),
          ),
        )
        .limit(1)
    )[0];
    if (!row) throw new StoryServiceError("turn_event_not_found", "turn event not found", 404);
    return row;
  }

  /**
   * One newest-first page of the story timeline across facility, agent, Git,
   * GitHub, artifact, and attention evidence, keyed by occurrence time and id
   * so later inserts never shift an already-read page. Agent events are
   * summarized; their raw payloads stay behind `turnEvent`.
   */
  async timelinePage(
    orgId: string,
    projectId: string,
    storyId: string,
    options: { limit?: number; before?: { at: Date; id: string } } = {},
  ) {
    await scopedStory(this.db, orgId, projectId, storyId);
    const limit = Math.min(50, Math.max(1, options.limit ?? 10));
    const at = options.before?.at.toISOString();
    const cursor = options.before
      ? sql`and (occurred_at < ${at}::timestamptz or (occurred_at = ${at}::timestamptz and id < ${options.before.id}))`
      : sql``;
    const result = await this.db.execute<TimelineRow>(sql`
      with entries as (
        select 'story:' || id || ':created' as id, 'facility' as source, 'story.created' as type,
               null::text as turn_id,
               jsonb_build_object('provider', provider, 'externalId', external_id, 'title', title) as data,
               created_at as occurred_at, created_at as observed_at
          from stories
         where org_id = ${orgId} and project_id = ${projectId} and id = ${storyId}
        union all
        select 'turn:' || turn_id || ':' || seq, 'agent', type, turn_id, data, created_at, created_at
          from turn_events
         where org_id = ${orgId} and project_id = ${projectId} and story_id = ${storyId}
        union all
        select id, source, type, turn_id, data, occurred_at, observed_at
          from story_evidence_events
         where org_id = ${orgId} and project_id = ${projectId} and story_id = ${storyId}
        union all
        select 'artifact:' || id, 'artifact', 'artifact.recorded', turn_id,
               jsonb_build_object('id', id, 'kind', kind, 'label', label, 'uri', uri),
               created_at, created_at
          from story_artifacts
         where org_id = ${orgId} and project_id = ${projectId} and story_id = ${storyId}
        union all
        select 'attention:' || id, 'facility',
               case when status = 'open' then 'attention.opened' else 'attention.resolved' end,
               turn_id,
               jsonb_build_object('id', id, 'kind', kind, 'title', title, 'status', status, 'resolution', resolution),
               coalesce(resolved_at, created_at), updated_at
          from attention_items
         where org_id = ${orgId} and project_id = ${projectId} and story_id = ${storyId}
      )
      select id, source, type, turn_id, data, occurred_at, observed_at
        from entries
       where true ${cursor}
       order by occurred_at desc, id desc
       limit ${limit + 1}
    `);
    const rows = [...result];
    const hasMore = rows.length > limit;
    const entries = rows.slice(0, limit).map((row) => {
      const occurredAt = new Date(row.occurred_at);
      const observedAt = new Date(row.observed_at);
      const base = {
        id: row.id,
        source: row.source,
        type: row.type,
        turnId: row.turn_id,
        occurredAt,
        observedAt,
      };
      if (row.source === "agent" && row.turn_id) {
        const item = presentTurnEvent({
          turnId: row.turn_id,
          seq: Number(row.id.split(":").at(-1)),
          type: row.type,
          data: row.data,
          createdAt: occurredAt,
        });
        return {
          ...base,
          data: {
            kind: item.kind,
            title: item.title,
            text: item.text,
            truncated: item.truncated,
            size_bytes: item.size_bytes,
            seq: item.seq,
          },
        };
      }
      return { ...base, data: row.data };
    });
    const edge = entries.at(-1);
    return {
      entries,
      hasMore,
      nextCursor: hasMore && edge ? { at: edge.occurredAt, id: edge.id } : null,
    };
  }

  async conversation(
    orgId: string,
    projectId: string,
    storyId: string,
    options: { after?: number; before?: number; order?: "asc" | "desc"; limit?: number } = {},
  ) {
    await scopedStory(this.db, orgId, projectId, storyId);
    const after = Math.max(0, options.after ?? 0);
    const limit = Math.min(200, Math.max(1, options.limit ?? 50));
    return this.db
      .select()
      .from(storyMessages)
      .where(
        and(
          eq(storyMessages.orgId, orgId),
          eq(storyMessages.projectId, projectId),
          eq(storyMessages.storyId, storyId),
          sql`${storyMessages.seq} > ${after}`,
          options.before === undefined ? undefined : sql`${storyMessages.seq} < ${options.before}`,
        ),
      )
      .orderBy(options.order === "desc" ? desc(storyMessages.seq) : asc(storyMessages.seq))
      .limit(limit);
  }

  async list(orgId: string, projectId: string, status?: string) {
    return this.db
      .select()
      .from(stories)
      .where(
        and(
          eq(stories.orgId, orgId),
          eq(stories.projectId, projectId),
          status ? eq(stories.status, status) : undefined,
        ),
      )
      .orderBy(desc(stories.updatedAt));
  }

  async suspend(orgId: string, projectId: string, storyId: string) {
    const workspace = await this.activeWorkspace(orgId, projectId, storyId);
    if (!workspace || workspace.state === "destroyed") return this.get(orgId, projectId, storyId);
    await this.runtime.suspend(locatorFromRow(workspace));
    await this.db
      .update(workspaces)
      .set({ state: "sleeping", updatedAt: new Date() })
      .where(and(eq(workspaces.orgId, orgId), eq(workspaces.id, workspace.id)));
    await appendWorkspaceEvent(this.db, workspace.id, orgId, "workspace.suspended", {});
    return this.get(orgId, projectId, storyId);
  }

  async archive(orgId: string, projectId: string, storyId: string) {
    await this.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as FacilityDb;
      await lockStory(tx, orgId, projectId, storyId);
      const story = await scopedStory(tx, orgId, projectId, storyId);
      if (story.status !== "archived") {
        await tx
          .update(stories)
          .set({
            status: "archived",
            archivedFromStatus: story.status,
            archivedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(stories.id, storyId));
      }
    });
    await this.suspend(orgId, projectId, storyId);
    return this.get(orgId, projectId, storyId);
  }

  async restore(orgId: string, projectId: string, storyId: string) {
    const story = await scopedStory(this.db, orgId, projectId, storyId);
    if (story.deletedAt)
      throw new StoryServiceError("story_workspace_deleted", "story workspace was deleted");
    if (story.status === "archived") {
      await this.db
        .update(stories)
        .set({
          status: story.archivedFromStatus ?? "ready",
          archivedAt: null,
          archivedFromStatus: null,
          updatedAt: new Date(),
        })
        .where(and(eq(stories.orgId, orgId), eq(stories.id, storyId)));
    }
    const workspace = await this.activeWorkspace(orgId, projectId, storyId);
    if (workspace && workspace.state !== "destroyed") {
      const startedAt = performance.now();
      const handle = await this.runtime.wake(locatorFromRow(workspace));
      await this.db
        .update(workspaces)
        .set({
          state: "running",
          externalRef: handle.externalRef,
          volumeRef: handle.volumeRef,
          updatedAt: new Date(),
        })
        .where(eq(workspaces.id, workspace.id));
      await appendWorkspaceEvent(this.db, workspace.id, orgId, "workspace.ready", {
        provider: this.runtime.provider,
        computeRef: handle.computeRef,
        operation: "wake",
        durationMs: Math.round(performance.now() - startedAt),
      });
    }
    return this.get(orgId, projectId, storyId);
  }

  async markMerged(input: {
    orgId: string;
    projectId: string;
    storyId: string;
    pullRequestNumber: number;
    pullRequestUrl: string;
    branch: string;
  }) {
    await this.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as FacilityDb;
      await lockStory(tx, input.orgId, input.projectId, input.storyId);
      const story = await scopedStory(tx, input.orgId, input.projectId, input.storyId);
      if (
        story.pullRequestNumber !== null &&
        (story.pullRequestNumber !== input.pullRequestNumber ||
          (story.branch !== null && story.branch !== input.branch))
      ) {
        throw new StoryServiceError(
          "pull_request_mismatch",
          "merge event does not match the story pull request",
          404,
        );
      }
      await tx
        .update(stories)
        .set({
          status: "done",
          branch: input.branch,
          pullRequestNumber: input.pullRequestNumber,
          pullRequestUrl: input.pullRequestUrl,
          completedAt: story.completedAt ?? new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(stories.orgId, input.orgId), eq(stories.id, input.storyId)));
    });
    await this.suspend(input.orgId, input.projectId, input.storyId);
    return this.get(input.orgId, input.projectId, input.storyId);
  }

  async associatePullRequest(input: {
    orgId: string;
    projectId: string;
    storyId: string;
    pullRequestNumber: number;
    pullRequestUrl?: string;
    branch?: string;
  }) {
    await this.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as FacilityDb;
      await lockStory(tx, input.orgId, input.projectId, input.storyId);
      const story = await scopedStory(tx, input.orgId, input.projectId, input.storyId);
      if (
        (story.pullRequestNumber !== null && story.pullRequestNumber !== input.pullRequestNumber) ||
        (story.branch !== null && input.branch !== undefined && story.branch !== input.branch)
      ) {
        throw new StoryServiceError(
          "pull_request_mismatch",
          "pull request does not match the story branch",
          409,
        );
      }
      await tx
        .update(stories)
        .set({
          branch: story.branch ?? input.branch,
          pullRequestNumber: input.pullRequestNumber,
          pullRequestUrl: input.pullRequestUrl || story.pullRequestUrl,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(stories.orgId, input.orgId),
            eq(stories.projectId, input.projectId),
            eq(stories.id, input.storyId),
          ),
        );
    });
    return this.get(input.orgId, input.projectId, input.storyId);
  }

  async deleteWorkspace(input: {
    orgId: string;
    projectId: string;
    storyId: string;
    actor: StoryActor;
    confirm: boolean;
  }) {
    if (!input.confirm) {
      throw new StoryServiceError(
        "workspace_delete_confirmation_required",
        "set confirm=true to permanently delete the workspace, worktree, and native sessions",
        400,
      );
    }
    const workspace = await this.activeWorkspace(input.orgId, input.projectId, input.storyId, true);
    if (!workspace || workspace.state === "destroyed") {
      return this.get(input.orgId, input.projectId, input.storyId);
    }
    await this.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as FacilityDb;
      await lockStory(tx, input.orgId, input.projectId, input.storyId);
      await tx
        .update(workspaces)
        .set({ state: "deleting", updatedAt: new Date() })
        .where(and(eq(workspaces.orgId, input.orgId), eq(workspaces.id, workspace.id)));
      await tx
        .update(previewSessions)
        .set({ revokedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(previewSessions.orgId, input.orgId),
            eq(previewSessions.workspaceId, workspace.id),
          ),
        );
    });

    // This is intentionally the only lifecycle path that destroys provider
    // storage. Merge, archive, suspend, reconciliation, and schedule handling
    // call runtime.suspend instead.
    await this.runtime.destroy(locatorFromRow(workspace));
    const now = new Date();
    await this.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as FacilityDb;
      await tx
        .update(workspaces)
        .set({ state: "destroyed", destroyedAt: now, updatedAt: now })
        .where(and(eq(workspaces.orgId, input.orgId), eq(workspaces.id, workspace.id)));
      await tx
        .update(stories)
        .set({ status: "archived", deletedAt: now, archivedAt: now, updatedAt: now })
        .where(and(eq(stories.orgId, input.orgId), eq(stories.id, input.storyId)));
      await appendWorkspaceEvent(tx, workspace.id, input.orgId, "workspace.deleted", {
        actor: input.actor,
        volumeRef: workspace.volumeRef,
      });
    });
    return this.get(input.orgId, input.projectId, input.storyId);
  }

  private async activeWorkspace(
    orgId: string,
    projectId: string,
    storyId: string,
    includeDeleting = false,
  ) {
    await scopedStory(this.db, orgId, projectId, storyId);
    const states = includeDeleting
      ? ["creating", "running", "sleeping", "error", "deleting", "destroyed"]
      : ["creating", "running", "sleeping", "error"];
    return (
      await this.db
        .select()
        .from(workspaces)
        .where(
          and(
            eq(workspaces.orgId, orgId),
            eq(workspaces.projectId, projectId),
            eq(workspaces.storyId, storyId),
            inArray(workspaces.state, states),
          ),
        )
        .orderBy(desc(workspaces.createdAt))
        .limit(1)
    )[0];
  }

  private async markRuntimeFailure(
    storyId: string,
    workspaceId: string,
    input: StartStoryInput,
    error: unknown,
  ) {
    const detail = error instanceof Error ? error.message : String(error);
    await this.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as FacilityDb;
      await tx
        .update(workspaces)
        .set({ state: "error", error: detail, updatedAt: new Date() })
        .where(and(eq(workspaces.orgId, input.orgId), eq(workspaces.id, workspaceId)));
      await tx
        .update(stories)
        .set({ status: "attention", updatedAt: new Date() })
        .where(and(eq(stories.orgId, input.orgId), eq(stories.id, storyId)));
      await tx.insert(attentionItems).values({
        id: newId("attn"),
        orgId: input.orgId,
        projectId: input.projectId,
        storyId,
        kind: "runtime_error",
        title: "Workspace could not start",
        detail,
      });
    });
    await appendWorkspaceEvent(this.db, workspaceId, input.orgId, "workspace.provider_error", {
      operation: "create",
      error: detail.slice(0, 8_000),
    });
  }
}

function storyTimeline(
  story: typeof stories.$inferSelect,
  events: Array<typeof turnEvents.$inferSelect>,
  evidence: Array<typeof storyEvidenceEvents.$inferSelect>,
  artifacts: Array<typeof storyArtifacts.$inferSelect>,
  attention: Array<typeof attentionItems.$inferSelect>,
) {
  const rows = [
    {
      id: `story:${story.id}:created`,
      source: "facility",
      type: "story.created",
      turnId: null,
      data: { provider: story.provider, externalId: story.externalId, title: story.title },
      occurredAt: story.createdAt,
      observedAt: story.createdAt,
    },
    ...events.map((event) => ({
      id: `turn:${event.turnId}:${event.seq}`,
      source: "agent",
      type: event.type,
      turnId: event.turnId,
      data: event.data,
      occurredAt: event.createdAt,
      observedAt: event.createdAt,
    })),
    ...evidence.map((event) => ({
      id: event.id,
      source: event.source,
      type: event.type,
      turnId: event.turnId,
      data: event.data,
      occurredAt: event.occurredAt,
      observedAt: event.observedAt,
    })),
    ...artifacts.map((artifact) => ({
      id: `artifact:${artifact.id}`,
      source: "artifact",
      type: "artifact.recorded",
      turnId: artifact.turnId,
      data: {
        id: artifact.id,
        kind: artifact.kind,
        label: artifact.label,
        uri: artifact.uri,
      },
      occurredAt: artifact.createdAt,
      observedAt: artifact.createdAt,
    })),
    ...attention.map((item) => ({
      id: `attention:${item.id}`,
      source: "facility",
      type: item.status === "open" ? "attention.opened" : "attention.resolved",
      turnId: item.turnId,
      data: {
        id: item.id,
        kind: item.kind,
        title: item.title,
        status: item.status,
        resolution: item.resolution,
      },
      occurredAt: item.resolvedAt ?? item.createdAt,
      observedAt: item.updatedAt,
    })),
  ];
  return rows
    .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime())
    .slice(-300);
}

type TimelineRow = {
  id: string;
  source: string;
  type: string;
  turn_id: string | null;
  data: Record<string, unknown>;
  occurred_at: string | Date;
  observed_at: string | Date;
};

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function actorOf(value: unknown): { type: string; id: string } {
  const actor =
    value && typeof value === "object" ? (value as { type?: unknown; id?: unknown }) : {};
  return {
    type: typeof actor.type === "string" ? actor.type : "unknown",
    id: typeof actor.id === "string" ? actor.id : "",
  };
}

function messageMetadata(value: unknown): StoryMessageMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return {
    content: record.content === "final_response" ? "final_response" : undefined,
    engine: typeof record.engine === "string" ? record.engine : undefined,
    model: typeof record.model === "string" ? record.model : undefined,
    progressMessages:
      typeof record.progressMessages === "number" && Number.isSafeInteger(record.progressMessages)
        ? record.progressMessages
        : undefined,
  };
}

function conversationContent(role: string, metadata: StoryMessageMetadata): ConversationContent {
  if (role !== "agent") return { kind: "text", progressMessages: null, reportedModel: null };
  if (metadata.content === "final_response") {
    return {
      kind: "final_response",
      progressMessages: metadata.progressMessages ?? null,
      reportedModel: metadata.model ?? null,
    };
  }
  return { kind: "combined_transcript", progressMessages: null, reportedModel: null };
}

function conversationTurn(turn: typeof turns.$inferSelect): ConversationTurn {
  return {
    id: turn.id,
    agentName: turn.agentName,
    engine: turn.engine,
    model: turn.model,
    state: turn.state,
    error: turn.error,
    triggerType: turn.triggerType,
    createdAt: turn.createdAt,
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
  };
}

/**
 * Who a message is from, for display. Agent responses are attributed to the
 * agent that ran, never to a person; unknown actors keep their raw identity
 * rather than being assigned one.
 */
function conversationAuthor(
  row: typeof storyMessages.$inferSelect,
  turn: typeof turns.$inferSelect | null,
  userById: Map<
    string,
    { id: string; name: string | null; email: string; avatarUrl: string | null }
  >,
): ConversationAuthor {
  const actor = actorOf(row.actor);
  if (row.role === "agent") {
    return {
      kind: "agent",
      id: actor.id,
      name: turn?.agentName ?? row.requestedAgentName ?? "agent",
      handle: null,
      avatarUrl: null,
    };
  }
  if (actor.type === "user") {
    const user = userById.get(actor.id);
    return {
      kind: "user",
      id: actor.id,
      name: user?.name?.trim() || (user ? user.email.split("@")[0] || user.email : actor.id),
      handle: null,
      avatarUrl: user?.avatarUrl ?? null,
    };
  }
  const github = /^github:(.+)$/.exec(actor.id);
  if (github?.[1]) {
    const login = github[1];
    return {
      kind: "github",
      id: actor.id,
      name: login,
      handle: `@${login}`,
      avatarUrl: `https://avatars.githubusercontent.com/${encodeURIComponent(login)}?s=64`,
    };
  }
  const schedule = /^schedule:(.+)$/.exec(actor.id);
  if (schedule?.[1]) {
    return {
      kind: "schedule",
      id: actor.id,
      name: `Schedule ${schedule[1]}`,
      handle: null,
      avatarUrl: null,
    };
  }
  if (actor.type === "service") {
    return { kind: "service", id: actor.id, name: "API client", handle: null, avatarUrl: null };
  }
  return {
    kind: "system",
    id: actor.id,
    name: actor.id || "System",
    handle: null,
    avatarUrl: null,
  };
}

function validateStartInput(input: StartStoryInput) {
  if (!input.externalId.trim() || input.externalId.length > 240) {
    throw new StoryServiceError("story_external_id_invalid", "story external id is invalid", 400);
  }
  if (!input.title.trim() || input.title.length > 500) {
    throw new StoryServiceError("story_title_invalid", "story title is invalid", 400);
  }
}

function lifecycleStatusAfterTurn(
  current: typeof stories.$inferSelect.status,
  fallback: "ready" | "working" | "attention",
) {
  return current === "done" || current === "archived" ? current : fallback;
}

async function scopedStory(db: FacilityDb, orgId: string, projectId: string, storyId: string) {
  const story = (
    await db
      .select()
      .from(stories)
      .where(
        and(eq(stories.orgId, orgId), eq(stories.projectId, projectId), eq(stories.id, storyId)),
      )
      .limit(1)
  )[0];
  if (!story) throw new StoryServiceError("story_not_found", "story not found", 404);
  return story;
}

async function scopedTurn(db: FacilityDb, orgId: string, projectId: string, turnId: string) {
  const turn = (
    await db
      .select()
      .from(turns)
      .where(and(eq(turns.orgId, orgId), eq(turns.projectId, projectId), eq(turns.id, turnId)))
      .limit(1)
  )[0];
  if (!turn) throw new StoryServiceError("turn_not_found", "turn not found", 404);
  return turn;
}

async function lockStory(db: FacilityDb, orgId: string, projectId: string, storyId: string) {
  await scopedStory(db, orgId, projectId, storyId);
  await lockIdentity(db, `${orgId}:${projectId}:${storyId}`);
}

async function lockIdentity(db: FacilityDb, identity: string) {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`facility:story:${identity}`}))`);
}

async function allocateMessageSequence(db: FacilityDb, conversationId: string): Promise<number> {
  const row = (
    await db
      .update(storyConversations)
      .set({
        nextSeq: sql`${storyConversations.nextSeq} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(storyConversations.id, conversationId))
      .returning({ nextSeq: storyConversations.nextSeq })
  )[0];
  if (!row)
    throw new StoryServiceError("conversation_not_found", "story conversation not found", 404);
  return row.nextSeq - 1;
}

function workspaceConfiguration(input: Omit<CreateWorkspace, "id">) {
  return {
    image: input.image,
    variables: {
      ...(input.environment ?? {}),
      FACILITY_PREVIEW_GATEWAY_TOKEN:
        input.environment?.FACILITY_PREVIEW_GATEWAY_TOKEN ?? randomBytes(32).toString("base64url"),
    },
    ports: input.ports ?? [],
    resources: input.resources ?? { cpu: 2, memoryMb: 4_096 },
  };
}

function workspaceInput(row: typeof workspaces.$inferSelect): Omit<CreateWorkspace, "id"> {
  const value = row.environment as {
    image?: unknown;
    variables?: unknown;
    ports?: unknown;
    resources?: unknown;
  };
  if (typeof value.image !== "string") {
    throw new StoryServiceError(
      "workspace_configuration_invalid",
      "workspace image is missing",
      500,
    );
  }
  return {
    image: value.image,
    environment: isStringRecord(value.variables) ? value.variables : {},
    ports: Array.isArray(value.ports) ? (value.ports as CreateWorkspace["ports"]) : [],
    resources:
      value.resources && typeof value.resources === "object"
        ? (value.resources as CreateWorkspace["resources"])
        : undefined,
  };
}

function locatorFromRow(row: typeof workspaces.$inferSelect): WorkspaceLocator {
  if (!row.externalRef) {
    throw new StoryServiceError(
      "workspace_reference_missing",
      "workspace compute reference is missing",
      500,
    );
  }
  return {
    id: row.id,
    ...workspaceInput(row),
    externalRef: row.externalRef,
    volumeRef: row.volumeRef,
  };
}

function pendingVolumeRef(provider: string, workspaceId: string) {
  return `${provider}:pending:${workspaceId}`;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.values(value).every((entry) => typeof entry === "string"),
  );
}

function queuedTrigger(value: unknown): {
  type: "manual" | "mcp" | "ui" | "github" | "schedule";
  key?: string;
  scheduledFor?: Date;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { type: "manual" };
  const trigger = value as { type?: unknown; key?: unknown; scheduledFor?: unknown };
  const type = ["manual", "mcp", "ui", "github", "schedule"].includes(String(trigger.type))
    ? (trigger.type as "manual" | "mcp" | "ui" | "github" | "schedule")
    : "manual";
  const scheduledFor = trigger.scheduledFor ? new Date(String(trigger.scheduledFor)) : undefined;
  return {
    type,
    key: typeof trigger.key === "string" ? trigger.key : undefined,
    scheduledFor:
      scheduledFor && Number.isFinite(scheduledFor.getTime()) ? scheduledFor : undefined,
  };
}
