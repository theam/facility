import { newId } from "@facility/core";
import {
  agentDefs,
  conversationMessages,
  conversations,
  insertAuditEvent,
  runEvents,
  runs,
} from "@facility/db";
import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withBuilderPlanPreflight } from "../../builder-plan-policy.js";
import { ApiError, notFound } from "../../errors.js";
import {
  assertBareRowProjectScope,
  assertProjectScope,
  ConversationMessageSchema,
  ConversationSchema,
  IdParams,
  principal,
  type V1RouteContext,
} from "./shared.js";

const CreateConversationBody = z
  .object({
    agentDefId: z.string().optional(),
    title: z.string().optional(),
  })
  .default({});

const ConversationListItemSchema = ConversationSchema.extend({
  lastMessage: ConversationMessageSchema.nullable(),
});

const ConversationDetailSchema = z.object({
  conversation: ConversationSchema,
  messages: z.array(ConversationMessageSchema),
});

const CreateConversationMessageBody = z.object({ body: z.string().min(1) });
const CreateConversationMessageResponse = z.object({
  message: ConversationMessageSchema,
  runId: z.string(),
});

export async function registerConversationsRoutes(app: FastifyInstance, context: V1RouteContext) {
  const { db } = context;

  app.post(
    "/v1/projects/:projectId/conversations",
    {
      config: { permission: "runs:trigger" },
      schema: {
        params: IdParams,
        body: CreateConversationBody,
        response: { 200: ConversationSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId } = request.params as { projectId: string };
      const body = (request.body ?? {}) as { agentDefId?: string; title?: string };
      assertProjectScope(p, projectId);
      const agent = body.agentDefId
        ? await loadAgent(p.orgId, projectId, body.agentDefId)
        : await loadProjectOwnerAgent(p.orgId, projectId);
      if (!agent) {
        throw new ApiError(400, "no_owner_agent", "Project has no project-owner agent");
      }
      if (agent.engine !== "claude_code") {
        throw new ApiError(409, "engine_unsupported", "Conversation agents must use Claude Code");
      }
      const conversation = (
        await db
          .insert(conversations)
          .values({
            id: newId("evt"),
            orgId: p.orgId,
            projectId,
            agentDefId: agent.id,
            title: body.title,
            createdBy: { type: p.type, id: p.id },
          })
          .returning()
      )[0];
      if (!conversation) {
        throw new ApiError(500, "conversation_create_failed", "Conversation could not be created");
      }
      await insertAuditEvent(db, {
        orgId: p.orgId,
        projectId,
        actor: { type: p.type, id: p.id },
        action: "conversation.created",
        target: { type: "conversation", id: conversation.id },
        payload: { agentDefId: agent.id },
      });
      return conversation;
    },
  );

  app.get(
    "/v1/projects/:projectId/conversations",
    {
      config: { permission: "runs:read" },
      schema: {
        params: IdParams,
        response: { 200: z.array(ConversationListItemSchema) },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId } = request.params as { projectId: string };
      assertProjectScope(p, projectId);
      const rows = await db
        .select()
        .from(conversations)
        .where(and(eq(conversations.orgId, p.orgId), eq(conversations.projectId, projectId)))
        .orderBy(desc(conversations.updatedAt));
      const items = [];
      for (const conversation of rows) {
        const lastMessage = (
          await db
            .select()
            .from(conversationMessages)
            .where(
              and(
                eq(conversationMessages.orgId, p.orgId),
                eq(conversationMessages.conversationId, conversation.id),
              ),
            )
            .orderBy(desc(conversationMessages.seq))
            .limit(1)
        )[0];
        items.push({ ...conversation, lastMessage: lastMessage ?? null });
      }
      return items;
    },
  );

  app.get(
    "/v1/conversations/:conversationId",
    {
      config: { permission: "runs:read" },
      schema: {
        params: z.object({ conversationId: z.string() }),
        response: { 200: ConversationDetailSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { conversationId } = request.params as { conversationId: string };
      const conversation = await loadConversation(p.orgId, conversationId);
      assertBareRowProjectScope(p, conversation.projectId, "Conversation not found");
      const messages = await db
        .select()
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.orgId, p.orgId),
            eq(conversationMessages.conversationId, conversationId),
          ),
        )
        .orderBy(conversationMessages.seq);
      return { conversation, messages };
    },
  );

  app.post(
    "/v1/conversations/:conversationId/messages",
    {
      config: { permission: "runs:trigger" },
      schema: {
        params: z.object({ conversationId: z.string() }),
        body: CreateConversationMessageBody,
        response: { 200: CreateConversationMessageResponse },
      },
    },
    async (request) => {
      const p = principal(request);
      const { conversationId } = request.params as { conversationId: string };
      const body = request.body as { body: string };
      const conversation = await loadConversation(p.orgId, conversationId);
      assertBareRowProjectScope(p, conversation.projectId, "Conversation not found");
      if (conversation.kind === "assistant") {
        throw new ApiError(
          409,
          "assistant_thread",
          "Assistant threads take turns through POST /v1/projects/:projectId/ask",
        );
      }
      if (conversation.status === "running") {
        throw new ApiError(409, "turn_in_flight", "Conversation already has a turn in flight");
      }
      const agent = await loadAgent(p.orgId, conversation.projectId, conversation.agentDefId);
      if (!agent) throw new ApiError(409, "conversation_agent_not_found", "Agent not found");
      const result = await withBuilderPlanPreflight(
        db,
        {
          orgId: p.orgId,
          projectId: conversation.projectId,
          mode: "conversation",
          agentDefId: agent.id,
          trigger: { type: "conversation", conversationId, message: body.body },
          actor: { type: p.type, id: p.id },
          source: "rest_conversation_message",
        },
        async (tx, admission) => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${conversationId}))`);
          const claimed = (
            await tx
              .update(conversations)
              .set({ status: "running", updatedAt: new Date() })
              .where(
                and(
                  eq(conversations.orgId, p.orgId),
                  eq(conversations.id, conversationId),
                  eq(conversations.status, "idle"),
                ),
              )
              .returning()
          )[0];
          if (!claimed) return null;
          const rows = await tx
            .select({ max: sql<number>`coalesce(max(seq), 0)` })
            .from(conversationMessages)
            .where(eq(conversationMessages.conversationId, conversationId));
          const seq = Number(rows[0]?.max ?? 0) + 1;
          const message = (
            await tx
              .insert(conversationMessages)
              .values({
                id: newId("evt"),
                orgId: p.orgId,
                conversationId,
                seq,
                role: "user",
                body: body.body,
              })
              .returning()
          )[0];
          const trigger: Record<string, unknown> = {
            type: "conversation",
            conversationId,
            message: body.body,
          };
          if (claimed.engineSessionId && claimed.lastRunId) trigger.resumeOf = claimed.lastRunId;
          const run = (
            await tx
              // builder-plan-preflight: rest_conversation_message
              .insert(runs)
              .values({
                id: newId("run"),
                orgId: p.orgId,
                projectId: claimed.projectId,
                agentDefId: claimed.agentDefId,
                mode: admission.mode,
                engine: "claude_code",
                trigger,
                createdBy: { type: p.type, id: p.id },
              })
              .returning()
          )[0];
          if (!message || !run) throw new Error("conversation_turn_create_failed");
          // Pin the run that OWNS this running turn. Both finalize paths
          // (finishConversationTurn / releaseConversationOnFailure) require the
          // finishing run to be this one — so a forged run carrying another
          // conversation's id can't release or append to a thread it doesn't own.
          await tx
            .update(conversations)
            .set({ lastRunId: run.id, updatedAt: new Date() })
            .where(and(eq(conversations.orgId, p.orgId), eq(conversations.id, conversationId)));
          await tx.insert(runEvents).values({
            orgId: p.orgId,
            runId: run.id,
            seq: 1,
            type: "queued",
            data: { queue: "runs.dispatch" },
          });
          return { message, run };
        },
      );
      if (!result) {
        throw new ApiError(409, "turn_in_flight", "Conversation already has a turn in flight");
      }
      await app.enqueue("runs.dispatch", { runId: result.run.id, orgId: p.orgId });
      await insertAuditEvent(db, {
        orgId: p.orgId,
        projectId: result.run.projectId,
        actor: { type: p.type, id: p.id },
        action: "conversation.message_created",
        target: { type: "conversation", id: conversationId },
        payload: { runId: result.run.id, messageId: result.message.id },
      });
      return { message: result.message, runId: result.run.id };
    },
  );

  async function loadAgent(orgId: string, projectId: string, agentDefId: string) {
    return (
      await db
        .select()
        .from(agentDefs)
        .where(
          and(
            eq(agentDefs.orgId, orgId),
            eq(agentDefs.projectId, projectId),
            eq(agentDefs.id, agentDefId),
            eq(agentDefs.enabled, true),
          ),
        )
        .limit(1)
    )[0];
  }

  async function loadProjectOwnerAgent(orgId: string, projectId: string) {
    return (
      await db
        .select()
        .from(agentDefs)
        .where(
          and(
            eq(agentDefs.orgId, orgId),
            eq(agentDefs.projectId, projectId),
            eq(agentDefs.name, "project-owner"),
            eq(agentDefs.enabled, true),
          ),
        )
        .limit(1)
    )[0];
  }

  async function loadConversation(orgId: string, conversationId: string) {
    const conversation = (
      await db
        .select()
        .from(conversations)
        .where(and(eq(conversations.orgId, orgId), eq(conversations.id, conversationId)))
        .limit(1)
    )[0];
    if (!conversation) throw notFound("Conversation not found");
    return conversation;
  }
}
