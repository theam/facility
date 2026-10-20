import { AgentManifestSchema } from "@facility/agents";
import { can, newId, open, seal } from "@facility/core";
import {
  attentionItems,
  auditEvents,
  engineSessions,
  type FacilityDb,
  orgMembers,
  roles,
  sessionWaiters,
  stories,
  storyConversations,
  storyMessages,
  turnEvents,
  turns,
  users,
  workspaces,
} from "@facility/db";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { manifestFromProjection } from "../agents/catalog.js";
import { ApiError } from "../errors.js";
import { BudgetPolicyError, CostBudgetService } from "../insights/costs.js";
import { isGithubIssueStory, resolveDefaultAgent } from "../stories/phase.js";
import type { StoryDomain } from "../story-domain.js";
import { buildPrompt, credentialSecrets } from "../turns/dispatcher.js";
import type { AgentTurnUsage } from "../turns/engines.js";
import { appendTurnEvent } from "../turns/events.js";
import { redactEvent, redactString } from "../turns/redaction.js";
import type { Principal } from "../types.js";
import type { WorkspaceLocator } from "../workspaces/runtime.js";
import {
  emptyUsage,
  hasNativeUsage,
  interactiveArguments,
  messagesForNativeResume,
  NativeSnapshot,
  nativeAgentState,
  nativeCost,
  nativeMessage,
  nativeUsage,
  type Snapshot,
  usageSince,
} from "./native.js";

export type SessionScope = { orgId: string; projectId: string; storyId: string };
type Turn = typeof turns.$inferSelect;
type InteractiveState = {
  clientId: string;
  userId: string;
  status: "waiting" | "prepared" | "ready" | "closing";
  closeReason?: string;
  previousTurnId?: string;
  nativeSessionId?: string;
  cwd?: string;
  baseline?: AgentTurnUsage;
  baselineRecords?: number;
  imported: number;
  importedAt?: string;
  lastAttachedAt: string;
  timeoutMinutes: number;
  agentState?: string;
  agentMessage?: string;
  redactionSecrets?: string;
  launchEnvironment?: string;
};
export type SessionClient = { id: string; transportId: string };
export const interactiveState = (turn: Turn) => turn.interactive as InteractiveState | null;

