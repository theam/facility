import { newId } from "@facility/core";
import {
  actionTypes,
  type FacilityDb,
  insertAuditEvent,
  proposalEvents,
  proposals,
  repos,
  runEvents,
  runs,
} from "@facility/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  type BuilderPlanDenialCode,
  builderIdentity,
  builderPlanDenialCode,
  builderPlanRequired,
  recordBuilderPlanDenial,
  withBuilderPlanPreflight,
} from "../builder-plan-policy.js";
import { ApiError } from "../errors.js";
import { executeApprovedProposal, loadPlanBuilderRun } from "../executors.js";
import { appendRunEvents } from "../sandbox/state.js";
import { findAgentDef, laneFor } from "./agent-routing.js";
import { type FacilityGithubClient, GithubIssueContextTooLargeError } from "./client.js";
import { syncRepoFacilityConfig } from "./kickstart.js";
import { renderGithubRunProgress } from "./run-progress.js";

export { findAgentDef, laneFor } from "./agent-routing.js";

export type TriggerPayload = {
  action?: string;
  comment?: { id?: number; body?: string };
  issue?: {
    number?: number;
    title?: string;
    body?: string | null;
    state?: string;
    node_id?: string;
    pull_request?: unknown;
    user?: { login?: string };
    labels?: Array<string | { name?: string }>;
    html_url?: string;
  };
  repository?: { id?: number; name?: string; owner?: { login?: string }; default_branch?: string };
  sender?: { login?: string; type?: string };
};

export type GithubIssueCommentContext = {
  id: number;
  author: string;
  authorType: string;
  body: string;
  createdAt: string;
  url: string;
};

export const ISSUE_CONTEXT_MAX_CHARS = 512 * 1024;

const COMMAND_RE =
  /(?:^|\n)\s*\/(builder|architect|codex-builder|codex-architect)(?=$|[\s,.:;!?)])/g;

export function resolveSlashCommand(body: string): {
  command?: string;
  agentCommand?: string;
  ambiguous: boolean;
} {
  const commands = [...body.matchAll(COMMAND_RE)].map((match) => match[1]).filter(Boolean);
  const unique = [...new Set(commands)];
  if (unique.length !== 1) return { ambiguous: unique.length > 1 };
  const raw = unique[0] ?? "";
  return { command: raw.replace(/^codex-/, ""), agentCommand: raw, ambiguous: false };
}

export function githubTriggerRequiresClient(payload: TriggerPayload) {
  if (payload.sender?.type === "Bot") return false;
  if (payload.comment && payload.action && payload.action !== "created") return false;
  if (!payload.comment && payload.action && payload.action !== "opened") return false;
  if (payload.issue?.pull_request) return false;
  const body =
    payload.comment?.body ?? [payload.issue?.title ?? "", payload.issue?.body ?? ""].join("\n");
  const command = resolveSlashCommand(body);
  return !command.ambiguous && Boolean(command.command);
}

