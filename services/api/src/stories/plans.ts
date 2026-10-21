import { AgentManifestError, AgentManifestSchema } from "@facility/agents";
import {
  can,
  newId,
  type PlanActor,
  type PlanAgent,
  type PlanDecisionReview,
  type ProposeStoryPlan,
  type RequestPlanDecision,
  type StoryPlans,
} from "@facility/core";
import {
  type FacilityDb,
  orgMembers,
  projectRepositories,
  roles,
  stories,
  storyMessages,
  storyPlanDecisions,
  storyPlanRepositoryRefs,
  storyPlanRequests,
  storyPlanRevisions,
  storyPlanStates,
  users,
} from "@facility/db";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  ilike,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { AgentCatalogError, type AgentCatalogService } from "../agents/catalog.js";
import { ApiError } from "../errors.js";
import { appendStoryEvidence } from "./evidence.js";
import {
  type InteractivePlanActor,
  PLAN_CONFIRMATION_TTL_MS,
  planConfirmationProof,
  verifyPlanConfirmationProof,
} from "./plan-confirmation.js";
import {
  decisionProjection,
  type PlanScope,
  planMetadataProjection,
  planProjection,
  planState,
  type RequestRow,
  requestProjection,
  requestStatus,
  storyPlanDigest,
} from "./plan-state.js";

type Options = {
  webUrl: string;
  now?: Date;
  limit?: number;
  before_revision?: number;
  before_decision_revision?: number;
};
type ScopedTable = { orgId: AnyPgColumn; projectId: AnyPgColumn; storyId: AnyPgColumn };
const scoped = (table: ScopedTable, scope: PlanScope) =>
  and(
    eq(table.orgId, scope.orgId),
    eq(table.projectId, scope.projectId),
    eq(table.storyId, scope.storyId),
  );
const storyWhere = (scope: PlanScope) =>
  and(
    eq(stories.orgId, scope.orgId),
    eq(stories.projectId, scope.projectId),
    eq(stories.id, scope.storyId),
  );