export async function lockSession(db: FacilityDb, scope: SessionScope) {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`facility:story:${scope.orgId}:${scope.projectId}:${scope.storyId}`}))`,
  );
}

export async function assertSessionPrincipal(db: FacilityDb, actor: Principal, permission: string) {
  if (actor.type !== "user" || !actor.userId)
    throw new ApiError(
      403,
      "session_user_required",
      "Sessions require a signed-in user; API keys cannot attach",
    );
  const membership = (
    await db
      .select({ permissions: roles.permissions })
      .from(orgMembers)
      .innerJoin(roles, eq(orgMembers.roleId, roles.id))
      .innerJoin(users, eq(orgMembers.userId, users.id))
      .where(
        and(
          eq(orgMembers.orgId, actor.orgId),
          eq(orgMembers.userId, actor.userId),
          eq(users.status, "active"),
        ),
      )
      .limit(1)
  )[0];
  if (
    !membership ||
    !can(actor.permissions, permission) ||
    !can(membership.permissions, permission)
  )
    throw new ApiError(403, "session_forbidden", "Session permission denied");
}

export class StorySessionService {
  constructor(
    private readonly db: FacilityDb,
    private readonly domain: Omit<StoryDomain, "sessions">,
    private readonly secretMasterKey: string,
  ) {}

  async takeoverForMessage(
    tx: FacilityDb,
    scope: SessionScope,
    userId: string,
    expectedTurnId: string,
  ) {
    const actor: Principal = {
      type: "user",
      id: userId,
      userId,
      orgId: scope.orgId,
      permissions: ["sessions:control"],
    };
    await assertSessionPrincipal(tx, actor, "sessions:control");
    const active = await this.holder(scope, tx);
    if (active?.id !== expectedTurnId || active.triggerType !== "interactive")
      throw new ApiError(
        409,
        "session_holder_changed",
        "The holder changed; review and confirm again",
      );
    await this.finishLocked(tx, scope, active, "web_message", actor);
    await tx
      .update(sessionWaiters)
      .set({ waiting: false })
      .where(eq(sessionWaiters.storyId, scope.storyId));
    await this.audit(tx, scope, userId, "session.takeover", {
      fromTurnId: active.id,
      fromUserId: interactiveState(active)?.userId,
      reason: "web_message",
    });
  }

  async holder(scope: SessionScope, db = this.db) {
    const active = (
      await db
        .select()
        .from(turns)
        .where(
          and(
            eq(turns.orgId, scope.orgId),
            eq(turns.projectId, scope.projectId),
            eq(turns.storyId, scope.storyId),
            inArray(turns.state, ["queued", "running"]),
          ),
        )
        .limit(1)
    )[0];
    return active ?? null;
  }

  async status(scope: SessionScope) {
    const story = await this.story(scope);
    const turn = await this.holder(scope);
    const owner = turn ? interactiveState(turn) : null;
    const person = owner
      ? (
          await this.db
            .select({ name: users.name, email: users.email })
            .from(users)
            .where(eq(users.id, owner.userId))
            .limit(1)
        )[0]
      : null;
    const waiting = await this.db
      .select({ userId: sessionWaiters.userId, name: users.name, since: sessionWaiters.createdAt })
      .from(sessionWaiters)
      .innerJoin(users, eq(sessionWaiters.userId, users.id))
      .where(
        and(
          eq(sessionWaiters.storyId, scope.storyId),
          eq(sessionWaiters.orgId, scope.orgId),
          eq(sessionWaiters.waiting, true),
          gt(sessionWaiters.expiresAt, new Date()),
        ),
      )
      .orderBy(asc(sessionWaiters.createdAt), asc(sessionWaiters.id))
      .limit(100);
    return {
      supported: this.domain.runtime.provider === "docker" && Boolean(this.domain.runtime.terminal),
      phase: story.status,
      completedByMerge: story.status === "done" && !isGithubIssueStory(story),
      holder: turn
        ? {
            turnId: turn.id,
            kind: owner ? "person" : "facility",
            userId: owner?.userId,
            name: person?.name ?? person?.email ?? turn.agentName,
            since: turn.startedAt ?? turn.createdAt,
            trigger: turn.triggerType,
            agent: turn.agentName,
            engine: turn.engine,
            state: owner?.agentState ?? "working",
            message: owner?.agentMessage,
          }
        : null,
      waiting,
    };
  }

  async projectHolders(orgId: string, projectId: string, offset = 0, limit = 100) {
    const active = await this.db
      .select({
        id: turns.id,
        storyId: turns.storyId,
        agentName: turns.agentName,
        startedAt: turns.startedAt,
        createdAt: turns.createdAt,
        triggerType: turns.triggerType,
        userId: sql<string | null>`${turns.interactive}->>'userId'`,
      })
      .from(turns)
      .where(
        and(
          eq(turns.orgId, orgId),
          eq(turns.projectId, projectId),
          inArray(turns.state, ["queued", "running"]),
        ),
      )
      .orderBy(asc(turns.id))
      .offset(offset)
      .limit(limit);
    const ids = active.map((turn) => turn.userId).filter((id): id is string => Boolean(id));
    const people = ids.length
      ? await this.db
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .where(inArray(users.id, ids))
      : [];
    const names = new Map(people.map((person) => [person.id, person.name ?? person.email]));
    return {
      next_offset: active.length === limit ? offset + limit : null,
      holders: Object.fromEntries(
        active.map((turn) => {
          const owner = turn.userId;
          return [
            turn.storyId,
            {
              turnId: turn.id,
              kind: owner ? "person" : "facility",
              name: owner ? (names.get(owner) ?? "A person") : turn.agentName,
              userId: owner ?? undefined,
              since: turn.startedAt ?? turn.createdAt,
              trigger: turn.triggerType,
            },
          ];
        }),
      ),
    };
  }

  async lease(
    scope: SessionScope,
    actor: Principal,
    client: SessionClient,
    wait: boolean,
    renew = false,
  ) {
    await this.authorize(scope, actor, wait ? "sessions:control" : "sessions:observe");
    await this.story(scope);
    if (renew) {
      const renewed = await this.db
        .update(sessionWaiters)
        .set({ expiresAt: new Date(Date.now() + 30_000), waiting: wait })
        .where(
          and(
            eq(sessionWaiters.id, client.id),
            eq(sessionWaiters.transportId, client.transportId),
            eq(sessionWaiters.userId, actor.userId!),
          ),
        )
        .returning();
      if (!renewed.length)
        throw new ApiError(
          403,
          "session_connection_replaced",
          "This connection was replaced by another attachment",
        );
      return;
    }
    const row = (
      await this.db
        .insert(sessionWaiters)
        .values({
          id: client.id,
          ...scope,
          userId: actor.userId!,
          transportId: client.transportId,
          waiting: wait,
          expiresAt: new Date(Date.now() + 30_000),
        })
        .onConflictDoUpdate({
          target: sessionWaiters.id,
          set: { transportId: client.transportId, expiresAt: new Date(Date.now() + 30_000) },
          setWhere: and(
            eq(sessionWaiters.userId, actor.userId!),
            eq(sessionWaiters.orgId, scope.orgId),
            eq(sessionWaiters.projectId, scope.projectId),
            eq(sessionWaiters.storyId, scope.storyId),
          ),
        })
        .returning()
    )[0];
    if (!row)
      throw new ApiError(409, "session_client_conflict", "Client identity is already in use");
  }

  async enter(
    scope: SessionScope,
    actor: Principal,
    client: SessionClient,
    expectedTurnId?: string,
  ) {
    await this.authorize(scope, actor, "sessions:control");
    if (this.domain.runtime.provider !== "docker" || !this.domain.runtime.terminal)
      throw new ApiError(
        409,
        "session_not_supported",
        "Interactive sessions are not supported yet on this provider; the read-only view remains available",
      );
    const story = await this.story(scope);
    const projected = await this.domain.catalog.list(scope.orgId, scope.projectId, {
      refresh: false,
    });
    const manifests = projected.map(manifestFromProjection);
    const selected =
      manifests.find((agent) => agent.name === story.activeAgentName && agent.enabled) ??
      resolveDefaultAgent(manifests, "manual");
    const old = await this.holder(scope);
    const latest = (
      await this.db
        .select()
        .from(turns)
        .where(and(eq(turns.orgId, scope.orgId), eq(turns.storyId, scope.storyId)))
        .orderBy(desc(turns.createdAt))
        .limit(1)
    )[0];
    const manifest =
      old || latest ? AgentManifestSchema.parse((old ?? latest)!.manifest) : selected;
    if (!manifest)
      throw new ApiError(
        409,
        "session_agent_missing",
        "Configure an enabled manual agent before attaching",
      );
    try {
      await this.domain.costs.assertTurnAllowed(scope.orgId, scope.projectId, manifest.model);
    } catch (error) {
      await this.db
        .update(sessionWaiters)
        .set({ waiting: false })
        .where(and(eq(sessionWaiters.id, client.id), eq(sessionWaiters.userId, actor.userId!)));
      throw error;
    }
    return this.db.transaction(async (raw) => {
      const tx = raw as unknown as FacilityDb;
      await lockSession(tx, scope);
      await this.assertConnection(tx, scope, actor, client);
      const active = await this.holder(scope, tx);
      if (expectedTurnId && active?.id !== expectedTurnId)
        throw new ApiError(
          409,
          "session_holder_changed",
          "The holder changed; review the current holder and confirm again",
        );
      if (active && !expectedTurnId) return active;
      await this.workspace(tx, scope);
      const first = (
        await tx
          .select()
          .from(sessionWaiters)
          .where(
            and(
              eq(sessionWaiters.storyId, scope.storyId),
              eq(sessionWaiters.waiting, true),
              gt(sessionWaiters.expiresAt, new Date()),
            ),
          )
          .orderBy(asc(sessionWaiters.createdAt), asc(sessionWaiters.id))
          .limit(1)
      )[0];
      if (!expectedTurnId && first?.id !== client.id) return null;
      const conversation = (
        await tx
          .select()
          .from(storyConversations)
          .where(
            and(
              eq(storyConversations.orgId, scope.orgId),
              eq(storyConversations.storyId, scope.storyId),
            ),
          )
          .limit(1)
      )[0];
      if (!conversation)
        throw new ApiError(404, "conversation_not_found", "Conversation not found");
      let previousTurnId =
        !active &&
        latest?.state === "canceled" &&
        latest.startedAt &&
        latest.triggerType !== "interactive"
          ? latest.id
          : undefined;
      if (active) {
        if (active.triggerType === "interactive")
          await this.finishLocked(tx, scope, active, "taken_over", actor);
        else {
          const canceled = (
            await tx
              .update(turns)
              .set({ state: "canceled", endedAt: new Date(), updatedAt: new Date() })
              .where(eq(turns.id, active.id))
              .returning()
          )[0]!;
          previousTurnId = canceled.startedAt ? canceled.id : undefined;
          await appendTurnEvent(tx, {
            ...scope,
            turnId: active.id,
            type: "turn.cancel_requested",
            data: { actor: { type: "user", id: actor.userId } },
          });
        }
        await tx
          .update(sessionWaiters)
          .set({ waiting: false })
          .where(eq(sessionWaiters.storyId, scope.storyId));
      }
      const state: InteractiveState = {
        clientId: client.id,
        userId: actor.userId!,
        status: "waiting",
        previousTurnId,
        imported: 0,
        lastAttachedAt: new Date().toISOString(),
        timeoutMinutes: 15,
      };
      const turn = (
        await tx
          .insert(turns)
          .values({
            id: newId("turn"),
            ...scope,
            conversationId: conversation.id,
            agentName: manifest.name,
            manifest,
            manifestHash: manifest.hash,
            model: manifest.model,
            engine: manifest.engine,
            state: "queued",
            triggerType: "interactive",
            interactive: state,
            createdBy: { type: "user", id: actor.userId },
          })
          .returning()
      )[0]!;
      await tx
        .update(sessionWaiters)
        .set({ waiting: false })
        .where(eq(sessionWaiters.id, client.id));
      await tx
        .update(stories)
        .set({
          status: "working",
          activeAgentName: manifest.name,
          archivedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(stories.id, story.id));
      await this.audit(tx, scope, actor.userId!, active ? "session.takeover" : "session.enter", {
        turnId: turn.id,
        fromTurnId: active?.id,
        fromUserId: active ? interactiveState(active)?.userId : undefined,
      });
      return turn;
    });
  }

  async owns(
    scope: SessionScope,
    actor: Principal,
    client: SessionClient,
    turnId: string,
    db = this.db,
  ) {
    await this.authorize(scope, actor, "sessions:control", db);
    const turn = await this.holder(scope, db);
    const state = turn && interactiveState(turn);
    const lease = (
      await db
        .select()
        .from(sessionWaiters)
        .where(
          and(
            eq(sessionWaiters.id, client.id),
            eq(sessionWaiters.userId, actor.userId!),
            eq(sessionWaiters.transportId, client.transportId),
            gt(sessionWaiters.expiresAt, new Date()),
          ),
        )
        .limit(1)
    )[0];
    return Boolean(
      lease &&
        turn?.id === turnId &&
        turn.state === "running" &&
        state?.clientId === client.id &&
        state.userId === actor.userId &&
        state.status === "ready",
    );
  }

  async write(
    scope: SessionScope,
    actor: Principal,
    client: SessionClient,
    turnId: string,
    output: () => void | Promise<void>,
  ) {
    await this.db.transaction(async (raw) => {
      const tx = raw as unknown as FacilityDb;
      await lockSession(tx, scope);
      // Serialize the final write with reconnect's nonce replacement as well as
      // turn handover. A check followed by an unlocked write can race another API.
      await tx
        .select({ id: sessionWaiters.id })
        .from(sessionWaiters)
        .where(
          and(
            eq(sessionWaiters.id, client.id),
            eq(sessionWaiters.transportId, client.transportId),
            eq(sessionWaiters.orgId, scope.orgId),
            eq(sessionWaiters.storyId, scope.storyId),
          ),
        )
        .for("share");
      if (!(await this.owns(scope, actor, client, turnId, tx)))
        throw new ApiError(403, "session_read_only", "This attachment no longer holds the session");
      await output();
    });
  }

  async reattach(scope: SessionScope, actor: Principal, client: SessionClient) {
    await this.authorize(scope, actor, "sessions:control");
    await this.db.transaction(async (raw) => {
      const tx = raw as unknown as FacilityDb;
      await lockSession(tx, scope);
      const active = await this.holder(scope, tx);
      const state = active && interactiveState(active);
      if (!active || !state || state.userId !== actor.userId || state.clientId === client.id)
        return;
      const owner = (
        await tx
          .select()
          .from(sessionWaiters)
          .where(
            and(eq(sessionWaiters.id, state.clientId), gt(sessionWaiters.expiresAt, new Date())),
          )
          .limit(1)
      )[0];
      if (owner) return;
      const connection = (
        await tx
          .select()
          .from(sessionWaiters)
          .where(
            and(
              eq(sessionWaiters.id, client.id),
              eq(sessionWaiters.userId, state.userId),
              eq(sessionWaiters.transportId, client.transportId),
              gt(sessionWaiters.expiresAt, new Date()),
            ),
          )
          .limit(1)
      )[0];
      if (!connection) return;
      await tx
        .update(turns)
        .set({
          interactive: { ...state, clientId: client.id, lastAttachedAt: new Date().toISOString() },
          updatedAt: new Date(),
        })
        .where(eq(turns.id, active.id));
      await this.audit(tx, scope, state.userId, "session.reattach", { turnId: active.id });
    });
  }

  async release(scope: SessionScope, actor: Principal, client: SessionClient) {
    await this.authorize(scope, actor, "sessions:control");
    await this.db.transaction(async (raw) => {
      const tx = raw as unknown as FacilityDb;
      await lockSession(tx, scope);
      await this.assertConnection(tx, scope, actor, client);
      const turn = await this.holder(scope, tx);
      if (
        turn &&
        interactiveState(turn)?.clientId === client.id &&
        interactiveState(turn)?.userId === actor.userId
      )
        await this.finishLocked(tx, scope, turn, "left", actor);
    });
    await this.disconnect(scope, client);
    await this.domain.dispatcher.activateQueuedSuccessor({ ...scope });
  }

  async disconnect(scope: SessionScope, client: SessionClient) {
    await this.db
      .delete(sessionWaiters)
      .where(
        and(
          eq(sessionWaiters.id, client.id),
          eq(sessionWaiters.transportId, client.transportId),
          eq(sessionWaiters.orgId, scope.orgId),
          eq(sessionWaiters.storyId, scope.storyId),
        ),
      );
    await this.domain.dispatcher.activateQueuedSuccessor({ ...scope });
  }

  private async assertConnection(
    tx: FacilityDb,
    scope: SessionScope,
    actor: Principal,
    client: SessionClient,
  ) {
    const connection = (
      await tx
        .select({ id: sessionWaiters.id })
        .from(sessionWaiters)
        .where(
          and(
            eq(sessionWaiters.id, client.id),
            eq(sessionWaiters.transportId, client.transportId),
            eq(sessionWaiters.orgId, scope.orgId),
            eq(sessionWaiters.projectId, scope.projectId),
            eq(sessionWaiters.storyId, scope.storyId),
            eq(sessionWaiters.userId, actor.userId!),
            gt(sessionWaiters.expiresAt, new Date()),
          ),
        )
        .limit(1)
    )[0];
    if (!connection)
      throw new ApiError(
        403,
        "session_connection_replaced",
        "This connection expired or was replaced; reconnect before controlling the session",
      );
  }

  private async authorize(scope: SessionScope, actor: Principal, permission: string, db = this.db) {
    if (scope.orgId !== actor.orgId) throw new ApiError(404, "story_not_found", "Story not found");
    await assertSessionPrincipal(db, actor, permission);
  }

  async reconcile() {
    const expired = await this.db
      .delete(sessionWaiters)
      .where(
        sql`${sessionWaiters.id} IN (SELECT id FROM session_waiters WHERE expires_at < now() ORDER BY expires_at LIMIT 1000)`,
      )
      .returning();
    const released = new Map(expired.map((row) => [row.storyId, row]));
    for (const row of released.values())
      await this.domain.dispatcher.activateQueuedSuccessor({
        orgId: row.orgId,
        projectId: row.projectId,
        storyId: row.storyId,
      });
    let cursor = "";
    for (;;) {
      const active = await this.db
        .select({
          id: turns.id,
          orgId: turns.orgId,
          projectId: turns.projectId,
          storyId: turns.storyId,
        })
        .from(turns)
        .where(
          and(
            eq(turns.triggerType, "interactive"),
            inArray(turns.state, ["queued", "running"]),
            gt(turns.id, cursor),
          ),
        )
        .orderBy(asc(turns.id))
        .limit(100);
      for (const turn of active) {
        const scope = { orgId: turn.orgId, projectId: turn.projectId, storyId: turn.storyId };
        try {
          await this.tick(scope);
        } catch {
          // Keep the occupied slot on import/stop failure: freeing it could permit
          // another writer while the native process or its usage is unaccounted for.
          await this.domain.stories.flagAttention({
            ...scope,
            turnId: turn.id,
            kind: "session_reconciliation_failed",
            title: "Interactive session needs reconciliation",
            detail:
              "Native import or terminal shutdown failed. The session slot was retained; retry after restoring workspace access.",
          });
        }
      }
      const last = active.at(-1);
      if (active.length < 100 || !last) break;
      cursor = last.id;
    }
  }

  async tick(scope: SessionScope) {
    let finished = false;
    await this.db.transaction(async (raw) => {
      const tx = raw as unknown as FacilityDb;
      const locked = await tx.execute(
        sql`SELECT pg_try_advisory_xact_lock(hashtext(${`facility:story:${scope.orgId}:${scope.projectId}:${scope.storyId}`})) AS acquired`,
      );
      if (!locked[0]?.acquired) return;
      const turn = await this.holder(scope, tx);
      if (!turn || turn.triggerType !== "interactive") return;
      let state = interactiveState(turn)!;
      const owner = (
        await tx
          .select()
          .from(sessionWaiters)
          .where(
            and(eq(sessionWaiters.id, state.clientId), gt(sessionWaiters.expiresAt, new Date())),
          )
          .limit(1)
      )[0];
      const principal: Principal = {
        type: "user",
        id: state.userId,
        userId: state.userId,
        orgId: scope.orgId,
        permissions: ["sessions:control"],
      };
      let denial = "";
      try {
        await assertSessionPrincipal(tx, principal, "sessions:control");
      } catch {
        denial = "permission_revoked";
      }
      if (owner) state.lastAttachedAt = new Date().toISOString();
      const detached =
        Date.now() - Date.parse(state.lastAttachedAt) >= state.timeoutMinutes * 60_000;
      const periodChanged =
        turn.createdAt.toISOString().slice(0, 7) !== new Date().toISOString().slice(0, 7);
      if (denial || detached || periodChanged) {
        await this.finishLocked(
          tx,
          scope,
          { ...turn, interactive: state },
          denial || (periodChanged ? "budget_period_changed" : "detached_timeout"),
          principal,
        );
        finished = true;
        return;
      }
      if (state.status === "closing") {
        await this.finishLocked(
          tx,
          scope,
          { ...turn, interactive: state },
          state.closeReason ?? "closed",
          principal,
        );
        finished = true;
        return;
      }
      if (state.status !== "ready") {
        if (state.previousTurnId) {
          const ended = (
            await tx
              .select()
              .from(turnEvents)
              .where(
                and(
                  eq(turnEvents.turnId, state.previousTurnId),
                  inArray(turnEvents.type, ["turn.canceled", "turn.succeeded", "turn.failed"]),
                ),
              )
              .limit(1)
          )[0];
          if (!ended) return;
        }
        try {
          state = await this.startLocked(tx, scope, turn, state);
        } catch (error) {
          if (!(error instanceof BudgetPolicyError)) throw error;
          state.status = "closing";
          state.closeReason = error.code;
          state.agentState = "blocked";
          state.agentMessage = error.message;
          await tx
            .update(turns)
            .set({ interactive: state, updatedAt: new Date() })
            .where(eq(turns.id, turn.id));
          return;
        }
        if (state.status === "prepared") return;
      }
      const workspace = await this.workspace(tx, scope);
      if (state.importedAt && Date.now() - Date.parse(state.importedAt) < 2_000) {
        await tx
          .update(turns)
          .set({ interactive: state, updatedAt: new Date() })
          .where(eq(turns.id, turn.id));
        return;
      }
      let nativeState: Snapshot;
      try {
        nativeState = await this.read(workspace, turn, state);
      } catch (error) {
        // A journal we cannot account for must not keep consuming unattended.
        // Retain the database slot until final import succeeds, even if stopping fails.
        await this.command(workspace, "stop", turn.id).catch(() => undefined);
        throw error;
      }
      const signal = nativeAgentState(turn.engine, nativeState);
      state.agentState = signal?.state ?? state.agentState ?? "idle";
      state.agentMessage = signal?.message;
      state = await this.importLocked(tx, scope, turn, state, nativeState);
      if (state.agentState === "blocked") {
        const open = (
          await tx
            .select()
            .from(attentionItems)
            .where(
              and(
                eq(attentionItems.storyId, scope.storyId),
                eq(attentionItems.kind, "agent_waiting"),
                eq(attentionItems.status, "open"),
              ),
            )
            .limit(1)
        )[0];
        if (!open)
          await tx.insert(attentionItems).values({
            id: newId("attn"),
            ...scope,
            turnId: turn.id,
            kind: "agent_waiting",
            title: `${turn.agentName} needs a reply`,
            detail: state.agentMessage ?? "The native agent needs your attention",
          });
      }
      try {
        await new CostBudgetService(tx).assertTurnAllowed(scope.orgId, scope.projectId, turn.model);
      } catch (error) {
        if (!(error instanceof BudgetPolicyError)) throw error;
        await appendTurnEvent(tx, {
          ...scope,
          turnId: turn.id,
          type: "session.budget_exceeded",
          data: { message: error.message },
        });
        state.status = "closing";
        state.closeReason = error.code;
        state.agentState = "blocked";
        state.agentMessage = error.message;
        // Commit the imported charge even when provider shutdown later fails.
        await tx
          .update(turns)
          .set({ interactive: state, updatedAt: new Date() })
          .where(eq(turns.id, turn.id));
        return;
      }
      if (nativeState.exited) {
        await this.finishLocked(
          tx,
          scope,
          { ...turn, interactive: state },
          "agent_exited",
          principal,
        );
        finished = true;
        return;
      }
      await tx
        .update(turns)
        .set({ interactive: state, updatedAt: new Date() })
        .where(eq(turns.id, turn.id));
    });
    if (finished) await this.domain.dispatcher.activateQueuedSuccessor({ ...scope });
  }

  private async startLocked(
    tx: FacilityDb,
    scope: SessionScope,
    turn: Turn,
    state: InteractiveState,
  ) {
    const manifest = AgentManifestSchema.parse(turn.manifest);
    await new CostBudgetService(tx).assertTurnAllowed(scope.orgId, scope.projectId, manifest.model);
    const workspace = await this.workspace(tx, scope);
    if (state.status === "prepared") {
      const probe = JSON.parse(await this.command(workspace, "probe", turn.id)) as {
        started: boolean;
      };
      if (!probe.started) {
        if (!state.launchEnvironment) throw new Error("Prepared native launch is unavailable");
        const launch = JSON.parse(await open(state.launchEnvironment, this.secretMasterKey)) as {
          environment: Record<string, string>;
          input: unknown;
        };
        await this.command(
          workspace,
          "start",
          turn.id,
          launch.environment,
          JSON.stringify(launch.input),
        );
      }
      state.status = "ready";
      state.launchEnvironment = undefined;
      await tx
        .update(turns)
        .set({
          state: "running",
          startedAt: turn.startedAt ?? new Date(),
          interactive: state,
          updatedAt: new Date(),
        })
        .where(eq(turns.id, turn.id));
      await appendTurnEvent(tx, {
        ...scope,
        turnId: turn.id,
        type: "session.started",
        data: { userId: state.userId },
      });
      return state;
    }
    const story = await this.story(scope, tx);
    const [credential, project] = await Promise.all([
      this.domain.credentials.issue(scope.orgId, scope.projectId, tx),
      this.domain.projectManifests.load(scope.orgId, scope.projectId, tx),
    ]);
    for (const phase of ["credentials", "workspace", "environment"])
      await appendTurnEvent(tx, { ...scope, turnId: turn.id, type: "turn.phase", data: { phase } });
    const branch = story.branch ?? `facility/story-${story.id}`;
    await tx.update(stories).set({ branch }).where(eq(stories.id, story.id));
    const prepared = await this.domain.environment.prepare(
      {
        orgId: scope.orgId,
        projectId: scope.projectId,
        workspace,
        manifest: project,
        credentials: credential,
        branch,
      },
      tx,
    );
    state.redactionSecrets = await seal(
      JSON.stringify(credentialSecrets(prepared.processEnvironment, prepared.secretNames)),
      this.secretMasterKey,
    );
    const session = (
      await tx
        .select()
        .from(engineSessions)
        .where(
          and(
            eq(engineSessions.orgId, scope.orgId),
            eq(engineSessions.workspaceId, workspace.id),
            eq(engineSessions.agentName, turn.agentName),
            eq(engineSessions.engine, turn.engine),
            eq(engineSessions.model, turn.model),
            eq(engineSessions.status, "active"),
          ),
        )
        .limit(1)
    )[0];
    state.nativeSessionId = session?.nativeSessionId;
    const before = await this.read(workspace, turn, state, !state.nativeSessionId);
    state = {
      ...state,
      baseline: nativeUsage(turn.engine, before.records),
      baselineRecords: before.records.length,
      imported: before.records.length,
      cwd: prepared.primaryCwd,
      timeoutMinutes: project.sessions?.detached_timeout_minutes ?? 15,
      status: "prepared",
    };
    const environment = { ...prepared.processEnvironment };
    if (environment.OPENAI_API_KEY && !environment.CODEX_API_KEY)
      environment.CODEX_API_KEY = environment.OPENAI_API_KEY;
    const conversation = (
      await tx
        .select()
        .from(storyConversations)
        .where(eq(storyConversations.storyId, scope.storyId))
        .limit(1)
    )[0];
    const history = await tx
      .select()
      .from(storyMessages)
      .where(
        and(eq(storyMessages.storyId, scope.storyId), sql`${storyMessages.turnId} is not null`),
      )
      .orderBy(desc(storyMessages.seq))
      .limit(1000);
    state.launchEnvironment = await seal(
      JSON.stringify({
        environment,
        input: {
          engine: turn.engine,
          cwd: prepared.primaryCwd,
          instructions: buildPrompt(
            manifest,
            story,
            conversation?.summary ?? null,
            messagesForNativeResume(history.reverse(), state.nativeSessionId),
            turn.id,
          ),
          args: interactiveArguments(
            manifest,
            state.nativeSessionId,
            `/workspace/.facility/interactive/${turn.id}/instructions.md`,
          ),
        },
      }),
      this.secretMasterKey,
    );
    // Commit the accounting boundary and the exact credentials before launch.
    // Recovery must neither charge old history nor lose the actual redaction values.
    await tx
      .update(turns)
      .set({ interactive: state, updatedAt: new Date() })
      .where(eq(turns.id, turn.id));
    return state;
  }

  private async importLocked(
    tx: FacilityDb,
    scope: SessionScope,
    turn: Turn,
    state: InteractiveState,
    snapshot: Snapshot,
  ) {
    if (snapshot.records.length < state.imported) throw new Error("Native journal was truncated");
    const secrets = Object.values(
      await this.domain.variables.values(
        {
          ...scope,
          workspaceId: (await this.workspace(tx, scope)).id,
        },
        tx,
      ),
    );
    if (state.redactionSecrets)
      secrets.push(
        ...(JSON.parse(await open(state.redactionSecrets, this.secretMasterKey)) as string[]),
      );
    state.agentMessage = state.agentMessage ? redactString(state.agentMessage, secrets) : undefined;
    for (let index = state.imported; index < snapshot.records.length; index++) {
      const record = snapshot.records[index]!;
      const message = nativeMessage(turn.engine, record);
      if (message) {
        const conversation = (
          await tx
            .update(storyConversations)
            .set({ nextSeq: sql`${storyConversations.nextSeq} + 1`, updatedAt: new Date() })
            .where(eq(storyConversations.id, turn.conversationId))
            .returning()
        )[0]!;
        await tx
          .insert(storyMessages)
          .values({
            id: newId("msg"),
            ...scope,
            conversationId: turn.conversationId,
            seq: conversation.nextSeq - 1,
            role: message.role === "assistant" ? "agent" : "user",
            body: redactString(message.body, secrets),
            actor:
              message.role === "user"
                ? { type: "user", id: state.userId }
                : { type: "system", id: turn.engine },
            turnId: turn.id,
            requestedAgentName: turn.agentName,
            dedupeKey: `native:${snapshot.nativeSessionId}:${index}`,
            metadata: {
              nativeSessionId: snapshot.nativeSessionId,
              engine: turn.engine,
              model: turn.model,
            },
          })
          .onConflictDoNothing();
        if (message.role === "user")
          await tx
            .update(attentionItems)
            .set({
              status: "resolved",
              resolution: "replied",
              resolvedAt: new Date(),
              resolvedBy: { type: "user", id: state.userId },
            })
            .where(
              and(
                eq(attentionItems.storyId, scope.storyId),
                eq(attentionItems.kind, "agent_waiting"),
                eq(attentionItems.status, "open"),
              ),
            );
      }
      await appendTurnEvent(tx, {
        ...scope,
        turnId: turn.id,
        type: `engine.${String(record.type ?? "native")}`,
        data: redactEvent(record, secrets),
      });
    }
    if (snapshot.nativeSessionId) {
      await tx
        .insert(engineSessions)
        .values({
          id: newId("esess"),
          ...scope,
          workspaceId: (await this.workspace(tx, scope)).id,
          agentName: turn.agentName,
          engine: turn.engine,
          model: turn.model,
          nativeSessionId: snapshot.nativeSessionId,
          statePath: `/workspace/.facility/${turn.engine === "codex" ? "codex" : "claude"}`,
          lastTurnId: turn.id,
        })
        .onConflictDoUpdate({
          target: [
            engineSessions.workspaceId,
            engineSessions.agentName,
            engineSessions.engine,
            engineSessions.model,
          ],
          targetWhere: sql`${engineSessions.status} = 'active'`,
          set: {
            nativeSessionId: snapshot.nativeSessionId,
            lastTurnId: turn.id,
            lastUsedAt: new Date(),
            updatedAt: new Date(),
          },
        });
      state.nativeSessionId = snapshot.nativeSessionId;
    }
    const accounting = nativeCost(
      turn.engine,
      snapshot.records,
      state.baselineRecords ?? 0,
      state.baseline ?? emptyUsage(),
      turn.model,
    );
    if (hasNativeUsage(turn.engine, snapshot.records))
      await new CostBudgetService(tx).record({
        ...scope,
        turnId: turn.id,
        agentName: turn.agentName,
        engine: turn.engine,
        model: accounting.model,
        priceBookCostCents: accounting.costCents,
        usage: usageSince(
          nativeUsage(turn.engine, snapshot.records),
          state.baseline ?? emptyUsage(),
        ),
        durationMs: Date.now() - (turn.startedAt ?? turn.createdAt).getTime(),
        status: "succeeded",
        cumulative: true,
      });
    return { ...state, imported: snapshot.records.length, importedAt: new Date().toISOString() };
  }

  private async finishLocked(
    tx: FacilityDb,
    scope: SessionScope,
    turn: Turn,
    reason: string,
    actor: Principal,
  ) {
    let state = interactiveState(turn)!;
    if (state.previousTurnId) {
      const acknowledgement = (
        await tx
          .select({ seq: turnEvents.seq })
          .from(turnEvents)
          .where(
            and(
              eq(turnEvents.orgId, scope.orgId),
              eq(turnEvents.projectId, scope.projectId),
              eq(turnEvents.storyId, scope.storyId),
              eq(turnEvents.turnId, state.previousTurnId),
              inArray(turnEvents.type, ["turn.canceled", "turn.succeeded", "turn.failed"]),
            ),
          )
          .limit(1)
      )[0];
      if (!acknowledgement)
        throw new ApiError(
          409,
          "session_cancellation_pending",
          "The Facility worker has not confirmed cancellation. The session slot was retained; wait for it to stop before taking over or leaving.",
        );
    }
    if (state.baseline !== undefined) {
      const workspace = await this.workspace(tx, scope);
      await this.command(workspace, "stop", turn.id);
      state = await this.importLocked(
        tx,
        scope,
        turn,
        state,
        await this.read(workspace, turn, state),
      );
    }
    state.launchEnvironment = undefined;
    await tx
      .update(turns)
      .set({ state: "canceled", interactive: state, endedAt: new Date(), updatedAt: new Date() })
      .where(eq(turns.id, turn.id));
    const pendingAttention = (
      await tx
        .select({ id: attentionItems.id })
        .from(attentionItems)
        .where(and(eq(attentionItems.storyId, scope.storyId), eq(attentionItems.status, "open")))
        .limit(1)
    )[0];
    await tx
      .update(stories)
      .set({
        status: sql`CASE WHEN ${stories.status} IN ('done', 'archived') THEN ${stories.status} ELSE ${pendingAttention ? "attention" : "ready"} END`,
        activeAgentName: null,
        updatedAt: new Date(),
      })
      .where(and(eq(stories.orgId, scope.orgId), eq(stories.id, scope.storyId)));
    await appendTurnEvent(tx, {
      ...scope,
      turnId: turn.id,
      type: "session.closed",
      data: { reason, by: actor.userId },
    });
    await this.audit(tx, scope, actor.userId!, "session.exit", {
      turnId: turn.id,
      holderUserId: state.userId,
      reason,
      durationMs: Date.now() - (turn.startedAt ?? turn.createdAt).getTime(),
    });
  }

  private async command(
    workspace: WorkspaceLocator,
    operation: string,
    turnId: string,
    env?: Record<string, string>,
    stdin?: string,
  ) {
    const result = await this.domain.runtime.exec(workspace, {
      command: "facility-session",
      args: [operation, turnId],
      env,
      stdin,
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0) throw new Error(`Native session ${operation} failed`);
    return result.stdout;
  }

  private async read(
    workspace: WorkspaceLocator,
    turn: Turn,
    state: InteractiveState,
    empty = false,
  ) {
    return NativeSnapshot.parse(
      JSON.parse(
        await this.command(workspace, "read", turn.id, {
          FACILITY_SESSION_READ: JSON.stringify({
            engine: turn.engine,
            nativeSessionId: state.nativeSessionId,
            empty,
            notBefore: turn.createdAt.getTime(),
          }),
        }),
      ),
    );
  }

  async workspace(db: FacilityDb, scope: SessionScope): Promise<WorkspaceLocator> {
    const row = (
      await db
        .select()
        .from(workspaces)
        .where(
          and(
            eq(workspaces.orgId, scope.orgId),
            eq(workspaces.projectId, scope.projectId),
            eq(workspaces.storyId, scope.storyId),
            inArray(workspaces.state, ["running", "sleeping", "error"]),
          ),
        )
        .orderBy(desc(workspaces.createdAt))
        .limit(1)
    )[0];
    if (!row?.externalRef)
      throw new ApiError(409, "workspace_unavailable", "Story workspace is unavailable");
    const config = row.environment as {
      image: string;
      variables?: Record<string, string>;
      ports?: WorkspaceLocator["ports"];
      resources?: WorkspaceLocator["resources"];
    };
    return {
      id: row.id,
      image: config.image,
      environment: config.variables,
      ports: config.ports,
      resources: config.resources,
      externalRef: row.externalRef,
      volumeRef: row.volumeRef,
    };
  }

  private async story(scope: SessionScope, db = this.db) {
    const row = (
      await db
        .select()
        .from(stories)
        .where(
          and(
            eq(stories.orgId, scope.orgId),
            eq(stories.projectId, scope.projectId),
            eq(stories.id, scope.storyId),
          ),
        )
        .limit(1)
    )[0];
    if (!row || row.deletedAt) throw new ApiError(404, "story_not_found", "Story not found");
    return row;
  }

  private async audit(
    db: FacilityDb,
    scope: SessionScope,
    userId: string,
    action: string,
    payload: Record<string, unknown>,
  ) {
    await db.insert(auditEvents).values({
      id: newId("evt"),
      orgId: scope.orgId,
      projectId: scope.projectId,
      actor: { type: "user", id: userId },
      action,
      target: { type: "story", id: scope.storyId },
      payload,
    });
  }
}