export async function routeTrigger(
  db: FacilityDb,
  orgId: string,
  client: FacilityGithubClient,
  payload: TriggerPayload,
  enqueue?: (queue: string, data: Record<string, unknown>) => Promise<unknown>,
  githubDeliveryId?: string,
): Promise<{ routed: boolean; reason?: string; runId?: string }> {
  if (payload.sender?.type === "Bot") return { routed: false, reason: "bot_sender" };
  if (payload.comment && payload.action && payload.action !== "created") {
    return { routed: false, reason: "unsupported_action" };
  }
  if (!payload.comment && payload.action && payload.action !== "opened") {
    return { routed: false, reason: "unsupported_action" };
  }
  const body =
    payload.comment?.body ?? [payload.issue?.title ?? "", payload.issue?.body ?? ""].join("\n");
  const resolved = resolveSlashCommand(body);
  if (resolved.ambiguous) return { routed: false, reason: "ambiguous_command" };
  const command = resolved.command;
  if (!command) return { routed: false, reason: "no_command" };
  const owner = payload.repository?.owner?.login;
  const name = payload.repository?.name;
  const sender = payload.sender?.login;
  const issueNumber = payload.issue?.number;
  const commentId = payload.comment?.id;
  if (!owner || !name || !sender || !issueNumber) {
    return { routed: false, reason: "missing_payload" };
  }
  // Updating an existing PR requires a distinct delivery contract (checkout its
  // head and update it instead of opening another PR). Keep those invocations on
  // the repository lane until that contract is implemented and verified.
  if (payload.issue?.pull_request) {
    return { routed: false, reason: "pull_request_repo_lane" };
  }
  // Scope to the webhook's resolved org — repos are per-org unique (migration
  // 0012), so a global owner/name lookup could route to another tenant's repo.
  const repo = (
    await db
      .select()
      .from(repos)
      .where(and(eq(repos.orgId, orgId), eq(repos.owner, owner), eq(repos.name, name)))
      .limit(1)
  )[0];
  if (!repo) return { routed: false, reason: "repo_unmanaged" };
  if (!(await client.userCanWrite(sender))) return { routed: false, reason: "non_writer" };
  if (githubDeliveryId) {
    const replayedRunId = await resumeGithubDeliveryRun(db, repo.orgId, githubDeliveryId, enqueue);
    if (replayedRunId) return { routed: true, reason: "delivery_replayed", runId: replayedRunId };
  }
  // Reconcile from the default branch at handoff time, not only from an earlier
  // push delivery. This closes the merge/webhook race where the repository
  // workflow has already yielded to Facility but the database still has the
  // previous lane configuration.
  const renderAnswers = await syncRepoFacilityConfig({ db, client, repo });
  const lane = laneFor({ ...repo, renderAnswers }, resolved.agentCommand ?? command);
  if (lane !== "platform") return { routed: false, reason: "repo_lane" };
  const agent = await findAgentDef(
    db,
    repo.orgId,
    repo.projectId,
    resolved.agentCommand ?? command,
  );
  if (!agent) return { routed: false, reason: "no_agent" };
  const issueComments = await loadGithubIssueComments(client, issueNumber);
  const request = githubRequestContext(payload, issueComments);
  assertGithubRequestContextSize(request);
  const governedBuilder = builderIdentity(command, agent.name);
  let accepted = governedBuilder
    ? await githubPlanAcceptance(db, {
        orgId: repo.orgId,
        projectId: repo.projectId,
        owner,
        repo: name,
        issueNumber,
      })
    : null;
  // `optional` is the backwards-compatible default. Before the policy seam,
  // only a non-expired open/approved/executing/executed proposal participated
  // in /builder routing; every other lifecycle state fell through to an
  // ordinary Builder command. Preserve that exact behavior unless the project
  // explicitly enabled the required gate.
  if (
    accepted?.proposal &&
    !(await builderPlanRequired(db, repo.orgId, repo.projectId)) &&
    (!["open", "approved", "executing", "executed"].includes(accepted.proposal.state) ||
      accepted.proposal.expiresAt.getTime() <= Date.now())
  ) {
    accepted = null;
  }
  const githubTrigger = {
    type: "github_comment",
    githubLogin: sender,
    repo: { id: repo.id, owner, name },
    issue: { number: issueNumber },
    ...(commentId ? { comment: { id: commentId } } : {}),
    // Preserve the end-user request in the immutable run scope. The runner
    // treats scope as untrusted data beneath the agent contract, but without
    // this context an agent only received numeric GitHub IDs and could not know
    // what work the user requested.
    request,
  };
  const runGh = {
    owner,
    repo: name,
    issueNumber,
    ...(commentId ? { commentId } : {}),
    ...(payload.issue?.node_id ? { issueNodeId: payload.issue.node_id } : {}),
  };
  const githubActor = { type: "user" as const, id: `github:${sender}`, name: sender };
  let run: typeof runs.$inferSelect | undefined;
  let approvedByThisInvocation = false;
  if (governedBuilder && accepted?.proposal) {
    const approvalCommentId = await githubProposalApprovalCommentId(db, accepted.proposal);
    const sameApprovalComment = typeof commentId === "number" && approvalCommentId === commentId;
    const executedRun =
      accepted.proposal.state === "executed"
        ? await loadPlanBuilderRun(db, accepted.proposal)
        : undefined;
    const recoverableExecutedRun =
      sameApprovalComment && executedRun?.status === "queued" && !executedRun.githubDeliveryId
        ? executedRun
        : undefined;
    const recoverableInFlight =
      sameApprovalComment &&
      ["approved", "executing", "execution_failed"].includes(accepted.proposal.state);
    let executableProposal: typeof proposals.$inferSelect;
    if (accepted.proposal.state !== "open" && !recoverableInFlight && !recoverableExecutedRun) {
      const reason = await githubProposalDenialCode(db, accepted.proposal);
      await recordBuilderPlanDenial(
        db,
        {
          orgId: repo.orgId,
          projectId: repo.projectId,
          mode: agent.name,
          agentDefId: agent.id,
          trigger: {
            source: "plan_acceptance",
            proposalId: accepted.proposal.id,
            architectRunId: accepted.architectRun.id,
          },
          gh: runGh,
          actor: githubActor,
          source: "github_builder_replay",
        },
        reason,
        `proposal_${accepted.proposal.state}`,
      );
      return {
        routed: false,
        reason,
        runId: accepted.blockedRunId ?? undefined,
      };
    } else if (accepted.proposal.state === "open") {
      const approvedAt = new Date();
      const approved = await db.transaction(async (tx) => {
        const claimed = (
          await tx
            .update(proposals)
            .set({
              state: "approved",
              decidedBy: githubActor.id,
              decidedAt: approvedAt,
              updatedAt: approvedAt,
            })
            .where(
              and(
                eq(proposals.orgId, accepted.proposal.orgId),
                eq(proposals.id, accepted.proposal.id),
                eq(proposals.state, "open"),
                sql`${proposals.expiresAt} > now()`,
              ),
            )
            .returning()
        )[0];
        if (!claimed) return null;
        const latest = await tx
          .select({ seq: proposalEvents.seq })
          .from(proposalEvents)
          .where(
            and(eq(proposalEvents.orgId, claimed.orgId), eq(proposalEvents.proposalId, claimed.id)),
          )
          .orderBy(desc(proposalEvents.seq))
          .limit(1);
        await tx.insert(proposalEvents).values({
          orgId: claimed.orgId,
          proposalId: claimed.id,
          seq: (latest[0]?.seq ?? 0) + 1,
          type: "approved",
          actor: githubActor,
          data: { source: "github_command", commentId: commentId ?? null },
        });
        return claimed;
      });
      if (!approved) {
        const current = (
          await db
            .select()
            .from(proposals)
            .where(
              and(
                eq(proposals.orgId, accepted.proposal.orgId),
                eq(proposals.id, accepted.proposal.id),
              ),
            )
            .limit(1)
        )[0];
        const currentApprovalCommentId = current
          ? await githubProposalApprovalCommentId(db, current)
          : null;
        if (
          current &&
          currentApprovalCommentId === commentId &&
          ["approved", "executing", "execution_failed"].includes(current.state)
        ) {
          // A concurrent request may have claimed the open proposal, or the
          // prior process may have died after that claim. The canonical
          // executor is idempotent for plan acceptance and safely resumes it.
          executableProposal = current;
        } else {
          const reason = current
            ? await githubProposalDenialCode(db, current)
            : "builder_plan_context_invalid";
          await recordBuilderPlanDenial(
            db,
            {
              orgId: repo.orgId,
              projectId: repo.projectId,
              mode: agent.name,
              agentDefId: agent.id,
              trigger: {
                source: "plan_acceptance",
                proposalId: accepted.proposal.id,
                architectRunId: accepted.architectRun.id,
              },
              gh: runGh,
              actor: githubActor,
              source: "github_builder_approval_cas",
            },
            reason,
            "proposal_approval_cas_miss",
          );
          return {
            routed: false,
            reason,
          };
        }
      } else {
        approvedByThisInvocation = true;
        executableProposal = approved;
      }
    } else {
      // Recover a process crash after approval, or an executor failure after it
      // inserted the unique Builder row but before it finalized the proposal.
      // executeApprovedProposal owns the CAS and exact-row reuse semantics.
      executableProposal = accepted.proposal;
    }
    // Keep this route as the single dispatch owner. The canonical executor
    // creates/reuses the governed row and queued event; we attach delivery and
    // GitHub progress metadata below before enqueueing exactly once. A crash in
    // this window is recovered by the queued-run reconciler.
    if (executableProposal.state !== "executed") {
      await executeApprovedProposal(db, executableProposal, githubActor, {
        githubClient: { owner, repo: name, client },
      });
    }
    const executed = (
      await db
        .select()
        .from(proposals)
        .where(
          and(
            eq(proposals.orgId, executableProposal.orgId),
            eq(proposals.id, executableProposal.id),
          ),
        )
        .limit(1)
    )[0];
    if (executed?.state !== "executed") {
      const last = (
        await db
          .select()
          .from(proposalEvents)
          .where(
            and(
              eq(proposalEvents.orgId, executableProposal.orgId),
              eq(proposalEvents.proposalId, executableProposal.id),
              eq(proposalEvents.type, "execution_failed"),
            ),
          )
          .orderBy(desc(proposalEvents.seq))
          .limit(1)
      )[0];
      return {
        routed: false,
        reason:
          stringValue(objectOrEmpty(last?.data).error) ??
          (executed?.state === "execution_failed"
            ? "builder_plan_context_invalid"
            : "insert_failed"),
      };
    }
    run = recoverableExecutedRun ?? (await loadPlanBuilderRun(db, executableProposal));
    if (!run) return { routed: false, reason: "insert_failed" };
    const canonicalRun = run;
    run = (
      await db
        .update(runs)
        .set({
          githubDeliveryId,
          gh: { ...objectOrEmpty(run.gh), ...runGh },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(runs.orgId, canonicalRun.orgId),
            eq(runs.id, canonicalRun.id),
            ...(githubDeliveryId ? [isNull(runs.githubDeliveryId)] : []),
          ),
        )
        .returning()
    )[0];
    if (!run) {
      if (githubDeliveryId) {
        const replayedRunId = await resumeGithubDeliveryRun(
          db,
          repo.orgId,
          githubDeliveryId,
          enqueue,
        );
        if (replayedRunId) {
          return { routed: true, reason: "delivery_replayed", runId: replayedRunId };
        }
      }
      return {
        routed: false,
        reason: "builder_plan_already_consumed",
        runId: canonicalRun.id,
      };
    }
  } else {
    try {
      run = (
        await withBuilderPlanPreflight(
          db,
          {
            orgId: repo.orgId,
            projectId: repo.projectId,
            mode: command,
            agentDefId: agent.id,
            trigger: githubTrigger,
            gh: runGh,
            actor: githubActor,
            source: "github_slash_command",
          },
          (tx, admission) =>
            tx
              // builder-plan-preflight: github_slash_command
              .insert(runs)
              .values({
                id: newId("run"),
                orgId: repo.orgId,
                projectId: repo.projectId,
                agentDefId: agent.id,
                githubDeliveryId,
                mode: admission.mode,
                engine: agent.engine,
                trigger: githubTrigger,
                gh: runGh,
                createdBy: { type: "github", id: sender },
              })
              .onConflictDoNothing()
              .returning(),
        )
      )[0];
    } catch (error) {
      if (error instanceof ApiError) return { routed: false, reason: error.code };
      throw error;
    }
  }
  if (!run && githubDeliveryId) {
    const replayedRunId = await resumeGithubDeliveryRun(db, repo.orgId, githubDeliveryId, enqueue);
    if (replayedRunId) return { routed: true, reason: "delivery_replayed", runId: replayedRunId };
  }
  if (!run) return { routed: false, reason: "insert_failed" };
  try {
    const assigned = await client.assignIssue(issueNumber, sender);
    if (!assigned) {
      await auditAssignmentSkipped(db, repo, run.id, issueNumber, sender, "github_rejected");
    }
  } catch (error) {
    await auditAssignmentSkipped(
      db,
      repo,
      run.id,
      issueNumber,
      sender,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (accepted?.proposal) {
    await insertAuditEvent(db, {
      orgId: accepted.proposal.orgId,
      projectId: accepted.proposal.projectId,
      actor: { type: "user", id: `github:${sender}`, name: sender },
      action: approvedByThisInvocation ? "hitl.decided" : "hitl.execution_recovered",
      target: { type: "proposal", id: accepted.proposal.id },
      payload: approvedByThisInvocation
        ? { decision: "approve", source: "github_command", builder_run_id: run.id }
        : { source: "github_command", builder_run_id: run.id },
    });
  }
  await db
    .insert(runEvents)
    .values({
      orgId: repo.orgId,
      runId: run.id,
      seq: 1,
      type: "queued",
      data: { queue: "runs.dispatch" },
    })
    .onConflictDoNothing();
  // Actually dispatch to a sandbox — parity with manual run creation. The
  // slash-command path created the run but never enqueued it, so it never ran.
  // The GitHub comment is the end-user's live surface for this run. Comment
  // failures are recorded but never duplicate or suppress an already-created
  // run; the dispatcher/reconciler remains the source of execution truth.
  const progressClaim = {
    pending: true,
    token: githubDeliveryId ?? `comment:${commentId ?? run.id}`,
  };
  const progressOwner = (
    await db
      .update(runs)
      .set({
        gh: sql`jsonb_set(coalesce(${runs.gh}, '{}'::jsonb), '{progressComment}', ${JSON.stringify(
          progressClaim,
        )}::jsonb, true)`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(runs.orgId, repo.orgId),
          eq(runs.id, run.id),
          sql`${runs.gh}->'progressComment' is null`,
        ),
      )
      .returning({ id: runs.id })
  )[0];
  if (progressOwner) {
    try {
      const progress = await client.createIssueComment(
        issueNumber,
        renderGithubRunProgress({
          runId: run.id,
          mode: command,
          command: `/${resolved.agentCommand ?? command}`,
          phase: "queued",
          issueNumber,
          issueTitle: payload.issue?.title,
          sender,
        }),
      );
      const progressComment = {
        id: progress.id,
        url: progress.url ?? null,
        command: `/${resolved.agentCommand ?? command}`,
        sender,
        issueTitle: payload.issue?.title ?? null,
      };
      await db
        .update(runs)
        .set({
          gh: sql`jsonb_set(${runs.gh}, '{progressComment}', ${JSON.stringify(
            progressComment,
          )}::jsonb, true)`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(runs.orgId, repo.orgId),
            eq(runs.id, run.id),
            sql`${runs.gh}->'progressComment' @> ${JSON.stringify(progressClaim)}::jsonb`,
          ),
        );
    } catch (error) {
      await db
        .update(runs)
        .set({ gh: sql`${runs.gh} - 'progressComment'`, updatedAt: new Date() })
        .where(
          and(
            eq(runs.orgId, repo.orgId),
            eq(runs.id, run.id),
            sql`${runs.gh}->'progressComment' @> ${JSON.stringify(progressClaim)}::jsonb`,
          ),
        );
      await appendRunEvents(db, repo.orgId, run.id, [
        {
          type: "artifact_error",
          data: {
            kind: "github_progress_comment_failed",
            error: error instanceof Error ? error.message : String(error),
          },
        },
      ]);
    }
  }
  await enqueue?.("runs.dispatch", { runId: run.id, orgId: repo.orgId });
  return { routed: true, runId: run.id };
}

async function resumeGithubDeliveryRun(
  db: FacilityDb,
  orgId: string,
  githubDeliveryId: string,
  enqueue?: (queue: string, data: Record<string, unknown>) => Promise<unknown>,
) {
  const [run] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.orgId, orgId), eq(runs.githubDeliveryId, githubDeliveryId)))
    .limit(1);
  if (!run) return null;
  await db
    .insert(runEvents)
    .values({
      orgId,
      runId: run.id,
      seq: 1,
      type: "queued",
      data: { queue: "runs.dispatch", source: "github_delivery_replay" },
    })
    .onConflictDoNothing();
  await enqueue?.("runs.dispatch", { runId: run.id, orgId });
  return run.id;
}

