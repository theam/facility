import { randomUUID } from "node:crypto";
import { can } from "@facility/core";
import { attentionItems, turnEvents, users } from "@facility/db";
import { and, asc, eq, gt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { decodeJwt } from "jose";
import { z } from "zod";
import { ApiError } from "../../errors.js";
import { BudgetPolicyError } from "../../insights/costs.js";
import {
  assertSessionPrincipal,
  interactiveState,
  type SessionScope,
} from "../../sessions/service.js";
import type { AppConfig } from "../../types.js";
import type { WorkspaceTerminal } from "../../workspaces/runtime.js";
import { principal } from "./shared.js";

const Params = z.object({ projectId: z.string(), storyId: z.string() });
const Query = z.object({
  client_id: z.uuid(),
  mode: z.enum(["attach", "observe"]).default("attach"),
});
const Control = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("resize"),
      cols: z.number().int().min(1).max(1000),
      rows: z.number().int().min(1).max(1000),
    })
    .strict(),
  z
    .object({
      type: z.literal("takeover"),
      turnId: z.string().min(1).max(100),
      confirm: z.literal(true),
    })
    .strict(),
  z.object({ type: z.literal("leave") }).strict(),
  z.object({ type: z.literal("ping") }).strict(),
]);

export async function registerStorySessionRoutes(app: FastifyInstance, config: AppConfig) {
  const sessions = app.storyDomain.sessions;
  app.get(
    "/v1/projects/:projectId/session-holders",
    {
      config: { permission: "projects:read" },
      schema: {
        params: z.object({ projectId: z.string() }),
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(1000).default(100),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        operationId: "listProjectSessionHolders",
      },
    },
    async (request, reply) => {
      reply.header("cache-control", "private, no-store");
      const query = request.query as { limit: number; offset: number };
      return sessions.projectHolders(
        principal(request).orgId,
        (request.params as { projectId: string }).projectId,
        query.offset,
        query.limit,
      );
    },
  );
  app.get(
    "/v1/projects/:projectId/workspace-stories/:storyId/session/status",
    {
      config: { permission: "projects:read" },
      schema: { params: Params, operationId: "getStorySessionHolder" },
    },
    async (request, reply) => {
      reply.header("cache-control", "private, no-store");
      return sessions.status({
        orgId: principal(request).orgId,
        ...(request.params as z.infer<typeof Params>),
      });
    },
  );

  app.get(
    "/v1/projects/:projectId/workspace-stories/:storyId/session",
    {
      websocket: true,
      config: { permission: "sessions:observe" },
      schema: { params: Params, querystring: Query },
      preValidation: async (request) => {
        if (
          request.headers.origin &&
          ![config.publicUrl, config.webUrl ?? config.publicUrl]
            .map((value) => new URL(value).origin)
            .includes(request.headers.origin)
        )
          throw new ApiError(403, "session_origin_forbidden", "Session origin is not allowed");
        await assertSessionPrincipal(app.facilityDb, principal(request), "sessions:observe");
      },
    },
    (socket, request) => {
      const actor = principal(request);
      const scope: SessionScope = {
        orgId: actor.orgId,
        ...(request.params as z.infer<typeof Params>),
      };
      const query = request.query as z.infer<typeof Query>;
      const client = { id: query.client_id, transportId: randomUUID() };
      const enteredAt = Date.now();
      let terminal: WorkspaceTerminal | undefined;
      let terminalTurnId: string | undefined;
      let watchedTurnId: string | undefined;
      let seq = 0;
      let cols = 100;
      let rows = 30;
      let closed = false;
      let busy = false;
      let initialized = false;
      let eligibleToWait = true;
      let previousHolder = "";
      let ownedTurnId: string | undefined;
      let controls = Promise.resolve();
      let pendingInputBytes = 0;
      let pendingInputFrames = 0;
      const send = (value: unknown) => {
        if (socket.readyState === 1 && socket.bufferedAmount < 1024 * 1024)
          socket.send(JSON.stringify(value));
        else if (socket.bufferedAmount >= 1024 * 1024)
          socket.close(1013, "Slow session reader; reconnect to continue");
      };
      const error = (cause: unknown) => {
        send({
          type: "error",
          code:
            cause instanceof ApiError || cause instanceof BudgetPolicyError
              ? cause.code
              : "session_unavailable",
          message:
            cause instanceof ApiError || cause instanceof BudgetPolicyError
              ? cause.message
              : "Session operation failed; workspace and conversation were retained",
        });
        if (cause instanceof BudgetPolicyError) socket.close(1008, "Budget does not allow entry");
      };
      const dropTerminal = () => {
        terminal?.close();
        terminal = undefined;
        terminalTurnId = undefined;
      };

      async function update() {
        if (closed || busy) return;
        busy = true;
        try {
          await assertSessionPrincipal(app.facilityDb, actor, "sessions:observe");
          const current = await sessions.status(scope);
          const controlling =
            query.mode === "attach" &&
            current.supported &&
            can(actor.permissions, "sessions:control");
          if (!initialized && current.holder?.kind === "person") eligibleToWait = false;
          const waiting = controlling && eligibleToWait && current.holder?.kind !== "person";
          await sessions.lease(scope, actor, client, waiting, initialized);
          if (
            controlling &&
            current.holder?.kind === "person" &&
            current.holder.userId === actor.userId
          )
            await sessions.reattach(scope, actor, client);
          if (closed) {
            await sessions.disconnect(scope, client);
            return;
          }
          if (!initialized) {
            initialized = true;
            await request.audit("session.observe", { type: "story", id: scope.storyId });
            if (!current.supported)
              send({
                type: "unsupported",
                message:
                  "Interactive sessions are not supported yet on this provider; watching Facility turns read-only",
              });
          }
          if (waiting && !current.holder) await sessions.enter(scope, actor, client);
          await sessions.tick(scope);
          const status = await sessions.status(scope);
          const active = await sessions.holder(scope);
          const state = active && interactiveState(active);
          const writer = Boolean(
            active && controlling && (await sessions.owns(scope, actor, client, active.id)),
          );
          if (writer) ownedTurnId = active!.id;
          let holderReason: string | undefined;
          if (ownedTurnId && active?.id !== ownedTurnId) {
            const ended = (
              await app.facilityDb
                .select()
                .from(turnEvents)
                .where(
                  and(eq(turnEvents.turnId, ownedTurnId), eq(turnEvents.type, "session.closed")),
                )
                .limit(1)
            )[0];
            const detail = ended?.data as { reason?: string; by?: string } | undefined;
            if (detail?.reason === "taken_over" || detail?.reason === "web_message") {
              const by = detail.by
                ? (
                    await app.facilityDb
                      .select({ name: users.name, email: users.email })
                      .from(users)
                      .where(eq(users.id, detail.by))
                      .limit(1)
                  )[0]
                : null;
              holderReason = `${by?.name ?? by?.email ?? "Someone"} took over at ${ended?.createdAt.toISOString()}${detail.reason === "web_message" ? " to send a message" : ""}. You are watching now. Ctrl+C to take it back.`;
              eligibleToWait = false;
              ownedTurnId = undefined;
            } else if (ended) {
              send({
                type: "session_ended",
                reason: detail?.reason,
                message: "Native session closed; its conversation and usage were imported",
              });
              socket.close(1000, "Native session ended");
              return;
            }
          }
          if (terminal && !writer) eligibleToWait = false;
          const wasWriting = Boolean(terminal);
          if (!writer || terminalTurnId !== active?.id) dropTerminal();
          if (writer && active && state && !terminal) {
            terminalTurnId = active.id;
            const workspace = await sessions.workspace(app.facilityDb, scope);
            const attached = await app.storyDomain.runtime.terminal!(workspace, {
              socket: `/workspace/.facility/interactive/${active.id}/tty`,
              cols,
              rows,
              onData: (data) => {
                if (!closed && socket.readyState === 1 && terminalTurnId === active.id) {
                  if (socket.bufferedAmount >= 1024 * 1024)
                    socket.close(1013, "Slow terminal reader");
                  else socket.send(data);
                }
              },
            });
            if (closed) {
              attached.close();
              return;
            }
            terminal = attached;
            attached.onClose(() => {
              if (terminal === attached) {
                terminal = undefined;
                terminalTurnId = undefined;
              }
            });
          }
          const holderKey = JSON.stringify({ ...status, writer });
          if (holderKey !== previousHolder) {
            send({
              type: "holder",
              ...status,
              writer,
              reason:
                holderReason ??
                (previousHolder && !writer && wasWriting
                  ? (state?.agentMessage ??
                    "The session changed hands; you are watching now. Ctrl+C to take it back.")
                  : undefined),
            });
            previousHolder = holderKey;
          }
          if (status.holder?.kind === "facility" && watchedTurnId !== status.holder.turnId) {
            watchedTurnId = status.holder.turnId;
            seq = 0;
          }
          if (watchedTurnId) {
            const events = await app.facilityDb
              .select()
              .from(turnEvents)
              .where(
                and(
                  eq(turnEvents.orgId, scope.orgId),
                  eq(turnEvents.projectId, scope.projectId),
                  eq(turnEvents.storyId, scope.storyId),
                  eq(turnEvents.turnId, watchedTurnId!),
                  gt(turnEvents.seq, seq),
                ),
              )
              .orderBy(asc(turnEvents.seq))
              .limit(100);
            if (events.length) {
              send({ type: "events", turnId: watchedTurnId, events });
              seq = events.at(-1)!.seq;
              if (
                events.some((event) =>
                  ["turn.succeeded", "turn.failed", "turn.worker_interrupted"].includes(event.type),
                )
              ) {
                const attention = (
                  await app.facilityDb
                    .select({ detail: attentionItems.detail, title: attentionItems.title })
                    .from(attentionItems)
                    .where(
                      and(
                        eq(attentionItems.orgId, scope.orgId),
                        eq(attentionItems.storyId, scope.storyId),
                        eq(attentionItems.kind, "agent_waiting"),
                        eq(attentionItems.status, "open"),
                      ),
                    )
                    .limit(1)
                )[0];
                if (attention)
                  send({
                    type: "agent_state",
                    state: "blocked",
                    message: attention.detail ?? attention.title,
                  });
              }
            }
          }
        } catch (cause) {
          error(cause);
          if (cause instanceof ApiError && [401, 403, 404].includes(cause.statusCode))
            socket.close(1008, "Session access ended");
        } finally {
          busy = false;
        }
      }

      socket.on("message", (raw, binary) => {
        const data = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as Buffer);
        if (
          data.byteLength > 65_536 ||
          pendingInputBytes + data.byteLength > 1024 * 1024 ||
          pendingInputFrames >= 128
        ) {
          socket.close(1009, "Session input buffer exceeded");
          return;
        }
        pendingInputBytes += data.byteLength;
        pendingInputFrames++;
        controls = controls
          .then(async () => {
            if (closed) return;
            if (binary) {
              if (!terminal || !terminalTurnId)
                throw new ApiError(
                  403,
                  "session_read_only",
                  "You are watching; confirm takeover before writing",
                );
              const writer = terminal;
              await sessions.write(scope, actor, client, terminalTurnId, () => writer.write(data));
              return;
            }
            const control = Control.parse(JSON.parse(data.toString()));
            if (control.type === "takeover") {
              if (query.mode !== "attach")
                throw new ApiError(
                  403,
                  "session_read_only",
                  "An observation channel cannot take over; reconnect in attach mode",
                );
              await sessions.enter(scope, actor, client, control.turnId);
            } else if (control.type === "resize") {
              cols = control.cols;
              rows = control.rows;
              if (
                terminal &&
                terminalTurnId &&
                (await sessions.owns(scope, actor, client, terminalTurnId))
              )
                await terminal.resize(cols, rows);
            } else if (control.type === "leave") {
              if (query.mode === "attach" && can(actor.permissions, "sessions:control"))
                await sessions.release(scope, actor, client);
              socket.close(1000, "Detached");
            }
          })
          .catch(error)
          .finally(() => {
            pendingInputBytes -= data.byteLength;
            pendingInputFrames--;
          });
      });
      const interval = setInterval(() => void update(), 500);
      interval.unref();
      // OAuth tokens are revalidated by reconnecting; refresh never extends an
      // already-authenticated socket beyond the access token's lifetime.
      let expiresIn = 15 * 60_000;
      const bearer = request.headers.authorization?.replace(/^Bearer /i, "");
      if (bearer?.split(".").length === 3) {
        try {
          expiresIn = Math.min(
            expiresIn,
            Math.max(0, (decodeJwt(bearer).exp ?? 0) * 1000 - Date.now()),
          );
        } catch {
          expiresIn = 0;
        }
      }
      const expiry = setTimeout(
        () => socket.close(1008, "Authentication expired; reconnect"),
        expiresIn,
      );
      expiry.unref();
      socket.once("close", () => {
        closed = true;
        clearInterval(interval);
        clearTimeout(expiry);
        dropTerminal();
        void sessions.disconnect(scope, client).catch(() => undefined);
        void request
          .audit(
            "session.observe_ended",
            { type: "story", id: scope.storyId },
            { durationMs: Date.now() - enteredAt },
          )
          .catch(() => undefined);
      });
      socket.on("error", () => socket.close());
      void update();
    },
  );

  let reconciling = false;
  const reconciliation = setInterval(() => {
    if (reconciling) return;
    reconciling = true;
    void sessions
      .reconcile()
      .catch(() => app.log.warn("Session reconciliation failed"))
      .finally(() => {
        reconciling = false;
      });
  }, 10_000);
  reconciliation.unref();
  app.addHook("onClose", async () => clearInterval(reconciliation));
}
