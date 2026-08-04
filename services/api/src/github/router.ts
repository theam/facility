import { newId } from "@facility/core";
import {
  actionTypes,
  agentDefs,
  type FacilityDb,
  insertAuditEvent,
  proposalEvents,
  proposals,
  repos,
  runEvents,
  runs,
} from "@facility/db";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { FacilityGithubClient } from "./client.js";
import { syncRepoFacilityConfig } from "./kickstart.js";
import { renderGithubRunProgress } from "./run-progress.js";

export type TriggerPayload = {
  action?: string;
  comment?: { id?: number; body?: string };
  issue?: {
    number?: number;
    title?: string;
    body?: string | null;
    node_id?: string;
    pull_request?: unknown;
  };
  repository?: { id?: number; name?: string; owner?: { login?: string }; default_branch?: string };
  sender?: { login?: string; type?: string };
};

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

export async function routeTrigger(
  db: FacilityDb,
  orgId: string,
  client: FacilityGithubClient,
  payload: TriggerPayload,
  enqueue?: (queue: string, data: Record<string, unknown>) => Promise<unknown>,
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
  const accepted =
    command === "builder"
      ? await githubPlanAcceptance(db, {
          orgId: repo.orgId,
          projectId: repo.projectId,
          owner,
          repo: name,
          issueNumber,
        })
      : null;
  if (accepted?.blockedRunId) {
    return { routed: false, reason: "plan_already_accepted", runId: accepted.blockedRunId };
  }
  const githubTrigger = {
    type: "github_comment",
    repo: { id: repo.id, owner, name },
    issue: { number: issueNumber },
    ...(commentId ? { comment: { id: commentId } } : {}),
    // Preserve the end-user request in the immutable run scope. The runner
    // treats scope as untrusted data beneath the agent contract, but without
    // this context an agent only received numeric GitHub IDs and could not know
    // what work the user requested.
    request: githubRequestContext(payload),
  };
  const run = await db.transaction(async (tx) => {
    if (accepted?.proposal) {
      const claimed = (
        await tx
          .update(proposals)
          .set({
            state: "executed",
            decidedBy: sender,
            decidedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(proposals.orgId, accepted.proposal.orgId),
              eq(proposals.id, accepted.proposal.id),
              eq(proposals.state, "open"),
            ),
          )
          .returning({ id: proposals.id })
      )[0];
      if (!claimed) throw new Error("github_plan_acceptance_not_open");
    }
    const created = (
      await tx
        .insert(runs)
        .values({
          id: newId("run"),
          orgId: repo.orgId,
          projectId: repo.projectId,
          agentDefId: agent.id,
          mode: command,
          engine: agent.engine,
          trigger: accepted?.proposal
            ? {
                source: "plan_acceptance",
                proposalId: accepted.proposal.id,
                architectRunId: accepted.architectRun.id,
                architectTrigger: accepted.architectRun.trigger,
                approvedPlan: accepted.proposal.contextMd,
                approval: { type: "github", login: sender, commentId: commentId ?? null },
              }
            : githubTrigger,
          gh: {
            owner,
            repo: name,
            issueNumber,
            ...(commentId ? { commentId } : {}),
            ...(payload.issue?.node_id ? { issueNodeId: payload.issue.node_id } : {}),
          },
          createdBy: { type: "github", login: sender },
        })
        .returning()
    )[0];
    if (!created) return undefined;
    if (accepted?.proposal) {
      const actor = { type: "github", id: sender };
      await tx.insert(proposalEvents).values([
        {
          orgId: accepted.proposal.orgId,
          proposalId: accepted.proposal.id,
          seq: 2,
          type: "approved",
          actor,
          data: { source: "github_command" },
        },
        {
          orgId: accepted.proposal.orgId,
          proposalId: accepted.proposal.id,
          seq: 3,
          type: "executed",
          actor,
          data: { source: "github_command", builderRunId: created.id },
        },
      ]);
    }
    return created;
  });
  if (!run) return { routed: false, reason: "insert_failed" };
  if (accepted?.proposal) {
    await insertAuditEvent(db, {
      orgId: accepted.proposal.orgId,
      projectId: accepted.proposal.projectId,
      actor: { type: "user", id: `github:${sender}`, name: sender },
      action: "hitl.decided",
      target: { type: "proposal", id: accepted.proposal.id },
      payload: { decision: "approve", source: "github_command", builder_run_id: run.id },
    });
  }
  await db.insert(runEvents).values({
    orgId: repo.orgId,
    runId: run.id,
    seq: 1,
    type: "queued",
    data: { queue: "runs.dispatch" },
  });
  // Actually dispatch to a sandbox — parity with manual run creation. The
  // slash-command path created the run but never enqueued it, so it never ran.
  // The GitHub comment is the end-user's live surface for this run. Comment
  // failures are recorded but never duplicate or suppress an already-created
  // run; the dispatcher/reconciler remains the source of execution truth.
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
    await db
      .update(runs)
      .set({
        gh: {
          ...objectOrEmpty(run.gh),
          progressComment: {
            id: progress.id,
            url: progress.url ?? null,
            command: `/${resolved.agentCommand ?? command}`,
            sender,
            issueTitle: payload.issue?.title ?? null,
          },
        },
        updatedAt: new Date(),
      })
      .where(and(eq(runs.orgId, repo.orgId), eq(runs.id, run.id)));
  } catch (error) {
    await db.insert(runEvents).values({
      orgId: repo.orgId,
      runId: run.id,
      seq: 2,
      type: "artifact_error",
      data: {
        kind: "github_progress_comment_failed",
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
  await enqueue?.("runs.dispatch", { runId: run.id, orgId: repo.orgId });
  return { routed: true, runId: run.id };
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
          gt(proposals.expiresAt, new Date()),
          sql`${runs.gh} ->> 'owner' = ${input.owner}`,
          sql`${runs.gh} ->> 'repo' = ${input.repo}`,
          sql`(${runs.gh} ->> 'issueNumber')::int = ${input.issueNumber}`,
        ),
      )
      .orderBy(desc(proposals.createdAt))
      .limit(1)
  )[0];
  if (!latest) return null;
  if (latest.proposal.state === "open") return { ...latest, blockedRunId: null };
  if (["approved", "executing", "executed"].includes(latest.proposal.state)) {
    const existing = (
      await db
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.orgId, input.orgId),
            sql`${runs.trigger} ->> 'proposalId' = ${latest.proposal.id}`,
          ),
        )
        .limit(1)
    )[0];
    return { ...latest, blockedRunId: existing?.id ?? latest.architectRun.id };
  }
  return null;
}