async function auditAssignmentSkipped(
  db: FacilityDb,
  repo: typeof repos.$inferSelect,
  runId: string,
  issueNumber: number,
  login: string,
  reason: string,
) {
  await insertAuditEvent(db, {
    orgId: repo.orgId,
    projectId: repo.projectId,
    actor: { type: "user", id: `github:${login}`, name: login },
    action: "github.assignment.skipped",
    target: { type: "issue", id: `${repo.id}:${issueNumber}` },
    payload: { runId, issueNumber, login, reason },
  });
}

async function githubPlanAcceptance(
  db: FacilityDb,
  input: {
    orgId: string;
    projectId: string;
    owner: string;
    repo: string;
    issueNumber: number;
  },
) {
  const latest = (
    await db
      .select({ proposal: proposals, architectRun: runs })
      .from(proposals)
      .innerJoin(actionTypes, eq(actionTypes.id, proposals.actionTypeId))
      .innerJoin(runs, eq(runs.id, proposals.runId))
      .where(
        and(
          eq(proposals.orgId, input.orgId),
          eq(proposals.projectId, input.projectId),
          eq(actionTypes.name, "plan_acceptance"),
          eq(runs.status, "succeeded"),
          sql`${runs.gh} ->> 'owner' = ${input.owner}`,
          sql`${runs.gh} ->> 'repo' = ${input.repo}`,
          sql`(${runs.gh} ->> 'issueNumber')::int = ${input.issueNumber}`,
        ),
      )
      .orderBy(desc(proposals.createdAt))
      .limit(1)
  )[0];
  if (!latest) return null;
  const existing = await loadPlanBuilderRun(db, latest.proposal);
  return { ...latest, blockedRunId: existing?.id ?? null };
}