/** Plan reads never refresh GitHub, dispatch an agent or touch a workspace. */
export function readStoryPlans(
  db: FacilityDb,
  scope: PlanScope,
  options: Options,
): Promise<StoryPlans> {
  return db.transaction((tx) => snapshot(tx as unknown as FacilityDb, scope, options), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

/** Scope picker exposes names only, under the permission required to propose a plan. */
export async function readStoryPlanRepositories(
  db: FacilityDb,
  scope: PlanScope,
  query: { q: string; limit: number; offset: number },
) {
  await assertStory(db, scope);
  const pattern = `%${query.q.replace(/[\\%_]/g, "\\$&")}%`;
  const rows = await db
    .select({
      owner: projectRepositories.owner,
      name: projectRepositories.name,
      role: projectRepositories.role,
    })
    .from(projectRepositories)
    .where(
      and(
        eq(projectRepositories.orgId, scope.orgId),
        eq(projectRepositories.projectId, scope.projectId),
        ilike(
          sql<string>`${projectRepositories.owner} || '/' || ${projectRepositories.name}`,
          pattern,
        ),
      ),
    )
    .orderBy(
      asc(projectRepositories.owner),
      asc(projectRepositories.name),
      asc(projectRepositories.id),
    )
    .limit(query.limit + 1)
    .offset(query.offset);
  return {
    items: rows
      .slice(0, query.limit)
      .map((row) => ({ repository: `${row.owner}/${row.name}`, primary: row.role === "primary" })),
    hasMore: rows.length > query.limit,
    nextOffset: rows.length > query.limit ? query.offset + query.limit : null,
  };
}

export async function readStoryPlanRevision(db: FacilityDb, scope: PlanScope, revision: number) {
  const [row] = await db
    .select()
    .from(storyPlanRevisions)
    .where(and(scoped(storyPlanRevisions, scope), eq(storyPlanRevisions.revision, revision)))
    .limit(1);
  if (!row) throw new ApiError(404, "not_found", "Plan revision not found");
  return planProjection(row);
}

export async function proposeStoryPlan(
  db: FacilityDb,
  catalog: AgentCatalogService,
  scope: PlanScope,
  body: ProposeStoryPlan,
  actor: PlanActor,
  options: Options,
): Promise<StoryPlans> {
  await assertStory(db, scope);
  const [preflight] = await db
    .select({ revision: storyPlanStates.revision })
    .from(storyPlanStates)
    .where(scoped(storyPlanStates, scope))
    .limit(1);
  if ((preflight?.revision ?? 0) !== body.expected_revision) throw revisionConflict();
  let refreshed: Awaited<ReturnType<AgentCatalogService["refreshSnapshot"]>>;
  // Network resolution runs outside the ledger transaction and its locks.
  try {
    refreshed = await catalog.refreshSnapshot(scope.orgId, scope.projectId);
  } catch (error) {
    if (error instanceof AgentCatalogError)
      throw new ApiError(error.statusCode, error.code, error.message, undefined, true);
    if (error instanceof AgentManifestError)
      throw new ApiError(
        409,
        "plan_catalog_invalid",
        "The agent catalog contains an invalid manifest. Ask a project owner to review its configuration",
      );
    throw error;
  }
  if (!refreshed.repositoryId)
    throw new ApiError(
      409,
      "plan_catalog_scope_unverified",
      "The catalog source did not identify its connected repository. Refresh from the project's canonical source",
    );
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as FacilityDb;
    // Bind the observed repository identity under the repository topology lock.
    // An intervening primary change, reconnect or foreign source cannot enter the ledger.
    await topologyLock(tx, scope);
    await assertStory(tx, scope);
    const [primary] = await tx
      .select()
      .from(projectRepositories)
      .where(
        and(
          eq(projectRepositories.orgId, scope.orgId),
          eq(projectRepositories.projectId, scope.projectId),
          eq(projectRepositories.role, "primary"),
        ),
      )
      .limit(1);
    if (!primary)
      throw new ApiError(
        409,
        "plan_catalog_repository_missing",
        "Connect a primary repository before proposing a plan",
      );
    if (refreshed.repositoryId !== primary.id)
      throw new ApiError(
        409,
        "plan_catalog_repository_changed",
        "The primary repository changed while resolving this plan. Review the current project scope and propose it again",
      );
    await storyLock(tx, scope);
    await assertStory(tx, scope, true);
    const context = await current(tx, scope);
    if (context.state.revision !== body.expected_revision) throw revisionConflict();
    const names = body.repositories.map((name) => name.toLowerCase());
    const selected = await tx
      .select()
      .from(projectRepositories)
      .where(
        and(
          eq(projectRepositories.orgId, scope.orgId),
          eq(projectRepositories.projectId, scope.projectId),
          inArray(
            sql<string>`lower(${projectRepositories.owner} || '/' || ${projectRepositories.name})`,
            names,
          ),
        ),
      );
    if (selected.length !== names.length)
      throw new ApiError(
        404,
        "plan_repository_not_found",
        "A selected repository is not connected to this project",
      );
    const repositories = selected
      .map((row) => ({ repositoryId: row.id, repository: `${row.owner}/${row.name}` }))
      .sort((a, b) => a.repository.localeCompare(b.repository));
    const agents: PlanAgent[] = body.agents
      .map((name) => {
        const parsed = AgentManifestSchema.safeParse(
          refreshed.manifests.find((item) => item.name === name),
        );
        if (!parsed.success || !parsed.data.enabled || parsed.data.name !== name)
          throw new ApiError(
            409,
            "plan_agent_unavailable",
            "A selected agent is missing, disabled or invalid. Refresh the agent selection",
          );
        const manifest = parsed.data;
        return {
          name,
          manifestHash: manifest.hash,
          engine: manifest.engine,
          model: manifest.model,
          repositoryId: primary.id,
          catalogCommitSha: refreshed.commitSha,
          observedAt: refreshed.observedAt.toISOString(),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    let source = null;
    if (body.source_message_id) {
      const [message] = await tx
        .select({
          id: storyMessages.id,
          body: storyMessages.body,
          turnId: storyMessages.turnId,
          role: storyMessages.role,
        })
        .from(storyMessages)
        .where(and(scoped(storyMessages, scope), eq(storyMessages.id, body.source_message_id)))
        .limit(1);
      if (!message)
        throw new ApiError(404, "plan_source_not_found", "The source message is not in this story");
      if (message.body !== body.markdown)
        throw new ApiError(
          409,
          "plan_source_changed",
          "The proposed text differs from the source message. Propose edited text without attributing it to that message",
        );
      source = { messageId: message.id, turnId: message.turnId, role: message.role };
    }
    const digest = storyPlanDigest(scope, {
      markdown: body.markdown,
      repositories,
      agents,
      sourceMessageId: body.source_message_id ?? null,
    });
    if (context.plan?.digest === digest) return snapshot(tx, scope, options);
    const revision = context.state.revision + 1;
    await tx.insert(storyPlanRevisions).values({
      ...scope,
      revision,
      digest,
      markdown: body.markdown,
      repositories,
      agents,
      proposedBy: actor,
      sourceMessageId: body.source_message_id ?? null,
      source,
    });
    const references = [...new Set([primary.id, ...repositories.map((repo) => repo.repositoryId)])];
    await tx
      .insert(storyPlanRepositoryRefs)
      .values(references.map((repositoryId) => ({ ...scope, revision, repositoryId })));
    await tx
      .insert(storyPlanStates)
      .values({ ...scope, revision })
      .onConflictDoUpdate({
        target: storyPlanStates.storyId,
        set: { revision, updatedAt: new Date() },
      });
    await appendStoryEvidence(tx, {
      ...scope,
      source: "facility",
      type: "plan.proposed",
      externalKey: `plan:revision:${revision}`,
      data: { revision, digest, repositories, agents, source, actor },
    });
    return snapshot(tx, scope, options);
  });
}

export function requestStoryPlanDecision(
  db: FacilityDb,
  scope: PlanScope,
  body: RequestPlanDecision,
  actor: PlanActor,
  options: Options,
) {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as FacilityDb;
    await storyLock(tx, scope);
    await assertStory(tx, scope, true);
    const context = await current(tx, scope);
    assertCurrent(body.expected_revision, body.expected_decision_revision, context.state);
    if (!context.plan) throw revisionConflict();
    const now = options.now ?? new Date();
    const [row] = await tx
      .insert(storyPlanRequests)
      .values({
        id: newId("dreq"),
        ...scope,
        planRevision: context.plan.revision,
        planDigest: context.plan.digest,
        decisionRevision: context.state.decisionRevision,
        intent: body.intent,
        reason: body.reason || null,
        requestedBy: actor,
        boundUserId: actor.type === "user" ? actor.id : null,
        requestedAt: now,
        expiresAt: new Date(now.getTime() + PLAN_CONFIRMATION_TTL_MS),
      })
      .returning();
    if (!row) throw Error("Plan decision request was not inserted");
    await appendStoryEvidence(tx, {
      ...scope,
      source: "facility",
      type: "plan.decision_requested",
      externalKey: `plan:request:${row.id}`,
      data: {
        requestId: row.id,
        revision: row.planRevision,
        digest: row.planDigest,
        intent: row.intent,
        reason: row.reason,
        actor,
        expiresAt: row.expiresAt.toISOString(),
      },
    });
    return {
      request: requestProjection(row, context.state, now, options.webUrl),
      state: context.state,
    };
  });
}

export function reviewStoryPlanDecision(
  db: FacilityDb,
  scope: PlanScope,
  requestId: string,
  actor: InteractivePlanActor,
  masterKey: string,
  options: Options,
): Promise<PlanDecisionReview> {
  return db.transaction(
    async (rawTx) => {
      const tx = rawTx as unknown as FacilityDb;
      await assertStory(tx, scope);
      const row = await decisionRequest(tx, scope, requestId, actor.id);
      const context = await current(tx, scope);
      const plan = await readStoryPlanRevision(tx, scope, row.planRevision);
      const [receipt] = await tx
        .select()
        .from(storyPlanDecisions)
        .where(and(scoped(storyPlanDecisions, scope), eq(storyPlanDecisions.requestId, row.id)))
        .limit(1);
      const now = options.now ?? new Date();
      return {
        schemaVersion: 1,
        ...scope,
        request: requestProjection(row, context.state, now, options.webUrl),
        plan,
        state: context.state,
        decision: receipt ? decisionProjection(receipt) : null,
        proof:
          requestStatus(row, context.state, now) === "pending"
            ? planConfirmationProof(proofBinding(row), actor, masterKey)
            : null,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/** Runs before the HTTP replay hook, so a bearer or changed session cannot bypass this guard. */
export async function checkStoryPlanConfirmation(
  db: FacilityDb,
  scope: PlanScope,
  requestId: string,
  proof: string,
  actor: InteractivePlanActor,
  masterKey: string,
  now = new Date(),
) {
  const row = await decisionRequest(db, scope, requestId, actor.id);
  verifyPlanConfirmationProof(proof, proofBinding(row), actor, masterKey, now);
}

export function confirmStoryPlanDecision(
  db: FacilityDb,
  scope: PlanScope,
  requestId: string,
  proof: string,
  actor: InteractivePlanActor,
  masterKey: string,
  options: Options,
): Promise<StoryPlans> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as FacilityDb;
    await storyLock(tx, scope);
    await assertStory(tx, scope, true);
    // Serialize membership, user deactivation and role edits with the receipt itself.
    const [member] = await tx
      .select({ permissions: roles.permissions })
      .from(orgMembers)
      .innerJoin(roles, eq(roles.id, orgMembers.roleId))
      .innerJoin(users, eq(users.id, orgMembers.userId))
      .where(
        and(
          eq(orgMembers.orgId, scope.orgId),
          eq(users.id, actor.id),
          eq(users.status, "active"),
          or(isNull(roles.orgId), eq(roles.orgId, scope.orgId)),
        ),
      )
      .for("share")
      .limit(1);
    if (!member || !can(member.permissions, "projects:write"))
      throw new ApiError(
        403,
        "forbidden",
        "Current project write permission is required to confirm a plan",
      );
    const row = await decisionRequest(tx, scope, requestId, actor.id);
    const now = options.now ?? new Date();
    verifyPlanConfirmationProof(proof, proofBinding(row), actor, masterKey, now);
    if (row.consumedAt)
      throw new ApiError(
        409,
        "plan_confirmation_consumed",
        "This request was already confirmed. Reload the plan to see its receipt",
      );
    const context = await current(tx, scope);
    assertCurrent(row.planRevision, row.decisionRevision, context.state);
    if (row.planDigest !== context.plan?.digest) throw revisionConflict();
    const decisionRevision = context.state.decisionRevision + 1;
    const confirmedBy = { type: "user" as const, id: actor.id, name: actor.name };
    const [decision] = await tx
      .insert(storyPlanDecisions)
      .values({
        id: newId("dec"),
        ...scope,
        decisionRevision,
        planRevision: row.planRevision,
        planDigest: row.planDigest,
        requestId: row.id,
        intent: row.intent,
        reason: row.reason,
        confirmedBy,
        confirmedAt: now,
      })
      .returning();
    if (!decision) throw Error("Plan decision was not inserted");
    await tx
      .update(storyPlanRequests)
      .set({ consumedAt: now, consumedByUserId: actor.id })
      .where(and(scoped(storyPlanRequests, scope), eq(storyPlanRequests.id, row.id)));
    await tx
      .update(storyPlanStates)
      .set({ decisionRevision, updatedAt: now })
      .where(scoped(storyPlanStates, scope));
    await appendStoryEvidence(tx, {
      ...scope,
      source: "facility",
      type: "plan.decision_confirmed",
      externalKey: `plan:decision:${decisionRevision}`,
      data: decisionProjection(decision),
    });
    return snapshot(tx, scope, options);
  });
}

async function snapshot(db: FacilityDb, scope: PlanScope, options: Options): Promise<StoryPlans> {
  await assertStory(db, scope);
  const context = await current(db, scope);
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
  const { markdown: _markdown, ...metadata } = getTableColumns(storyPlanRevisions);
  const history = await db
    .select(metadata)
    .from(storyPlanRevisions)
    .where(
      and(
        scoped(storyPlanRevisions, scope),
        lt(storyPlanRevisions.revision, options.before_revision ?? context.state.revision),
      ),
    )
    .orderBy(desc(storyPlanRevisions.revision))
    .limit(limit + 1);
  const decisions = await db
    .select()
    .from(storyPlanDecisions)
    .where(
      and(
        scoped(storyPlanDecisions, scope),
        options.before_decision_revision
          ? lt(storyPlanDecisions.decisionRevision, options.before_decision_revision)
          : undefined,
      ),
    )
    .orderBy(desc(storyPlanDecisions.decisionRevision))
    .limit(limit + 1);
  const pending = await db
    .select()
    .from(storyPlanRequests)
    .where(
      and(
        scoped(storyPlanRequests, scope),
        eq(storyPlanRequests.planRevision, context.state.revision),
        eq(storyPlanRequests.decisionRevision, context.state.decisionRevision),
        isNull(storyPlanRequests.consumedAt),
        gt(storyPlanRequests.expiresAt, now),
      ),
    )
    .orderBy(desc(storyPlanRequests.requestedAt), desc(storyPlanRequests.id))
    .limit(11);
  return {
    schemaVersion: 1,
    ...scope,
    generatedAt: now.toISOString(),
    state: context.state,
    plan: context.plan ? planProjection(context.plan) : null,
    decision: context.decision ? decisionProjection(context.decision) : null,
    history: {
      items: history.slice(0, limit).map(planMetadataProjection),
      hasMore: history.length > limit,
      nextBeforeRevision: history.length > limit ? (history[limit - 1]?.revision ?? null) : null,
    },
    decisions: {
      items: decisions.slice(0, limit).map(decisionProjection),
      hasMore: decisions.length > limit,
      nextBeforeRevision:
        decisions.length > limit ? (decisions[limit - 1]?.decisionRevision ?? null) : null,
    },
    pending: {
      items: pending
        .slice(0, 10)
        .map((row) => requestProjection(row, context.state, now, options.webUrl)),
      hasMore: pending.length > 10,
    },
  };
}

async function current(db: FacilityDb, scope: PlanScope) {
  const [stateRow] = await db
    .select()
    .from(storyPlanStates)
    .where(scoped(storyPlanStates, scope))
    .limit(1);
  const [plan] = stateRow
    ? await db
        .select()
        .from(storyPlanRevisions)
        .where(
          and(
            scoped(storyPlanRevisions, scope),
            eq(storyPlanRevisions.revision, stateRow.revision),
          ),
        )
        .limit(1)
    : [];
  const [decision] = stateRow?.decisionRevision
    ? await db
        .select()
        .from(storyPlanDecisions)
        .where(
          and(
            scoped(storyPlanDecisions, scope),
            eq(storyPlanDecisions.decisionRevision, stateRow.decisionRevision),
          ),
        )
        .limit(1)
    : [];
  return { plan, decision, state: planState(stateRow, decision) };
}

async function decisionRequest(
  db: FacilityDb,
  scope: PlanScope,
  requestId: string,
  userId: string,
): Promise<RequestRow> {
  const [row] = await db
    .select()
    .from(storyPlanRequests)
    .where(and(scoped(storyPlanRequests, scope), eq(storyPlanRequests.id, requestId)))
    .limit(1);
  if (!row) throw new ApiError(404, "not_found", "Plan confirmation request not found");
  if (row.boundUserId && row.boundUserId !== userId)
    throw new ApiError(
      403,
      "plan_confirmation_user_mismatch",
      "This confirmation was requested for another user",
    );
  return row;
}

async function assertStory(db: FacilityDb, scope: PlanScope, lock = false) {
  const query = db.select({ id: stories.id }).from(stories).where(storyWhere(scope)).limit(1);
  const [story] = await (lock ? query.for("update") : query);
  if (!story) throw new ApiError(404, "not_found", "Story not found");
}
async function topologyLock(db: FacilityDb, scope: PlanScope) {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`${scope.orgId}:${scope.projectId}`}))`,
  );
}
async function storyLock(db: FacilityDb, scope: PlanScope) {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`facility:story:${scope.orgId}:${scope.projectId}:${scope.storyId}`}))`,
  );
}
function proofBinding(row: RequestRow) {
  return { ...row, requestId: row.id };
}
function assertCurrent(revision: number, decisionRevision: number, state: StoryPlans["state"]) {
  if (revision !== state.revision || revision === 0) throw revisionConflict();
  if (decisionRevision !== state.decisionRevision)
    throw new ApiError(
      409,
      "plan_decision_conflict",
      "Another decision was recorded. Review the current plan and decision before trying again",
    );
}
function revisionConflict() {
  return new ApiError(
    409,
    "plan_revision_conflict",
    "The plan changed. Reload and review the current revision before continuing",
  );
}