export function githubRequestContext(payload: TriggerPayload) {
  return {
    title: nullableText(payload.issue?.title),
    body: nullableText(payload.issue?.body),
    comment: nullableText(payload.comment?.body),
  };
}

function nullableText(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function laneFor(repo: typeof repos.$inferSelect, command: string): "repo" | "platform" {
  const answers = repo.renderAnswers as { execution_lane?: Record<string, string> } | null;
  const lane = answers?.execution_lane?.[command] ?? answers?.execution_lane?.[`/${command}`];
  return lane === "platform" ? "platform" : "repo";
}

export async function findAgentDef(
  db: FacilityDb,
  orgId: string,
  projectId: string,
  command: string,
) {
  const rows = await db
    .select()
    .from(agentDefs)
    .where(
      and(
        eq(agentDefs.orgId, orgId),
        eq(agentDefs.projectId, projectId),
        eq(agentDefs.enabled, true),
      ),
    );
  return rows.find((row) => {
    const triggers = row.triggers as unknown;
    if (!Array.isArray(triggers)) return row.name === command;
    return triggers.some((trigger) => {
      if (!trigger || typeof trigger !== "object") return false;
      const value =
        (trigger as { command?: unknown; handle?: unknown }).command ??
        (trigger as { handle?: unknown }).handle;
      return value === command || value === `/${command}`;
    });
  });
}