async function githubProposalDenialCode(
  db: FacilityDb,
  proposal: typeof proposals.$inferSelect,
): Promise<BuilderPlanDenialCode> {
  if (proposal.state === "rejected") return "builder_plan_rejected";
  if (proposal.state === "expired") return "builder_plan_expired";
  if (["approved", "executing", "executed"].includes(proposal.state)) {
    return "builder_plan_already_consumed";
  }
  if (proposal.state === "execution_failed") {
    const last = (
      await db
        .select({ data: proposalEvents.data })
        .from(proposalEvents)
        .where(
          and(
            eq(proposalEvents.orgId, proposal.orgId),
            eq(proposalEvents.proposalId, proposal.id),
            eq(proposalEvents.type, "execution_failed"),
          ),
        )
        .orderBy(desc(proposalEvents.seq))
        .limit(1)
    )[0];
    return builderPlanDenialCode(objectOrEmpty(last?.data).error) ?? "builder_plan_context_invalid";
  }
  if (proposal.expiresAt.getTime() <= Date.now()) return "builder_plan_expired";
  return "builder_plan_context_invalid";
}

async function githubProposalApprovalCommentId(
  db: FacilityDb,
  proposal: typeof proposals.$inferSelect,
) {
  const event = (
    await db
      .select({ data: proposalEvents.data })
      .from(proposalEvents)
      .where(
        and(
          eq(proposalEvents.orgId, proposal.orgId),
          eq(proposalEvents.proposalId, proposal.id),
          eq(proposalEvents.type, "approved"),
        ),
      )
      .orderBy(desc(proposalEvents.seq))
      .limit(1)
  )[0];
  const commentId = objectOrEmpty(event?.data).commentId;
  return typeof commentId === "number" && Number.isInteger(commentId) ? commentId : null;
}

