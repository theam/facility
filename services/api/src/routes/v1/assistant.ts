import { newId } from "@facility/core";
import {
  agentDefs,
  conversationMessages,
  conversations,
  insertAuditEvent,
  projects,
  runs,
} from "@facility/db";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type AssistantModelDriver, runAssistantTurn } from "../../assistant/loop.js";
import { withBuilderPlanPreflight } from "../../builder-plan-policy.js";
import { ApiError, notFound } from "../../errors.js";
import { terminalStatus } from "../../sandbox/state.js";
import { assertProjectScope, IdParams, principal, type V1RouteContext } from "./shared.js";

const AskBody = z.object({
  // Roomy enough for a pasted meeting transcript plus commentary.
  body: z.string().min(1).max(120_000),
  conversationId: z.string().optional(),
});

const AskResponse = z.object({
  conversationId: z.string(),
  messageId: z.string(),
  runId: z.string(),
});

/** A running thread whose turn made no progress for this long is stale. */
const STALE_TURN_MS = 10 * 60_000;

export async function registerAssistantRoutes(app: FastifyInstance, context: V1RouteContext) {
  const { db, config } = context;

  app.post(
    "/v1/projects/:projectId/ask",
    {
      config: { permission: "runs:trigger" },
      schema: {
        params: IdParams,
        body: AskBody,
        response: { 200: AskResponse },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId } = request.params as { projectId: string };
      assertProjectScope(p, projectId);
      const body = request.body as { body: string; conversationId?: string };

      const project = (
        await db
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(and(eq(projects.orgId, p.orgId), eq(projects.id, projectId)))
          .limit(1)
      )[0];
      if (!project) throw notFound("Project not found");

      const owner = (
        await db
          .select()
          .from(agentDefs)
          .where(
            and(
              eq(agentDefs.orgId, p.orgId),
              eq(agentDefs.projectId, projectId),
              eq(agentDefs.name, "project-owner"),
              eq(agentDefs.enabled, true),
            ),
          )
          .limit(1)
      )[0];
      if (!owner) {
        throw new ApiError(400, "no_owner_agent", "Project has no project-owner agent");
      }
      const policyTrigger = {
        type: "conversation",
        ...(body.conversationId ? { conversationId: body.conversationId } : {}),
        message: body.body,
      };
      const ownerModel = modelFrom(owner.model) ?? "claude-sonnet-5";

      let conversationId = body.conversationId;
      if (conversationId) {
        const existing = (
          await db
            .select()
            .from(conversations)
            .where(and(eq(conversations.orgId, p.orgId), eq(conversations.id, conversationId)))
            .limit(1)
        )[0];
        if (!existing || existing.projectId !== projectId) throw notFound("Conversation not found");
        if (existing.kind !== "assistant") {
          throw new ApiError(409, "sandbox_thread", "This thread uses the sandbox message route");
        }
      } else {
        // Provisional title from the opening message — the loop refines it
        // with a model-generated one once the first reply lands.
        const firstLine = body.body
          .split("\n")
          .map((line) => line.trim())
          .find(Boolean);
        const provisionalTitle = firstLine
          ? firstLine.length > 60
            ? `${firstLine.slice(0, 57)}…`
            : firstLine
          : null;
        const created = (
          await db
            .insert(conversations)
            .values({
              id: newId("evt"),
              orgId: p.orgId,
              projectId,
              agentDefId: owner.id,
              kind: "assistant",
              title: provisionalTitle,
              createdBy: { type: p.type, id: p.id },
            })
            .returning()
        )[0];
        if (!created) {
          throw new ApiError(500, "conversation_create_failed", "Could not create the thread");
        }
        conversationId = created.id;
      }

      const result = await withBuilderPlanPreflight(
        db,
        {
          orgId: p.orgId,
          projectId,
          mode: "assistant",
          agentDefId: owner.id,
          trigger: policyTrigger,
          actor: { type: p.type, id: p.id },
          source: "assistant_conversation",
        },
        async (tx, admission) => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${conversationId}))`);
          const thread = (
            await tx
              .select()
              .from(conversations)
              .where(and(eq(conversations.orgId, p.orgId), eq(conversations.id, conversationId)))
              .limit(1)
          )[0];
          if (!thread) throw notFound("Conversation not found");
          if (thread.status === "running") {
            // Self-heal: a turn whose pinned run already ended (or died without a
            // trace — API crash before the reconcile sweep) must not deadlock the
            // thread. Anything genuinely in flight stays locked.
            const pinned = thread.lastRunId
              ? (
                  await tx
                    .select({ status: runs.status, startedAt: runs.startedAt })
                    .from(runs)
                    .where(and(eq(runs.orgId, p.orgId), eq(runs.id, thread.lastRunId)))
                    .limit(1)
                )[0]
              : undefined;
            const stale =
              !pinned ||
              terminalStatus(pinned.status) ||
              (pinned.startedAt !== null &&
                Date.now() - pinned.startedAt.getTime() > STALE_TURN_MS);
            if (!stale) {
              throw new ApiError(409, "turn_in_flight", "The thread already has a turn in flight");
            }
          }
          await tx
            .update(conversations)
            .set({ status: "running", updatedAt: new Date() })
            .where(and(eq(conversations.orgId, p.orgId), eq(conversations.id, conversationId)));
          const seqRows = await tx
            .select({ max: sql<number>`coalesce(max(seq), 0)` })
            .from(conversationMessages)
            .where(eq(conversationMessages.conversationId, conversationId));
          const seq = Number(seqRows[0]?.max ?? 0) + 1;
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
          // status starts at "running" — never "queued": the reconcile backstop
          // re-enqueues stale queued runs into runs.dispatch, which would launch
          // a sandbox for what is an in-process turn.
          const run = (
            await tx
              // builder-plan-preflight: assistant_conversation
              .insert(runs)
              .values({
                id: newId("run"),
                orgId: p.orgId,
                projectId,
                agentDefId: owner.id,
                mode: admission.mode,
                engine: "inline",
                status: "running",
                startedAt: new Date(),
                trigger: { type: "conversation", conversationId, message: body.body },
                createdBy: { type: p.type, id: p.id },
              })
              .returning()
          )[0];
          if (!message || !run) throw new Error("assistant_turn_create_failed");
          await tx
            .update(conversations)
            .set({ lastRunId: run.id, updatedAt: new Date() })
            .where(and(eq(conversations.orgId, p.orgId), eq(conversations.id, conversationId)));
          return { message, run };
        },
      );

      await insertAuditEvent(db, {
        orgId: p.orgId,
        projectId,
        actor: { type: p.type, id: p.id },
        action: "conversation.message_created",
        target: { type: "conversation", id: conversationId },
        payload: { runId: result.run.id, messageId: result.message.id, kind: "assistant" },
      });

      const driver = (app as FastifyInstance & { assistantModelDriver?: AssistantModelDriver })
        .assistantModelDriver;
      // Detached on purpose: the response returns immediately; progress streams
      // over the existing run-events SSE channel.
      void runAssistantTurn({
        app,
        config,
        db,
        runId: result.run.id,
        orgId: p.orgId,
        projectId,
        projectName: project.name,
        conversationId,
        agentModel: ownerModel,
        userHeaders: {
          cookie: headerValue(request.headers.cookie),
          authorization: headerValue(request.headers.authorization),
        },
        ...(driver ? { driver } : {}),
      }).catch((error) => {
        request.log.error({ err: error, runId: result.run.id }, "assistant turn crashed");
      });

      return { conversationId, messageId: result.message.id, runId: result.run.id };
    },
  );
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.join("; ");
  return value ?? undefined;
}

function modelFrom(value: unknown): string | undefined {
  const model =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { model?: unknown }).model
      : undefined;
  return typeof model === "string" && model ? model : undefined;
}
