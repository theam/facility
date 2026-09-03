import { actionTypes, type FacilityDb, proposalEvents, proposals, runs } from "@facility/db";
import { and, desc, eq, gt, ne, sql } from "drizzle-orm";

export const PLAN_ACCEPTANCE_PROPOSAL_ID_RE = /^prop_[0-9a-z_]+$/i;

export type GithubPlanAcceptanceIssueScope = {
  orgId: string;
  projectId: string;
  owner: string;
  repo: string;
  issueNumber: number;
};

export type GithubPlanAcceptanceRow = {
  proposal: typeof proposals.$inferSelect;
  architectRun: typeof runs.$inferSelect;
};

export type GithubPlanAcceptanceResolution =
  | ({ status: "resolved" } & GithubPlanAcceptanceRow)
  | { status: "ambiguous"; liveProposalIds: string[] };

export type GithubPlanAcceptanceCreateInput = {
  orgId: string;
  projectId: string;
  repoId: string;
  owner: string;
  repo: string;
  issueNumber: number;
  architectRunId: string;
  actionTypeId: string;
  proposalId: string;
  payload: Record<string, unknown>;
  contextMd: string;
  expiresAt: Date;
};

function githubIssueScopeWhere(input: GithubPlanAcceptanceIssueScope) {
  return and(
    eq(proposals.orgId, input.orgId),
    eq(proposals.projectId, input.projectId),
    eq(actionTypes.name, "plan_acceptance"),
    eq(runs.status, "succeeded"),
    sql`${runs.gh} ->> 'owner' = ${input.owner}`,
    sql`${runs.gh} ->> 'repo' = ${input.repo}`,
    sql`(${runs.gh} ->> 'issueNumber')::int = ${input.issueNumber}`,
  );
}

function liveOpenPlanAcceptanceWhere(now = new Date()) {
  return and(eq(proposals.state, "open"), gt(proposals.expiresAt, now));
}

/** Issue-scoped lock so concurrent Architect completions serialize Gate 1 creation. */
export function githubPlanAcceptanceIssueLockKey(input: {
  orgId: string;
  repoId: string;
  issueNumber: number;
}) {
  return `architect-plan-issue:${input.orgId}:${input.repoId}:${input.issueNumber}`;
}

export async function listLiveGithubPlanAcceptances(
  db: FacilityDb,
  input: GithubPlanAcceptanceIssueScope,
  now = new Date(),
): Promise<GithubPlanAcceptanceRow[]> {
  return db
    .select({ proposal: proposals, architectRun: runs })
    .from(proposals)
    .innerJoin(actionTypes, eq(actionTypes.id, proposals.actionTypeId))
    .innerJoin(runs, eq(runs.id, proposals.runId))
    .where(and(githubIssueScopeWhere(input), liveOpenPlanAcceptanceWhere(now)))
    .orderBy(desc(proposals.createdAt));
}

async function latestGithubPlanAcceptance(
  db: FacilityDb,
  input: GithubPlanAcceptanceIssueScope,
): Promise<GithubPlanAcceptanceRow | null> {
  const latest = (
    await db
      .select({ proposal: proposals, architectRun: runs })
      .from(proposals)
      .innerJoin(actionTypes, eq(actionTypes.id, proposals.actionTypeId))
      .innerJoin(runs, eq(runs.id, proposals.runId))
      .where(githubIssueScopeWhere(input))
      .orderBy(desc(proposals.createdAt))
      .limit(1)
  )[0];
  return latest ?? null;
}

async function githubPlanAcceptanceById(
  db: FacilityDb,
  input: GithubPlanAcceptanceIssueScope & { proposalId: string },
): Promise<GithubPlanAcceptanceRow | null> {
  const match = (
    await db
      .select({ proposal: proposals, architectRun: runs })
      .from(proposals)
      .innerJoin(actionTypes, eq(actionTypes.id, proposals.actionTypeId))
      .innerJoin(runs, eq(runs.id, proposals.runId))
      .where(and(githubIssueScopeWhere(input), eq(proposals.id, input.proposalId)))
      .limit(1)
  )[0];
  return match ?? null;
}

