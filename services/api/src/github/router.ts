import { newId } from "@facility/core";
import { agentDefs, type FacilityDb, repos, runEvents, runs } from "@facility/db";
import { and, eq } from "drizzle-orm";
import type { FacilityGithubClient } from "./client.js";

export type TriggerPayload = {
  action?: string;
  comment?: { id?: number; body?: string };
  issue?: { number?: number; pull_request?: unknown };
  repository?: { id?: number; name?: string; owner?: { login?: string }; default_branch?: string };
  sender?: { login?: string; type?: string };
};

const COMMAND_RE =
  /(?:^|\n)\s*\/(builder|architect|codex-builder|codex-architect)(?=$|[\s,.:;!?)])/g;

export function resolveSlashCommand(body: string): { command?: string; ambiguous: boolean } {
  const commands = [...body.matchAll(COMMAND_RE)].map((match) => match[1]).filter(Boolean);
  const unique = [...new Set(commands)];
  if (unique.length !== 1) return { ambiguous: unique.length > 1 };
  const raw = unique[0] ?? "";
  return { command: raw.replace(/^codex-/, ""), ambiguous: false };
}

export async function routeTrigger(
  db: FacilityDb,
  orgId: string,
  client: FacilityGithubClient,
  payload: TriggerPayload,
  enqueue?: (queue: string, data: Record<string, unknown>) => Promise<unknown>,
): Promise<{ routed: boolean; reason?: string; runId?: string }> {
  if (payload.sender?.type === "Bot") return { routed: false, reason: "bot_sender" };
  const body = payload.comment?.body ?? "";
  const resolved = resolveSlashCommand(body);
  if (resolved.ambiguous) return { routed: false, reason: "ambiguous_command" };
  if (!resolved.command) return { routed: false, reason: "no_command" };
  const owner = payload.repository?.owner?.login;
  const name = payload.repository?.name;
  const sender = payload.sender?.login;
  const issueNumber = payload.issue?.number;
  const commentId = payload.comment?.id;
  if (!owner || !name || !sender || !issueNumber || !commentId) {
    return { routed: false, reason: "missing_payload" };
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
  const lane = laneFor(repo, resolved.command);
  if (lane !== "platform") return { routed: false, reason: "repo_lane" };
  const agent = await findAgentDef(db, repo.orgId, repo.projectId, resolved.command);
  if (!agent) return { routed: false, reason: "no_agent" };
  const run = (
    await db
      .insert(runs)
      .values({
        id: newId("run"),
        orgId: repo.orgId,
        projectId: repo.projectId,
        agentDefId: agent.id,
        mode: resolved.command,
        engine: agent.engine,
        trigger: {
          type: "github_comment",
          repo: { id: repo.id, owner, name },
          issue: { number: issueNumber },
          comment: { id: commentId },
        },
        gh: { owner, repo: name, issueNumber, commentId },
        createdBy: { type: "github", login: sender },
      })
      .returning()
  )[0];
  if (!run) return { routed: false, reason: "insert_failed" };
  await db.insert(runEvents).values({
    orgId: repo.orgId,
    runId: run.id,
    seq: 1,
    type: "queued",
    data: { queue: "runs.dispatch" },
  });
  // Actually dispatch to a sandbox — parity with manual run creation. The
  // slash-command path created the run but never enqueued it, so it never ran.
  await enqueue?.("runs.dispatch", { runId: run.id, orgId: repo.orgId });
  await client.createIssueComment(
    issueNumber,
    `Queued Facility ${resolved.command} run ${run.id}.`,
  );
  return { routed: true, runId: run.id };
}

function laneFor(repo: typeof repos.$inferSelect, command: string): "repo" | "platform" {
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