export function githubRequestContext(
  payload: TriggerPayload,
  comments: GithubIssueCommentContext[] = [],
) {
  return {
    title: nullableText(payload.issue?.title),
    body: nullableText(payload.issue?.body),
    ...(payload.issue?.state === "open" || payload.issue?.state === "closed"
      ? { state: payload.issue.state }
      : {}),
    comment: nullableText(payload.comment?.body),
    author: nullableText(payload.issue?.user?.login),
    url: nullableText(payload.issue?.html_url),
    labels: (payload.issue?.labels ?? []).flatMap((label) => {
      const name = typeof label === "string" ? label : label.name;
      return typeof name === "string" && name.trim() ? [name.trim()] : [];
    }),
    comments: comments.map((entry) => ({
      id: entry.id,
      author: entry.author,
      authorType: entry.authorType,
      body: entry.body,
      createdAt: entry.createdAt,
      url: entry.url,
    })),
  };
}

export function assertGithubRequestContextSize(context: unknown) {
  if (JSON.stringify(context).length > ISSUE_CONTEXT_MAX_CHARS) {
    throw new ApiError(
      413,
      "issue_context_too_large",
      "The complete GitHub issue context is too large for a governed run",
    );
  }
}

export async function loadGithubIssueComments(client: FacilityGithubClient, issueNumber: number) {
  try {
    return await client.listIssueComments(issueNumber, ISSUE_CONTEXT_MAX_CHARS);
  } catch (error) {
    if (error instanceof GithubIssueContextTooLargeError) {
      throw new ApiError(
        413,
        "issue_context_too_large",
        "The complete GitHub issue context is too large for a governed run",
      );
    }
    throw error;
  }
}

function nullableText(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