export async function resolveGithubPlanAcceptance(
  db: FacilityDb,
  input: GithubPlanAcceptanceIssueScope & { proposalId?: string },
  now = new Date(),
): Promise<GithubPlanAcceptanceResolution | null> {
  if (input.proposalId) {
    const explicit = await githubPlanAcceptanceById(db, {
      ...input,
      proposalId: input.proposalId,
    });
    return explicit ? { status: "resolved", ...explicit } : null;
  }

  const live = await listLiveGithubPlanAcceptances(db, input, now);
  if (live.length > 1) {
    return { status: "ambiguous", liveProposalIds: live.map((row) => row.proposal.id) };
  }
  if (live.length === 1) {
    const [only] = live;
    if (!only) return null;
    return { status: "resolved", ...only };
  }

  const latest = await latestGithubPlanAcceptance(db, input);
  return latest ? { status: "resolved", ...latest } : null;
}

/**
 * Cancel other live Gate 1 proposals on the same issue.
 * Caller must already hold the issue advisory lock inside a transaction.
 * Operates on the caller's connection — no nested transactions — so create +
 * supersede can commit or roll back together.
 */
export async function supersedeOpenGithubPlanAcceptances(
  db: FacilityDb,
  input: {
    orgId: string;
    projectId: string;
    repoId: string;
    issueNumber: number;
    architectRunId: string;
    keepProposalId: string;
  },
  now = new Date(),
) {
  const stale = await db
    .select({ proposal: proposals })
    .from(proposals)
    .innerJoin(actionTypes, eq(actionTypes.id, proposals.actionTypeId))
    .where(
      and(
        eq(proposals.orgId, input.orgId),
        eq(proposals.projectId, input.projectId),
        eq(actionTypes.name, "plan_acceptance"),
        eq(proposals.state, "open"),
        gt(proposals.expiresAt, now),
        sql`(${proposals.payload} ->> 'issueNumber')::int = ${input.issueNumber}`,
        sql`${proposals.payload} ->> 'repoId' = ${input.repoId}`,
        ne(proposals.id, input.keepProposalId),
      ),
    );
  let superseded = 0;
  for (const row of stale) {
    const updated = (
      await db
        .update(proposals)
        .set({ state: "cancelled", updatedAt: now })
        .where(
          and(
            eq(proposals.orgId, row.proposal.orgId),
            eq(proposals.id, row.proposal.id),
            eq(proposals.state, "open"),
            gt(proposals.expiresAt, now),
          ),
        )
        .returning()
    )[0];
    if (!updated) continue;
    const latest = (
      await db
        .select({ seq: proposalEvents.seq })
        .from(proposalEvents)
        .where(
          and(eq(proposalEvents.orgId, updated.orgId), eq(proposalEvents.proposalId, updated.id)),
        )
        .orderBy(desc(proposalEvents.seq))
        .limit(1)
    )[0];
    await db.insert(proposalEvents).values({
      orgId: updated.orgId,
      proposalId: updated.id,
      seq: (latest?.seq ?? 0) + 1,
      type: "cancelled",
      actor: { type: "system", name: "architect_plan_supersede" },
      data: {
        reason: "superseded_by_architect_run",
        architectRunId: input.architectRunId,
        keptProposalId: input.keepProposalId,
      },
    });
    superseded += 1;
  }
  return superseded;
}

/**
 * Atomically open a Gate 1 proposal and cancel older live plans on the same
 * issue. Insert happens first so a create failure never leaves the issue
 * without a live plan. Concurrent Architect completions serialize on the
 * issue advisory lock held for the caller's transaction.
 */
export async function insertGithubPlanAcceptanceReplacingSiblings(
  db: FacilityDb,
  input: GithubPlanAcceptanceCreateInput,
  now = new Date(),
) {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${githubPlanAcceptanceIssueLockKey({
      orgId: input.orgId,
      repoId: input.repoId,
      issueNumber: input.issueNumber,
    })}, 0))`,
  );
  const created = (
    await db
      .insert(proposals)
      .values({
        id: input.proposalId,
        orgId: input.orgId,
        projectId: input.projectId,
        runId: input.architectRunId,
        actionTypeId: input.actionTypeId,
        payload: input.payload,
        contextMd: input.contextMd,
        expiresAt: input.expiresAt,
      })
      .returning()
  )[0];
  if (!created) throw new Error("plan_acceptance_create_failed");
  await db.insert(proposalEvents).values({
    orgId: input.orgId,
    proposalId: created.id,
    seq: 1,
    type: "open",
    actor: { type: "agent", id: input.architectRunId },
    data: { source: "architect_run" },
  });
  await supersedeOpenGithubPlanAcceptances(
    db,
    {
      orgId: input.orgId,
      projectId: input.projectId,
      repoId: input.repoId,
      issueNumber: input.issueNumber,
      architectRunId: input.architectRunId,
      keepProposalId: created.id,
    },
    now,
  );
  return created;
}
