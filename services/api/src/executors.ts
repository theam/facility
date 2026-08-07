import { createHash } from "node:crypto";
import { can, newId } from "@facility/core";
import type { createDb } from "@facility/db";
import {
  actionTypes,
  agentDefs,
  apiKeys,
  budgets,
  conversationMessages,
  conversations,
  ghIssues,
  githubInstallations,
  insertAuditEvent,
  integrations,
  kbEntries,
  kbLinks,
  kbSpaces,
  orgMembers,
  platformIssues,
  poTasks,
  projects,
  proposalEvents,
  proposals,
  registryItems,
  registryVersions,
  repos,
  roles,
  runEvents,
  runs,
  sandboxProfiles,
  steerMessages,
  users,
  webhookDeliveries,
} from "@facility/db";
import { artifactIdFor, validate } from "@facility/harness";
import { and, desc, eq, gt, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { assertBudgetAgentInProject, resolveBudgetScope } from "./budget-scope.js";
import {
  createGithubClientFactory,
  FacilityGithubClient,
  type GithubClientFactory,
} from "./github/client.js";
import {
  createGithubClientForRepo,
  type KickstartAnswers,
  kickstartRepo,
  upgradeRepo,
} from "./github/kickstart.js";
import { findAgentDef, laneFor } from "./github/router.js";
import { renderGithubRunProgress } from "./github/run-progress.js";
import { ensureTrackedIssue } from "./github/tracked-issues.js";
import {
  ensureActive,
  ensureLinks,
  loadKbGraph,
  normalizeKbDraft,
  toHarnessEntry,
  toHarnessSpace,
} from "./harness.js";
import { MCP_TOOL_PERMISSIONS } from "./mcp-policy.js";
import { createNextDraftVersion, publishRegistryVersion } from "./registry.js";
import { cancelRun } from "./sandbox/orchestrator.js";
import { appendRunEvents, TERMINAL_RUN_STATUSES } from "./sandbox/state.js";
import { validateScheduleTrigger } from "./schedules.js";
import type { AppConfig } from "./types.js";

type Db = ReturnType<typeof createDb>["db"];
type ProposalExecutionContext = Pick<
  typeof proposals.$inferSelect,
  "id" | "orgId" | "projectId" | "payload"
>;

export type GitHubIssueClient = {
  createIssue(input: {
    repo: { owner: string; name: string };
    title: string;
    body: string;
    labels: string[];
  }): Promise<{ number: number; url: string }>;
  addToBoard?(input: { org: string; number: number; issueUrl: string }): Promise<void>;
  updateIssue?(input: { number: number; title: string; body: string }): Promise<void>;
};

type ExecuteApprovedProposalOptions = {
  config?: AppConfig;
  github?: GitHubIssueClient;
  githubFactory?: GithubClientFactory;
  enqueue?: (queue: string, data: Record<string, unknown>) => Promise<string | null>;
};

export async function executeApprovedProposal(
  db: Db,
  candidate: typeof proposals.$inferSelect,
  actor: { type: string; id: string },
  options: ExecuteApprovedProposalOptions | GitHubIssueClient = {},
) {
  const executionOptions = isGitHubIssueClient(options) ? { github: options } : options;
  if (candidate.state !== "approved" && candidate.state !== "execution_failed") return false;
  const actionType = (
    await db.select().from(actionTypes).where(eq(actionTypes.id, candidate.actionTypeId)).limit(1)
  )[0];
  if (!actionType) return false;
  // `executor.type = none` is a deliberate externally-consumed approval gate.
  // Approval is terminal for Facility itself, so leave the proposal approved.
  if (objectOrEmpty(actionType.executor).type === "none") return true;
  // Claim before performing any database or external side effect. The compare-and-set
  // makes concurrent /execute calls single-writer even when both loaded the same
  // approved proposal. Failed executions remain explicitly retryable.
  const proposal = (
    await db
      .update(proposals)
      .set({ state: "executing", updatedAt: new Date() })
      .where(
        and(
          eq(proposals.orgId, candidate.orgId),
          eq(proposals.id, candidate.id),
          inArray(proposals.state, ["approved", "execution_failed"]),
        ),
      )
      .returning()
  )[0];
  if (!proposal) return false;
  let actionTypeName = "unknown";
  try {
    actionTypeName = actionType.name;
    validatePayload(actionType.payloadSchema, proposal.payload);
    const recurrence = ["skill_proposal", "rule_proposal", "guard_candidate"].includes(
      actionType.name,
    )
      ? await captureRecurrenceBaseline(db, proposal)
      : undefined;
    if (actionType.name === "task_creation") {
      await executeTaskCreation(db, proposal, executionOptions);
    } else if (actionType.name === "skill_proposal" || actionType.name === "rule_proposal") {
      await executeRegistryDraft(
        db,
        proposal,
        actionType.name === "skill_proposal" ? "skill" : "rule",
      );
    } else if (actionType.name === "guard_candidate") {
      await executeGuardCandidate(db, proposal, executionOptions);
    } else if (actionType.name === "kb_amendment") {
      await executeKbAmendment(db, proposal);
    } else if (actionType.name === "plan_acceptance") {
      if (objectOrEmpty(actionType.executor).type !== "internal") {
        throw new Error("plan_acceptance_executor_invalid");
      }
      await executePlanAcceptance(db, proposal, actor, executionOptions);
    } else if (actionType.name === "issue_update") {
      await executeIssueUpdate(db, proposal, executionOptions);
    } else if (actionType.name === "mcp_tool_call") {
      await executeMcpToolCall(db, proposal, actor, executionOptions);
    } else {
      throw new Error(`unsupported_action_type:${actionType.name}`);
    }
    await db
      .update(proposals)
      .set({ state: "executed", updatedAt: new Date() })
      .where(and(eq(proposals.orgId, proposal.orgId), eq(proposals.id, proposal.id)));
    await appendProposalEvent(db, proposal, "executed", actor, {
      actionType: actionType.name,
      ...(recurrence ? { recurrence } : {}),
    });
    return true;
  } catch (error) {
    await db
      .update(proposals)
      .set({ state: "execution_failed", updatedAt: new Date() })
      .where(and(eq(proposals.orgId, proposal.orgId), eq(proposals.id, proposal.id)));
    await appendProposalEvent(db, proposal, "execution_failed", actor, {
      actionType: actionTypeName,
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

async function executePlanAcceptance(
  db: Db,
  proposal: typeof proposals.$inferSelect,
  actor: { type: string; id: string },
  options: ExecuteApprovedProposalOptions,
) {
  if (!proposal.projectId) throw new Error("plan_acceptance_missing_project");
  if (!proposal.runId) throw new Error("plan_acceptance_missing_architect_run");

  const architectRun = (
    await db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.orgId, proposal.orgId),
          eq(runs.projectId, proposal.projectId),
          eq(runs.id, proposal.runId),
        ),
      )
      .limit(1)
  )[0];
  if (!architectRun) throw new Error("plan_acceptance_architect_run_not_found");
  if (!["architect", "codex-architect"].includes(architectRun.mode)) {
    throw new Error("plan_acceptance_source_not_architect");
  }
  if (!["succeeded", "awaiting_human"].includes(architectRun.status)) {
    throw new Error("plan_acceptance_architect_run_not_ready");
  }

  await assertPlatformBuilderLane(db, proposal, architectRun);

  // The proposal link, not the currently configured builder definition, is
  // the durable dispatch identity. Reuse the original run even if an admin
  // replaces or disables the builder before an execution retry.
  const existingRun = await loadPlanBuilderRun(db, proposal);
  if (existingRun) {
    await options.enqueue?.("runs.dispatch", {
      runId: existingRun.id,
      orgId: proposal.orgId,
    });
    return;
  }

  const builderCommand = architectRun.engine === "codex" ? "codex-builder" : "builder";
  const builder = await findAgentDef(db, proposal.orgId, proposal.projectId, builderCommand);
  if (!builder) throw new Error("plan_acceptance_builder_not_configured");
  const builderGh = { ...objectOrEmpty(architectRun.gh) };
  delete builderGh.progressComment;
  const architectTrigger = objectOrEmpty(architectRun.trigger);
  const architectCreator = objectOrEmpty(architectRun.createdBy);
  const githubLogin =
    stringField(architectTrigger.githubLogin) ??
    (architectCreator.type === "github"
      ? (stringField(architectCreator.id) ?? stringField(architectCreator.login))
      : null);

  const createdRun = (
    await db
      .insert(runs)
      .values({
        id: newId("run"),
        orgId: proposal.orgId,
        projectId: proposal.projectId,
        agentDefId: builder.id,
        mode: "builder",
        engine: builder.engine,
        trigger: {
          source: "plan_acceptance",
          ...(githubLogin ? { githubLogin } : {}),
          proposalId: proposal.id,
          architectRunId: architectRun.id,
          architectTrigger: architectRun.trigger,
          approvedPlan: proposal.contextMd,
        },
        gh: builderGh,
        createdBy: { type: actor.type, id: actor.id, proposalId: proposal.id },
      })
      .onConflictDoNothing()
      .returning()
  )[0];
  const run = createdRun ?? (await loadPlanBuilderRun(db, proposal));
  if (!run) throw new Error("plan_acceptance_builder_run_not_created");

  if (createdRun) {
    await db.insert(runEvents).values({
      orgId: proposal.orgId,
      runId: run.id,
      seq: 1,
      type: "queued",
      data: {
        queue: "runs.dispatch",
        source: "plan_acceptance",
        proposalId: proposal.id,
        architectRunId: architectRun.id,
      },
    });
    await createBuilderProgressComment(db, createdRun, architectRun, builderCommand, options);
  }
  await options.enqueue?.("runs.dispatch", { runId: run.id, orgId: proposal.orgId });
}

async function createBuilderProgressComment(
  db: Db,
  run: typeof runs.$inferSelect,
  architectRun: typeof runs.$inferSelect,
  command: string,
  options: ExecuteApprovedProposalOptions,
) {
  const gh = objectOrEmpty(run.gh);
  const owner = stringField(gh.owner);
  const name = stringField(gh.repo);
  const issueNumber =
    typeof gh.issueNumber === "number" && Number.isInteger(gh.issueNumber) ? gh.issueNumber : null;
  if (!owner || !name || !issueNumber) return;
  const repo = (
    await db
      .select()
      .from(repos)
      .where(
        and(
          eq(repos.orgId, run.orgId),
          eq(repos.projectId, run.projectId),
          eq(repos.owner, owner),
          eq(repos.name, name),
        ),
      )
      .limit(1)
  )[0];
  if (!repo?.installationId) return;
  const installation = (
    await db
      .select()
      .from(githubInstallations)
      .where(
        and(
          eq(githubInstallations.orgId, run.orgId),
          eq(githubInstallations.id, repo.installationId),
        ),
      )
      .limit(1)
  )[0];
  if (!installation || installation.suspendedAt) return;
  const factory =
    options.githubFactory ??
    (options.config?.githubAppId && options.config.githubAppPrivateKey
      ? createGithubClientFactory(options.config)
      : null);
  if (!factory) return;
  const architectTrigger = objectOrEmpty(architectRun.trigger);
  const request = objectOrEmpty(architectTrigger.request);
  const architectProgress = objectOrEmpty(objectOrEmpty(architectRun.gh).progressComment);
  try {
    const client = new FacilityGithubClient(await factory(installation.installationId), {
      owner,
      repo: name,
      defaultBranch: repo.defaultBranch,
    });
    const progress = await client.createIssueComment(
      issueNumber,
      renderGithubRunProgress({
        runId: run.id,
        mode: "builder",
        command: `/${command}`,
        phase: "queued",
        issueNumber,
        issueTitle: stringField(request.title) ?? stringField(architectProgress.issueTitle),
        sender: stringField(architectProgress.sender),
      }),
    );
    await db
      .update(runs)
      .set({
        gh: {
          ...gh,
          progressComment: {
            id: progress.id,
            url: progress.url ?? null,
            command: `/${command}`,
            sender: stringField(architectProgress.sender) ?? null,
            issueTitle:
              stringField(request.title) ?? stringField(architectProgress.issueTitle) ?? null,
          },
        },
        updatedAt: new Date(),
      })
      .where(and(eq(runs.orgId, run.orgId), eq(runs.id, run.id)));
  } catch (error) {
    await appendRunEvents(db, run.orgId, run.id, [
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

async function loadPlanBuilderRun(db: Db, proposal: typeof proposals.$inferSelect) {
  return (
    await db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.orgId, proposal.orgId),
          eq(runs.projectId, proposal.projectId ?? ""),
          eq(runs.mode, "builder"),
          sql`${runs.trigger} @> ${JSON.stringify({
            source: "plan_acceptance",
            architectRunId: proposal.runId,
          })}::jsonb`,
        ),
      )
      .limit(1)
  )[0];
}

async function assertPlatformBuilderLane(
  db: Db,
  proposal: typeof proposals.$inferSelect,
  architectRun: typeof runs.$inferSelect,
) {
  const projectRepos = await db
    .select()
    .from(repos)
    .where(and(eq(repos.orgId, proposal.orgId), eq(repos.projectId, proposal.projectId ?? "")));
  const gh = objectOrEmpty(architectRun.gh);
  const triggerRepo = objectOrEmpty(objectOrEmpty(architectRun.trigger).repo);
  const repoId = stringField(triggerRepo.id);
  const owner = stringField(gh.owner) ?? stringField(triggerRepo.owner);
  const name = stringField(gh.repo) ?? stringField(triggerRepo.name);
  const hasRepoIdentity = Boolean(repoId || (owner && name));
  const matchedRepo = projectRepos.find(
    (candidate) =>
      (repoId && candidate.id === repoId) ||
      (owner && name && candidate.owner === owner && candidate.name === name),
  );
  const repo =
    matchedRepo ?? (!hasRepoIdentity && projectRepos.length === 1 ? projectRepos[0] : undefined);
  if (!repo) throw new Error("plan_acceptance_repo_context_ambiguous");
  if (laneFor(repo, "builder") !== "platform") {
    throw new Error("plan_acceptance_builder_uses_repo_lane");
  }
}

async function executeMcpToolCall(
  db: Db,
  proposal: typeof proposals.$inferSelect,
  actor: { type: string; id: string },
  options: ExecuteApprovedProposalOptions,
) {
  const payload = objectOrEmpty(proposal.payload);
  const toolName = stringField(payload.toolName);
  const args = objectOrEmpty(payload.args);
  if (!toolName) throw new Error("mcp_tool_missing_name");
  const targetProjectId = await resolveMcpToolTargetProject(db, proposal.orgId, toolName, args);
  const proposalProjectId = proposal.projectId ?? null;
  const proposedTargetProjectId =
    stringField(objectOrEmpty(payload.target).projectId) ?? stringField(payload.targetProjectId);
  if (targetProjectId !== proposalProjectId) {
    throw new Error("mcp_target_project_mismatch");
  }
  if (proposedTargetProjectId !== undefined && proposedTargetProjectId !== proposalProjectId) {
    throw new Error("mcp_target_project_changed");
  }
  await assertMcpRequesterStillAuthorized(db, proposal.orgId, payload, toolName, targetProjectId);
  const result = await executeKnownMcpTool(
    db,
    proposal.orgId,
    actor,
    toolName,
    args,
    options,
    proposalProjectId,
    proposal.id,
  );
  await insertAuditEvent(db, {
    orgId: proposal.orgId,
    projectId: targetProjectId ?? proposalProjectId,
    actor: { type: auditActorType(actor.type), id: actor.id },
    action: "mcp.tool.executed",
    target: { type: "proposal", id: proposal.id },
    payload: { toolName, result },
  });
}

async function assertMcpRequesterStillAuthorized(
  db: Db,
  orgId: string,
  payload: Record<string, unknown>,
  toolName: string,
  targetProjectId: string | null,
) {
  const expectedPermission = MCP_TOOL_PERMISSIONS[toolName];
  const storedPermission = stringField(payload.permission);
  if (!expectedPermission || storedPermission !== expectedPermission) {
    throw new Error("mcp_permission_policy_changed");
  }
  const requestedBy = objectOrEmpty(payload.requestedBy);
  const requesterType = stringField(requestedBy.type);
  const requesterId = stringField(requestedBy.id);
  if (!requesterType || !requesterId) throw new Error("mcp_requester_missing");

  if (requesterType === "key") {
    const key = (
      await db
        .select({ permissions: roles.permissions, projectId: apiKeys.projectId })
        .from(apiKeys)
        .innerJoin(roles, eq(apiKeys.roleId, roles.id))
        .where(
          and(
            eq(apiKeys.orgId, orgId),
            eq(apiKeys.id, requesterId),
            isNull(apiKeys.revokedAt),
            or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
          ),
        )
        .limit(1)
    )[0];
    assertCurrentMcpAuthority(
      key?.permissions,
      key?.projectId ?? null,
      expectedPermission,
      targetProjectId,
    );
    return;
  }

  if (requesterType === "user") {
    const member = (
      await db
        .select({ permissions: roles.permissions, status: users.status })
        .from(orgMembers)
        .innerJoin(roles, eq(orgMembers.roleId, roles.id))
        .innerJoin(users, eq(orgMembers.userId, users.id))
        .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, requesterId)))
        .limit(1)
    )[0];
    if (member?.status !== "active") throw new Error("mcp_requester_no_longer_authorized");
    assertCurrentMcpAuthority(member.permissions, null, expectedPermission, targetProjectId);
    return;
  }

  throw new Error("mcp_requester_no_longer_authorized");
}

function assertCurrentMcpAuthority(
  permissions: string[] | undefined,
  scopedProjectId: string | null,
  expectedPermission: string,
  targetProjectId: string | null,
) {
  if (
    !permissions ||
    !can(permissions, expectedPermission) ||
    can(permissions, "hitl:decide") ||
    (scopedProjectId !== null && scopedProjectId !== targetProjectId)
  ) {
    throw new Error("mcp_requester_no_longer_authorized");
  }
}

async function executeKnownMcpTool(
  db: Db,
  orgId: string,
  actor: { type: string; id: string },
  toolName: string,
  args: Record<string, unknown>,
  options: ExecuteApprovedProposalOptions,
  proposalProjectId: string | null,
  proposalId: string,
) {
  if (toolName === "facility_create_project") {
    const project = (
      await db
        .insert(projects)
        .values({
          id: newId("proj"),
          orgId,
          name: requiredString(args.name, "name"),
          slug: requiredString(args.slug, "slug"),
          description: optionalString(args.description),
          settings: { default_branch: "main", check_cmds: [] },
        })
        .returning()
    )[0];
    return { projectId: project?.id };
  }

  if (toolName === "facility_archive_project") {
    const projectId = requiredString(args.projectId, "projectId");
    const project = (
      await db
        .update(projects)
        .set({ status: "archived", updatedAt: new Date() })
        .where(and(eq(projects.orgId, orgId), eq(projects.id, projectId)))
        .returning({ id: projects.id, status: projects.status })
    )[0];
    if (!project) throw new Error("project_not_found");
    return { projectId: project.id, status: project.status };
  }

  if (toolName === "facility_trigger_run") {
    const projectId = requiredString(args.projectId, "projectId");
    const agentName = requiredString(args.agentName, "agentName");
    const agent = await resolveAgentForMcpRun(db, orgId, projectId, agentName);
    const run = (
      await db
        .insert(runs)
        .values({
          id: newId("run"),
          orgId,
          projectId,
          agentDefId: agent.id,
          mode: agent.name,
          engine: agent.engine,
          trigger: { source: "mcp", agentName, input: args.input },
          createdBy: actor,
        })
        .returning()
    )[0];
    if (run) {
      await db.insert(runEvents).values({
        orgId,
        runId: run.id,
        seq: 1,
        type: "queued",
        data: { queue: "runs.dispatch" },
      });
      await options.enqueue?.("runs.dispatch", { runId: run.id, orgId });
    }
    return { runId: run?.id };
  }

  if (toolName === "facility_cancel_run") {
    const runId = requiredString(args.runId, "runId");
    // Guard the transition so a terminal run isn't reopened to "canceled".
    const row = (
      await db
        .update(runs)
        .set({ status: "canceled", endedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(runs.orgId, orgId),
            eq(runs.id, runId),
            notInArray(runs.status, [...TERMINAL_RUN_STATUSES]),
          ),
        )
        .returning()
    )[0];
    if (!row) {
      const current = (
        await db
          .select()
          .from(runs)
          .where(and(eq(runs.orgId, orgId), eq(runs.id, runId)))
          .limit(1)
      )[0];
      if (!current) throw new Error("run_not_found");
      return { runId }; // already terminal — idempotent
    }
    if (options.config) await cancelRun(options.config, row);
    return { runId };
  }

  if (toolName === "facility_steer_run") {
    const runId = requiredString(args.runId, "runId");
    const body = requiredString(args.body, "body");
    const run = (
      await db
        .select()
        .from(runs)
        .where(and(eq(runs.orgId, orgId), eq(runs.id, runId)))
        .limit(1)
    )[0];
    if (!run) throw new Error("run_not_found");
    if (["succeeded", "failed", "canceled"].includes(run.status)) throw new Error("run_terminal");
    const message = (
      await db
        .insert(steerMessages)
        .values({ id: newId("evt"), orgId, runId, body })
        .returning()
    )[0];
    // Share the per-run advisory-locked seq allocation (+ NOTIFY) with the
    // runner's event ingest — no duplicate-key race with a concurrent batch.
    await appendRunEvents(db, orgId, runId, [
      { type: "steer", data: { text: body, author: actor.id } },
    ]);
    return { messageId: message?.id };
  }

  if (toolName === "facility_interrupt_run") {
    const runId = requiredString(args.runId, "runId");
    const run = (
      await db
        .select({ status: runs.status })
        .from(runs)
        .where(and(eq(runs.orgId, orgId), eq(runs.id, runId)))
        .limit(1)
    )[0];
    if (!run) throw new Error("run_not_found");
    if (TERMINAL_RUN_STATUSES.includes(run.status as (typeof TERMINAL_RUN_STATUSES)[number])) {
      throw new Error("run_terminal");
    }
    const existing = (
      await db
        .select({ id: steerMessages.id })
        .from(steerMessages)
        .where(
          and(
            eq(steerMessages.orgId, orgId),
            eq(steerMessages.runId, runId),
            eq(steerMessages.kind, "interrupt"),
          ),
        )
        .limit(1)
    )[0];
    if (existing) return { runId, messageId: existing.id };
    const message = (
      await db
        .insert(steerMessages)
        .values({
          id: newId("evt"),
          orgId,
          runId,
          kind: "interrupt",
          body: "human_interrupt",
        })
        .returning({ id: steerMessages.id })
    )[0];
    await appendRunEvents(db, orgId, runId, [
      { type: "steer", data: { kind: "interrupt", author: actor.id } },
    ]);
    return { runId, messageId: message?.id };
  }

  if (toolName === "facility_resume_run") {
    const runId = requiredString(args.runId, "runId");
    const parent = (
      await db
        .select()
        .from(runs)
        .where(and(eq(runs.orgId, orgId), eq(runs.id, runId)))
        .limit(1)
    )[0];
    if (!parent) throw new Error("run_not_found");
    if (!TERMINAL_RUN_STATUSES.includes(parent.status as (typeof TERMINAL_RUN_STATUSES)[number])) {
      throw new Error("run_not_terminal");
    }
    if (parent.engine !== "claude_code" || !parent.engineSessionId) {
      throw new Error("run_not_resumable");
    }
    const message = optionalString(args.message);
    const resumed = (
      await db
        .insert(runs)
        .values({
          id: newId("run"),
          orgId,
          projectId: parent.projectId,
          agentDefId: parent.agentDefId,
          mode: parent.mode,
          engine: parent.engine,
          trigger: {
            type: "resume",
            resumeOf: parent.id,
            ...(message ? { message } : {}),
          },
          gh: resumableGithubContext(parent.gh),
          createdBy: actor,
        })
        .returning({ id: runs.id })
    )[0];
    if (!resumed) throw new Error("run_resume_failed");
    await db.insert(runEvents).values({
      orgId,
      runId: resumed.id,
      seq: 1,
      type: "queued",
      data: { queue: "runs.dispatch" },
    });
    await options.enqueue?.("runs.dispatch", { runId: resumed.id, orgId });
    return { runId: resumed.id, resumeOf: parent.id };
  }

  if (toolName === "facility_start_conversation") {
    const projectId = requiredString(args.projectId, "projectId");
    const agentDefId = optionalString(args.agentDefId);
    const agent = (
      await db
        .select()
        .from(agentDefs)
        .where(
          and(
            eq(agentDefs.orgId, orgId),
            eq(agentDefs.projectId, projectId),
            eq(agentDefs.enabled, true),
            agentDefId ? eq(agentDefs.id, agentDefId) : eq(agentDefs.name, "project-owner"),
          ),
        )
        .limit(1)
    )[0];
    if (!agent) throw new Error("conversation_agent_not_found");
    if (agent.engine !== "claude_code") throw new Error("conversation_engine_unsupported");
    const conversation = (
      await db
        .insert(conversations)
        .values({
          id: newId("evt"),
          orgId,
          projectId,
          agentDefId: agent.id,
          title: optionalString(args.title),
          createdBy: actor,
        })
        .returning({ id: conversations.id })
    )[0];
    if (!conversation) throw new Error("conversation_create_failed");
    return { conversationId: conversation.id };
  }

  if (toolName === "facility_send_conversation_message") {
    const conversationId = requiredString(args.conversationId, "conversationId");
    const body = requiredString(args.body, "body");
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${conversationId}))`);
      const conversation = (
        await tx
          .update(conversations)
          .set({ status: "running", updatedAt: new Date() })
          .where(
            and(
              eq(conversations.orgId, orgId),
              eq(conversations.id, conversationId),
              eq(conversations.status, "idle"),
            ),
          )
          .returning()
      )[0];
      if (!conversation) throw new Error("conversation_turn_in_flight");
      const rows = await tx
        .select({ max: sql<number>`coalesce(max(${conversationMessages.seq}), 0)` })
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, conversationId));
      const message = (
        await tx
          .insert(conversationMessages)
          .values({
            id: newId("evt"),
            orgId,
            conversationId,
            seq: Number(rows[0]?.max ?? 0) + 1,
            role: "user",
            body,
          })
          .returning({ id: conversationMessages.id })
      )[0];
      const run = (
        await tx
          .insert(runs)
          .values({
            id: newId("run"),
            orgId,
            projectId: conversation.projectId,
            agentDefId: conversation.agentDefId,
            mode: "conversation",
            engine: "claude_code",
            trigger: {
              type: "conversation",
              conversationId,
              message: body,
              ...(conversation.engineSessionId && conversation.lastRunId
                ? { resumeOf: conversation.lastRunId }
                : {}),
            },
            createdBy: actor,
          })
          .returning({ id: runs.id })
      )[0];
      if (!message || !run) throw new Error("conversation_turn_create_failed");
      await tx
        .update(conversations)
        .set({ lastRunId: run.id, updatedAt: new Date() })
        .where(and(eq(conversations.orgId, orgId), eq(conversations.id, conversationId)));
      await tx.insert(runEvents).values({
        orgId,
        runId: run.id,
        seq: 1,
        type: "queued",
        data: { queue: "runs.dispatch" },
      });
      return { messageId: message.id, runId: run.id };
    });
    await options.enqueue?.("runs.dispatch", { runId: result.runId, orgId });
    return { conversationId, ...result };
  }

  if (toolName === "facility_sync_github_issues") {
    const projectId = requiredString(args.projectId, "projectId");
    const projectRepos = await db
      .select({ id: repos.id })
      .from(repos)
      .where(and(eq(repos.orgId, orgId), eq(repos.projectId, projectId)));
    for (const repo of projectRepos) {
      await options.enqueue?.("github.issues-sync", { repoId: repo.id, orgId });
    }
    return { queued: projectRepos.length };
  }

  if (toolName === "facility_trigger_github_issue") {
    const projectId = requiredString(args.projectId, "projectId");
    const number = requiredNumber(args.number, "number");
    const repoId = optionalString(args.repoId);
    const agentName = requiredString(args.agentName, "agentName");
    const issues = await db
      .select()
      .from(ghIssues)
      .where(
        and(
          eq(ghIssues.orgId, orgId),
          eq(ghIssues.projectId, projectId),
          eq(ghIssues.number, number),
          ...(repoId ? [eq(ghIssues.repoId, repoId)] : []),
        ),
      )
      .limit(2);
    if (issues.length === 0) throw new Error("github_issue_not_found");
    if (issues.length > 1) throw new Error("github_issue_ambiguous:repoId_required");
    const issue = issues[0] as (typeof issues)[number];
    const repo = (
      await db
        .select()
        .from(repos)
        .where(
          and(eq(repos.orgId, orgId), eq(repos.projectId, projectId), eq(repos.id, issue.repoId)),
        )
        .limit(1)
    )[0];
    if (!repo) throw new Error("repo_not_found");
    const agent = await resolveAgentForMcpRun(db, orgId, projectId, agentName);
    const run = (
      await db
        .insert(runs)
        .values({
          id: newId("run"),
          orgId,
          projectId,
          agentDefId: agent.id,
          mode: agentName,
          engine: agent.engine,
          trigger: {
            type: "mcp_issue",
            repo: { id: repo.id, owner: repo.owner, name: repo.name },
            issue: { number },
          },
          gh: { owner: repo.owner, repo: repo.name, issueNumber: number },
          createdBy: actor,
        })
        .returning({ id: runs.id })
    )[0];
    if (!run) throw new Error("run_create_failed");
    await db.insert(runEvents).values({
      orgId,
      runId: run.id,
      seq: 1,
      type: "queued",
      data: { queue: "runs.dispatch" },
    });
    await options.enqueue?.("runs.dispatch", { runId: run.id, orgId });
    const factory =
      options.githubFactory ??
      (options.config?.githubAppId && options.config.githubAppPrivateKey
        ? createGithubClientFactory(options.config)
        : undefined);
    if (factory) {
      try {
        const github = await createGithubClientForRepo(db, factory, repo);
        await github.createIssueComment(
          number,
          `Facility queued ${agentName} run ${run.id} (triggered through an approved MCP proposal).`,
        );
      } catch {
        // Queueing is authoritative; the acknowledgement is best-effort parity
        // with the direct API trigger and must not roll back an approved run.
      }
    }
    return { runId: run.id, issueNumber: number };
  }

  if (toolName === "facility_set_budget") {
    const budgetId = optionalString(args.budgetId);
    // Same centralized scope coherence + authorization as the HTTP routes, keyed on
    // the PROPOSAL's project scope: a project-scoped proposal cannot create/modify an
    // org-wide budget, org budgets null their project/agent, and agent budgets require
    // an agent def. This closes the HITL/MCP path that previously persisted a
    // project-targeted `scope:"org"` row the gateway then enforced org-wide.
    const resolved = resolveBudgetScope({
      scope: requiredString(args.scope, "scope"),
      projectId: optionalString(args.projectId),
      agentDefId: optionalString(args.agentDefId),
      principalProjectId: proposalProjectId,
    });
    await assertMcpProjectInOrg(db, orgId, resolved.projectId);
    if (resolved.scope === "agent_def" && resolved.projectId && resolved.agentDefId) {
      await assertBudgetAgentInProject(db, orgId, resolved.projectId, resolved.agentDefId);
    }
    const values = {
      scope: resolved.scope,
      projectId: resolved.projectId,
      agentDefId: resolved.agentDefId,
      period: requiredString(args.period, "period"),
      limitCents: requiredNumber(args.limitCents, "limitCents"),
      mode: requiredString(args.mode, "mode"),
      enabled: typeof args.enabled === "boolean" ? args.enabled : true,
      updatedAt: new Date(),
    };
    const row = budgetId
      ? (
          await db
            .update(budgets)
            .set(values)
            .where(and(eq(budgets.orgId, orgId), eq(budgets.id, budgetId)))
            .returning()
        )[0]
      : (
          await db
            .insert(budgets)
            .values({ id: newId("bud"), orgId, ...values })
            .returning()
        )[0];
    if (!row) throw new Error("budget_not_found");
    return { budgetId: row.id };
  }

  if (toolName === "facility_publish_registry_version") {
    const versionId = requiredString(args.versionId, "versionId");
    // Same atomic publish-supersede as the HTTP route: deprecate the item's prior
    // active version(s), activate this draft, bump latestVersion — so publishing
    // through HITL keeps the one-active-version-per-item invariant too.
    const version = await publishRegistryVersion(db, orgId, versionId);
    return { versionId: version.id };
  }

  if (toolName === "facility_deprecate_registry_version") {
    const versionId = requiredString(args.versionId, "versionId");
    const version = (
      await db
        .update(registryVersions)
        .set({ status: "deprecated", updatedAt: new Date() })
        .where(and(eq(registryVersions.orgId, orgId), eq(registryVersions.id, versionId)))
        .returning({ id: registryVersions.id, status: registryVersions.status })
    )[0];
    if (!version) throw new Error("registry_version_not_found");
    return { versionId: version.id, status: version.status };
  }

  if (toolName === "facility_create_agent") {
    const projectId = requiredString(args.projectId, "projectId");
    await assertMcpProjectInOrg(db, orgId, projectId);
    const contractItemId = await resolveMcpAgentContract(db, orgId, projectId, args, actor.id);
    await assertMcpRegistryReference(db, orgId, projectId, optionalString(args.harnessItemId));
    await assertMcpSandboxReference(db, orgId, projectId, optionalString(args.sandboxProfileId));
    const agent = (
      await db
        .insert(agentDefs)
        .values({
          id: newId("agent"),
          orgId,
          projectId,
          name: requiredString(args.name, "name"),
          engine: requiredString(args.engine, "engine"),
          model: args.model ?? {},
          contractItemId,
          harnessItemId: optionalString(args.harnessItemId),
          triggers: Array.isArray(args.triggers) ? args.triggers : [],
          sandboxProfileId: optionalString(args.sandboxProfileId),
          enabled: true,
        })
        .returning()
    )[0];
    return { agentId: agent?.id, contractItemId };
  }

  if (toolName === "facility_update_agent") {
    const projectId = requiredString(args.projectId, "projectId");
    const agentId = requiredString(args.agentId, "agentId");
    const current = (
      await db
        .select()
        .from(agentDefs)
        .where(
          and(
            eq(agentDefs.orgId, orgId),
            eq(agentDefs.projectId, projectId),
            eq(agentDefs.id, agentId),
          ),
        )
        .limit(1)
    )[0];
    if (!current) throw new Error("agent_not_found");
    const contractItemId = optionalString(args.contractItemId);
    const harnessItemId = optionalString(args.harnessItemId);
    const sandboxProfileId = optionalString(args.sandboxProfileId);
    await assertMcpRegistryReference(db, orgId, projectId, contractItemId);
    await assertMcpRegistryReference(db, orgId, projectId, harnessItemId);
    await assertMcpSandboxReference(db, orgId, projectId, sandboxProfileId);
    if (args.triggers !== undefined) {
      if (!Array.isArray(args.triggers)) throw new Error("mcp_tool_invalid_triggers");
      for (const trigger of args.triggers) validateScheduleTrigger(trigger);
    }
    const values = {
      ...(optionalString(args.name) ? { name: optionalString(args.name) } : {}),
      ...(optionalString(args.engine) ? { engine: optionalString(args.engine) } : {}),
      ...(args.model !== undefined ? { model: objectOrEmpty(args.model) } : {}),
      ...(contractItemId ? { contractItemId } : {}),
      ...(harnessItemId ? { harnessItemId } : {}),
      ...(Array.isArray(args.triggers) ? { triggers: args.triggers } : {}),
      ...(sandboxProfileId ? { sandboxProfileId } : {}),
      ...(typeof args.enabled === "boolean" ? { enabled: args.enabled } : {}),
      updatedAt: new Date(),
    };
    if (Object.keys(values).length === 1) throw new Error("mcp_tool_no_changes");
    const updated = (
      await db
        .update(agentDefs)
        .set(values)
        .where(
          and(
            eq(agentDefs.orgId, orgId),
            eq(agentDefs.projectId, projectId),
            eq(agentDefs.id, agentId),
          ),
        )
        .returning({ id: agentDefs.id })
    )[0];
    if (!updated) throw new Error("agent_not_found");
    return { agentId: updated.id };
  }

  if (toolName === "facility_retire_agent") {
    const projectId = requiredString(args.projectId, "projectId");
    const agentId = requiredString(args.agentId, "agentId");
    const retired = (
      await db
        .delete(agentDefs)
        .where(
          and(
            eq(agentDefs.orgId, orgId),
            eq(agentDefs.projectId, projectId),
            eq(agentDefs.id, agentId),
          ),
        )
        .returning({ id: agentDefs.id })
    )[0];
    if (!retired) throw new Error("agent_not_found");
    return { agentId: retired.id, retired: true };
  }

  if (toolName === "facility_ack_issue" || toolName === "facility_resolve_issue") {
    const issueId = requiredString(args.issueId, "issueId");
    const issue = (
      await db
        .select()
        .from(platformIssues)
        .where(and(eq(platformIssues.orgId, orgId), eq(platformIssues.id, issueId)))
        .limit(1)
    )[0];
    if (!issue) throw new Error("issue_not_found");
    const targetState = toolName === "facility_ack_issue" ? "acked" : "resolved";
    const allowedStates = toolName === "facility_ack_issue" ? ["open"] : ["open", "acked"];
    if (issue.state === targetState) return { issueId, state: targetState };
    if (!allowedStates.includes(issue.state)) throw new Error("issue_invalid_transition");
    const updated = (
      await db
        .update(platformIssues)
        .set({ state: targetState, updatedAt: new Date() })
        .where(
          and(
            eq(platformIssues.orgId, orgId),
            eq(platformIssues.id, issueId),
            inArray(platformIssues.state, allowedStates),
          ),
        )
        .returning()
    )[0];
    if (!updated) throw new Error("issue_changed_concurrently");
    return { issueId, state: updated.state };
  }

  if (toolName === "facility_retry_webhook_delivery") {
    const deliveryId = requiredString(args.deliveryId, "deliveryId");
    const row = (
      await db
        .select({ delivery: webhookDeliveries })
        .from(webhookDeliveries)
        .innerJoin(integrations, eq(integrations.id, webhookDeliveries.integrationId))
        .where(and(eq(webhookDeliveries.orgId, orgId), eq(webhookDeliveries.id, deliveryId)))
        .limit(1)
    )[0];
    if (!row) throw new Error("webhook_delivery_not_found");
    if (row.delivery.status === "pending") return { deliveryId, status: "pending" };
    if (!["failed", "dead"].includes(row.delivery.status)) {
      throw new Error("webhook_delivery_not_retryable");
    }
    const delivery = (
      await db
        .update(webhookDeliveries)
        .set({
          status: "pending",
          attempts: 0,
          nextAttemptAt: new Date(),
          responseStatus: null,
          error: null,
          deliveredAt: null,
          updatedAt: new Date(),
        })
        .where(and(eq(webhookDeliveries.orgId, orgId), eq(webhookDeliveries.id, deliveryId)))
        .returning({ id: webhookDeliveries.id, status: webhookDeliveries.status })
    )[0];
    if (!delivery) throw new Error("webhook_delivery_not_found");
    return { deliveryId: delivery.id, status: delivery.status };
  }

  if (toolName === "facility_create_task") {
    const projectId = requiredString(args.projectId, "projectId");
    const kbEntryId = optionalString(args.kbEntryId);
    if (kbEntryId) await assertMcpKbEntryInProject(db, orgId, projectId, kbEntryId);
    const task = (
      await db
        .insert(poTasks)
        .values({
          id: newId("task"),
          orgId,
          projectId,
          kbEntryId,
          title: requiredString(args.title, "title"),
          bodyMd: requiredString(args.bodyMd, "bodyMd"),
          status: optionalString(args.status) ?? "draft",
          wsjf: objectOrEmpty(args.wsjf),
        })
        .returning()
    )[0];
    if (!task) throw new Error("task_create_failed");
    return { taskId: task.id };
  }

  if (toolName === "facility_transition_task") {
    const taskId = requiredString(args.taskId, "taskId");
    const task = (
      await db
        .update(poTasks)
        .set({ status: requiredString(args.status, "status"), updatedAt: new Date() })
        .where(and(eq(poTasks.orgId, orgId), eq(poTasks.id, taskId)))
        .returning()
    )[0];
    if (!task) throw new Error("task_not_found");
    return { taskId, status: task.status };
  }

  if (toolName === "facility_propose_task") {
    const taskId = requiredString(args.taskId, "taskId");
    return createTaskCreationProposal(db, orgId, taskId, actor);
  }

  if (toolName === "facility_amend_kb") {
    if (!proposalProjectId) throw new Error("kb_amendment_missing_project");
    const entryId = await executeKbAmendment(db, {
      id: proposalId,
      orgId,
      projectId: proposalProjectId,
      payload: args,
    });
    return { entryId };
  }

  if (toolName === "facility_create_registry_draft") {
    const item = await executeRegistryDraft(
      db,
      { id: proposalId, orgId, projectId: proposalProjectId, payload: args },
      requiredString(args.kind, "kind"),
      actor.id,
    );
    return item;
  }

  if (toolName === "facility_connect_repo") {
    if (!proposalProjectId) throw new Error("repo_project_required");
    return connectMcpRepo(db, orgId, proposalProjectId, args, options);
  }

  if (toolName === "facility_kickstart") {
    const config = requireConfig(options);
    const projectId = requiredString(args.projectId, "projectId");
    const repo = await loadMcpRepo(db, orgId, projectId, requiredString(args.repoId, "repoId"));
    return kickstartRepo({
      db,
      factory: createGithubClientFactory(config),
      config,
      principal: { type: "user", id: actor.id, orgId, permissions: ["hitl:decide"] },
      projectId,
      repo,
      answers: objectOrEmpty(args.answers) as KickstartAnswers,
    });
  }

  if (toolName === "facility_upgrade_project") {
    const config = requireConfig(options);
    const projectId = requiredString(args.projectId, "projectId");
    const repoId = requiredString(args.repoId, "repoId");
    const repo = await loadMcpRepo(db, orgId, projectId, repoId);
    return upgradeRepo({
      db,
      factory: createGithubClientFactory(config),
      repo,
      toVersion: optionalString(args.toVersion),
    });
  }

  throw new Error(`mcp_tool_not_allowed:${toolName}`);
}

export async function resolveMcpToolTargetProject(
  db: Db,
  orgId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  if (toolName === "facility_create_project") return null;
  if (
    toolName === "facility_archive_project" ||
    toolName === "facility_trigger_run" ||
    toolName === "facility_start_conversation" ||
    toolName === "facility_sync_github_issues" ||
    toolName === "facility_trigger_github_issue" ||
    toolName === "facility_create_agent" ||
    toolName === "facility_update_agent" ||
    toolName === "facility_retire_agent" ||
    toolName === "facility_kickstart" ||
    toolName === "facility_upgrade_project" ||
    toolName === "facility_create_task" ||
    toolName === "facility_amend_kb" ||
    toolName === "facility_connect_repo"
  ) {
    const projectId = requiredString(args.projectId, "projectId");
    await assertMcpProjectInOrg(db, orgId, projectId);
    return projectId;
  }
  if (toolName === "facility_create_registry_draft") {
    const scope = requiredString(args.scope, "scope");
    if (scope !== "org" && scope !== "project") throw new Error("registry_scope_invalid");
    const projectId = scope === "project" ? requiredString(args.projectId, "projectId") : null;
    await assertMcpProjectInOrg(db, orgId, projectId);
    return projectId;
  }
  if (
    toolName === "facility_cancel_run" ||
    toolName === "facility_steer_run" ||
    toolName === "facility_interrupt_run" ||
    toolName === "facility_resume_run"
  ) {
    const runId = requiredString(args.runId, "runId");
    const run = (
      await db
        .select({ projectId: runs.projectId })
        .from(runs)
        .where(and(eq(runs.orgId, orgId), eq(runs.id, runId)))
        .limit(1)
    )[0];
    if (!run) throw new Error("run_not_found");
    return run.projectId;
  }
  if (toolName === "facility_send_conversation_message") {
    const conversationId = requiredString(args.conversationId, "conversationId");
    const conversation = (
      await db
        .select({ projectId: conversations.projectId })
        .from(conversations)
        .where(and(eq(conversations.orgId, orgId), eq(conversations.id, conversationId)))
        .limit(1)
    )[0];
    if (!conversation) throw new Error("conversation_not_found");
    return conversation.projectId;
  }
  if (toolName === "facility_transition_task" || toolName === "facility_propose_task") {
    const taskId = requiredString(args.taskId, "taskId");
    const task = (
      await db
        .select({ projectId: poTasks.projectId })
        .from(poTasks)
        .where(and(eq(poTasks.orgId, orgId), eq(poTasks.id, taskId)))
        .limit(1)
    )[0];
    if (!task) throw new Error("task_not_found");
    return task.projectId;
  }
  if (toolName === "facility_ack_issue" || toolName === "facility_resolve_issue") {
    const issueId = requiredString(args.issueId, "issueId");
    const issue = (
      await db
        .select({ projectId: platformIssues.projectId })
        .from(platformIssues)
        .where(and(eq(platformIssues.orgId, orgId), eq(platformIssues.id, issueId)))
        .limit(1)
    )[0];
    if (!issue) throw new Error("issue_not_found");
    return issue.projectId;
  }
  if (toolName === "facility_set_budget") {
    const budgetId = optionalString(args.budgetId);
    if (!budgetId) {
      const projectId = optionalString(args.projectId) ?? null;
      await assertMcpProjectInOrg(db, orgId, projectId);
      return projectId;
    }
    const budget = (
      await db
        .select({ projectId: budgets.projectId })
        .from(budgets)
        .where(and(eq(budgets.orgId, orgId), eq(budgets.id, budgetId)))
        .limit(1)
    )[0];
    if (!budget) throw new Error("budget_not_found");
    return budget.projectId;
  }
  if (
    toolName === "facility_publish_registry_version" ||
    toolName === "facility_deprecate_registry_version"
  ) {
    const versionId = requiredString(args.versionId, "versionId");
    const version = (
      await db
        .select({ projectId: registryItems.projectId })
        .from(registryVersions)
        .innerJoin(registryItems, eq(registryItems.id, registryVersions.itemId))
        .where(and(eq(registryVersions.orgId, orgId), eq(registryVersions.id, versionId)))
        .limit(1)
    )[0];
    if (!version) throw new Error("registry_version_not_found");
    return version.projectId;
  }
  if (toolName === "facility_retry_webhook_delivery") {
    const deliveryId = requiredString(args.deliveryId, "deliveryId");
    const delivery = (
      await db
        .select({ projectId: integrations.projectId })
        .from(webhookDeliveries)
        .innerJoin(integrations, eq(integrations.id, webhookDeliveries.integrationId))
        .where(and(eq(webhookDeliveries.orgId, orgId), eq(webhookDeliveries.id, deliveryId)))
        .limit(1)
    )[0];
    if (!delivery) throw new Error("webhook_delivery_not_found");
    return delivery.projectId;
  }
  throw new Error(`mcp_tool_not_allowed:${toolName}`);
}

function requiredString(value: unknown, field: string) {
  if (typeof value === "string" && value.trim()) return value;
  throw new Error(`mcp_tool_missing_${field}`);
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function resumableGithubContext(value: unknown) {
  const source = objectOrEmpty(value);
  return {
    ...(typeof source.owner === "string" ? { owner: source.owner } : {}),
    ...(typeof source.repo === "string" ? { repo: source.repo } : {}),
    ...(typeof source.branch === "string" ? { branch: source.branch } : {}),
  };
}

function requiredNumber(value: unknown, field: string) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`mcp_tool_missing_${field}`);
}

function requireConfig(options: ExecuteApprovedProposalOptions) {
  if (!options.config) throw new Error("mcp_tool_missing_config");
  return options.config;
}

function auditActorType(type: string) {
  return type === "user" || type === "key" || type === "agent" || type === "system"
    ? type
    : "system";
}

async function resolveAgentForMcpRun(db: Db, orgId: string, projectId: string, agentName: string) {
  const candidates = await db
    .select()
    .from(agentDefs)
    .where(
      and(
        eq(agentDefs.orgId, orgId),
        eq(agentDefs.projectId, projectId),
        eq(agentDefs.enabled, true),
      ),
    );
  const values = new Set([
    agentName,
    agentName.startsWith("/") ? agentName.slice(1) : `/${agentName}`,
  ]);
  const agent = candidates.find((row) => {
    if (values.has(row.name)) return true;
    const triggers = row.triggers as unknown;
    return Array.isArray(triggers)
      ? triggers.some((trigger) => {
          if (!trigger || typeof trigger !== "object") return false;
          const value =
            (trigger as { command?: unknown; handle?: unknown }).command ??
            (trigger as { handle?: unknown }).handle;
          return typeof value === "string" && values.has(value);
        })
      : false;
  });
  if (!agent) throw new Error("agent_required");
  return agent;
}

async function loadMcpRepo(db: Db, orgId: string, projectId: string, repoId: string) {
  const byId = (
    await db
      .select()
      .from(repos)
      .where(and(eq(repos.orgId, orgId), eq(repos.projectId, projectId), eq(repos.id, repoId)))
      .limit(1)
  )[0];
  if (byId) return byId;
  const [owner, name] = repoId.split("/");
  if (owner && name) {
    const byName = (
      await db
        .select()
        .from(repos)
        .where(
          and(
            eq(repos.orgId, orgId),
            eq(repos.projectId, projectId),
            eq(repos.owner, owner),
            eq(repos.name, name),
          ),
        )
        .limit(1)
    )[0];
    if (byName) return byName;
  }
  throw new Error("repo_not_found");
}

async function assertMcpProjectInOrg(db: Db, orgId: string, projectId: string | null | undefined) {
  if (!projectId) return;
  const project = (
    await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.orgId, orgId), eq(projects.id, projectId)))
      .limit(1)
  )[0];
  if (!project) throw new Error("project_not_found");
}

async function assertMcpRegistryReference(
  db: Db,
  orgId: string,
  projectId: string,
  itemId: string | undefined,
) {
  if (!itemId) return;
  const item = (
    await db
      .select()
      .from(registryItems)
      .where(and(eq(registryItems.orgId, orgId), eq(registryItems.id, itemId)))
      .limit(1)
  )[0];
  if (!item || (item.projectId && item.projectId !== projectId)) {
    throw new Error("registry_reference_not_in_project");
  }
}

async function resolveMcpAgentContract(
  db: Db,
  orgId: string,
  projectId: string,
  args: Record<string, unknown>,
  actorId: string,
) {
  const referencedItemId = optionalString(args.contractItemId);
  const inlineContent = optionalString(args.contractContent);
  if (referencedItemId && inlineContent) {
    throw new Error("mcp_agent_contract_ambiguous");
  }
  if (referencedItemId) {
    await assertMcpRegistryReference(db, orgId, projectId, referencedItemId);
    return referencedItemId;
  }
  if (!inlineContent) throw new Error("mcp_tool_missing_contractItemId_or_contractContent");

  const agentName = requiredString(args.name, "name");
  const contentHash = createHash("sha256").update(inlineContent).digest("hex");
  const itemName = `${agentName}-contract-${contentHash.slice(0, 8)}`;
  return db.transaction(async (tx) => {
    const inserted = (
      await tx
        .insert(registryItems)
        .values({
          id: newId("item"),
          orgId,
          projectId,
          scope: "project",
          kind: "contract",
          name: itemName,
          description: `Inline contract for agent ${agentName}`,
          latestVersion: 1,
        })
        .onConflictDoNothing()
        .returning()
    )[0];
    const item =
      inserted ??
      (
        await tx
          .select()
          .from(registryItems)
          .where(
            and(
              eq(registryItems.orgId, orgId),
              eq(registryItems.projectId, projectId),
              eq(registryItems.kind, "contract"),
              eq(registryItems.name, itemName),
            ),
          )
          .limit(1)
      )[0];
    if (!item) throw new Error("mcp_agent_contract_create_failed");

    await tx
      .insert(registryVersions)
      .values({
        id: newId("ver"),
        orgId,
        itemId: item.id,
        version: 1,
        content: inlineContent,
        contentHash,
        changelog: "Created with MCP agent definition",
        status: "active",
        createdBy: actorId,
      })
      .onConflictDoNothing();
    const version = (
      await tx
        .select({ contentHash: registryVersions.contentHash })
        .from(registryVersions)
        .where(
          and(
            eq(registryVersions.orgId, orgId),
            eq(registryVersions.itemId, item.id),
            eq(registryVersions.version, 1),
          ),
        )
        .limit(1)
    )[0];
    if (version?.contentHash !== contentHash) {
      throw new Error("mcp_agent_contract_content_mismatch");
    }
    await tx
      .update(registryItems)
      .set({ latestVersion: 1, updatedAt: new Date() })
      .where(and(eq(registryItems.orgId, orgId), eq(registryItems.id, item.id)));
    return item.id;
  });
}

async function assertMcpSandboxReference(
  db: Db,
  orgId: string,
  projectId: string,
  sandboxProfileId: string | undefined,
) {
  if (!sandboxProfileId) return;
  const profile = (
    await db
      .select()
      .from(sandboxProfiles)
      .where(and(eq(sandboxProfiles.orgId, orgId), eq(sandboxProfiles.id, sandboxProfileId)))
      .limit(1)
  )[0];
  if (!profile || (profile.projectId && profile.projectId !== projectId)) {
    throw new Error("sandbox_reference_not_in_project");
  }
}

async function assertMcpKbEntryInProject(
  db: Db,
  orgId: string,
  projectId: string,
  entryId: string,
) {
  const entry = (
    await db
      .select({ id: kbEntries.id })
      .from(kbEntries)
      .innerJoin(kbSpaces, eq(kbSpaces.id, kbEntries.spaceId))
      .where(
        and(
          eq(kbEntries.orgId, orgId),
          eq(kbEntries.id, entryId),
          eq(kbSpaces.orgId, orgId),
          eq(kbSpaces.projectId, projectId),
        ),
      )
      .limit(1)
  )[0];
  if (!entry) throw new Error("kb_entry_not_in_project");
}

async function createTaskCreationProposal(
  db: Db,
  orgId: string,
  taskId: string,
  actor: { type: string; id: string },
) {
  const task = (
    await db
      .select()
      .from(poTasks)
      .where(and(eq(poTasks.orgId, orgId), eq(poTasks.id, taskId)))
      .limit(1)
  )[0];
  if (!task) throw new Error("task_not_found");
  const actionType = (
    await db
      .select()
      .from(actionTypes)
      .where(and(eq(actionTypes.orgId, orgId), eq(actionTypes.name, "task_creation")))
      .limit(1)
  )[0];
  if (!actionType) throw new Error("task_creation_action_type_missing");
  const repo = (
    await db
      .select()
      .from(repos)
      .where(and(eq(repos.orgId, orgId), eq(repos.projectId, task.projectId)))
      .limit(1)
  )[0];
  const project = (
    await db
      .select()
      .from(projects)
      .where(and(eq(projects.orgId, orgId), eq(projects.id, task.projectId)))
      .limit(1)
  )[0];
  const proposal = (
    await db
      .insert(proposals)
      .values({
        id: newId("prop"),
        orgId,
        projectId: task.projectId,
        actionTypeId: actionType.id,
        payload: {
          taskId: task.id,
          title: task.title,
          bodyMd: task.bodyMd,
          wsjf: task.wsjf,
          target: {
            repo: repo ? { owner: repo.owner, name: repo.name } : null,
            board: objectOrEmpty(project?.settings).board,
          },
        },
        contextMd: `Task creation proposal for ${task.title}`,
        expiresAt: new Date(Date.now() + actionType.defaultTtlHours * 3_600_000),
      })
      .returning()
  )[0];
  if (!proposal) throw new Error("task_proposal_create_failed");
  await db.insert(proposalEvents).values({
    orgId,
    proposalId: proposal.id,
    seq: 1,
    type: "open",
    actor,
    data: { taskId },
  });
  return { proposalId: proposal.id };
}

async function connectMcpRepo(
  db: Db,
  orgId: string,
  projectId: string,
  args: Record<string, unknown>,
  options: ExecuteApprovedProposalOptions,
) {
  const owner = requiredString(args.owner, "owner");
  const name = requiredString(args.name, "name");
  const installation = (
    await db
      .select()
      .from(githubInstallations)
      .where(
        and(
          eq(githubInstallations.orgId, orgId),
          eq(githubInstallations.accountLogin, owner),
          isNull(githubInstallations.suspendedAt),
        ),
      )
      .limit(1)
  )[0];
  if (!installation) throw new Error("github_installation_required");
  const factory = options.githubFactory ?? createGithubClientFactory(requireConfig(options));
  const octokit = await factory(installation.installationId);
  const shouldCreate = args.create === true || args.mode === "create";
  const createRepository = octokit.rest.repos.createInOrg;
  const getRepository = octokit.rest.repos.get;
  if (shouldCreate && !createRepository) throw new Error("github_create_unavailable");
  if (!shouldCreate && !getRepository) throw new Error("github_lookup_unavailable");
  const response = shouldCreate
    ? await createRepository?.({
        org: owner,
        name,
        private: args.private !== false,
        description: optionalString(args.description),
        auto_init: args.autoInit !== false,
      })
    : await getRepository?.({ owner, repo: name });
  if (!response) throw new Error("github_repo_unavailable");
  const repo = (
    await db
      .insert(repos)
      .values({
        id: newId("repo"),
        orgId,
        projectId,
        installationId: installation.id,
        owner: response.data.owner?.login ?? owner,
        name: response.data.name,
        defaultBranch: response.data.default_branch ?? optionalString(args.defaultBranch) ?? "main",
      })
      .returning()
  )[0];
  if (!repo) throw new Error("repo_connect_failed");
  return { repoId: repo.id };
}

async function executeTaskCreation(
  db: Db,
  proposal: typeof proposals.$inferSelect,
  options: ExecuteApprovedProposalOptions,
) {
  const payload = objectOrEmpty(proposal.payload);
  const taskId = stringField(payload.taskId);
  if (!taskId) throw new Error("task_creation_missing_task_id");
  const task = (
    await db
      .select()
      .from(poTasks)
      .where(
        and(
          eq(poTasks.orgId, proposal.orgId),
          eq(poTasks.projectId, proposal.projectId ?? ""),
          eq(poTasks.id, taskId),
        ),
      )
      .limit(1)
  )[0];
  if (!task) throw new Error("task_not_found");
  if (task.orgId !== proposal.orgId || task.projectId !== proposal.projectId) {
    throw new Error("task_not_in_proposal_project");
  }
  const repo = (
    await db
      .select()
      .from(repos)
      .where(and(eq(repos.orgId, proposal.orgId), eq(repos.projectId, task.projectId)))
      .limit(1)
  )[0];
  if (!repo) throw new Error("task_creation_missing_repo");
  const github = options.github ?? (await githubIssueClientForRepo(db, repo, options));
  const issueBody = `${task.bodyMd.trimEnd()}

## Value

\`\`\`json
${JSON.stringify(task.wsjf, null, 2)}
\`\`\`

## KB trace

- task: ${task.id}${task.kbEntryId ? `\n- kb_entry: ${task.kbEntryId}` : ""}
`;
  const issue = await github.createIssue({
    repo: { owner: repo.owner, name: repo.name },
    title: task.title,
    body: issueBody,
    labels: ["type:task", "priority:wsjf"],
  });
  const board = objectOrEmpty(objectOrEmpty(payload.target).board);
  if (github.addToBoard && stringField(board.org) && typeof board.number === "number") {
    await github.addToBoard({
      org: stringField(board.org) ?? "",
      number: board.number,
      issueUrl: issue.url,
    });
  }
  await db
    .update(poTasks)
    .set({
      status: "created",
      gh: { repo: `${repo.owner}/${repo.name}`, issue_number: issue.number, url: issue.url },
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(poTasks.orgId, proposal.orgId),
        eq(poTasks.projectId, task.projectId),
        eq(poTasks.id, task.id),
      ),
    );
}

/**
 * Approved issue_update: full title+body replacement on the GitHub issue,
 * plus an optimistic mirror update so the story page reflects the change
 * before the issues webhook echoes it back.
 */
async function executeIssueUpdate(
  db: Db,
  proposal: typeof proposals.$inferSelect,
  options: ExecuteApprovedProposalOptions,
) {
  const payload = objectOrEmpty(proposal.payload);
  const issueNumber = typeof payload.issueNumber === "number" ? payload.issueNumber : Number.NaN;
  const repoId = stringField(payload.repoId);
  const title = stringField(payload.title);
  const bodyMd = stringField(payload.bodyMd);
  if (!Number.isFinite(issueNumber) || !title || bodyMd == null) {
    throw new Error("issue_update_payload_invalid");
  }
  const matchingRepos = await db
    .select()
    .from(repos)
    .where(
      and(
        eq(repos.orgId, proposal.orgId),
        eq(repos.projectId, proposal.projectId ?? ""),
        ...(repoId ? [eq(repos.id, repoId)] : []),
      ),
    )
    .limit(2);
  if (!repoId && matchingRepos.length > 1) throw new Error("issue_update_ambiguous_repo");
  const repo = matchingRepos[0];
  if (!repo) throw new Error("issue_update_missing_repo");
  const github = options.github ?? (await githubIssueClientForRepo(db, repo, options));
  if (!github.updateIssue) throw new Error("issue_update_unsupported_client");
  await github.updateIssue({ number: issueNumber, title, body: bodyMd });
  await db
    .update(ghIssues)
    .set({ title, bodyMd, ghUpdatedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(ghIssues.orgId, proposal.orgId),
        eq(ghIssues.repoId, repo.id),
        eq(ghIssues.number, issueNumber),
      ),
    );
}

async function githubIssueClientForRepo(
  db: Db,
  repo: typeof repos.$inferSelect,
  options: ExecuteApprovedProposalOptions,
): Promise<GitHubIssueClient> {
  const config = options.config;
  if (!repo.installationId) {
    throw new Error("github_repo_not_installed");
  }
  if (!options.githubFactory && (!config?.githubAppId || !config.githubAppPrivateKey)) {
    throw new Error("github_app_not_configured");
  }
  const installation = (
    await db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.id, repo.installationId))
      .limit(1)
  )[0];
  if (!installation) throw new Error("github_installation_missing");

  const factory = options.githubFactory ?? createGithubClientFactory(config as AppConfig);
  const client = new FacilityGithubClient(await factory(installation.installationId), {
    owner: repo.owner,
    repo: repo.name,
    defaultBranch: repo.defaultBranch,
  });
  return {
    createIssue(input) {
      return client.createIssue({
        title: input.title,
        body: input.body,
        labels: input.labels,
      });
    },
    async updateIssue(input) {
      await client.updateIssue(input.number, { title: input.title, body: input.body });
    },
  };
}

function isGitHubIssueClient(value: ExecuteApprovedProposalOptions | GitHubIssueClient) {
  return "createIssue" in value;
}

async function executeRegistryDraft(
  db: Db,
  proposal: ProposalExecutionContext,
  kind: string,
  createdBy = "learning",
) {
  const payload = objectOrEmpty(proposal.payload);
  const name = stringField(payload.name);
  const content = stringField(payload.content);
  if (!name || !content) throw new Error("registry_draft_payload_invalid");
  // Match the registry item within the PROPOSAL's scope only — the unique index
  // is (org, coalesce(project_id,'__none__'), kind, name), so a project proposal
  // must not reuse (and draft a version into) another project's, or the org's,
  // same-named item.
  const existing = (
    await db
      .select()
      .from(registryItems)
      .where(
        and(
          eq(registryItems.orgId, proposal.orgId),
          eq(registryItems.kind, kind),
          eq(registryItems.name, name),
          proposal.projectId
            ? eq(registryItems.projectId, proposal.projectId)
            : isNull(registryItems.projectId),
        ),
      )
      .limit(1)
  )[0];
  const item =
    existing ??
    (
      await db
        .insert(registryItems)
        .values({
          id: newId("item"),
          orgId: proposal.orgId,
          scope: proposal.projectId ? "project" : "org",
          projectId: proposal.projectId,
          kind,
          name,
          description: stringField(payload.description) ?? `Draft from ${proposal.id}`,
        })
        .returning()
    )[0];
  if (!item) throw new Error("registry_item_create_failed");
  // Advisory-locked next-version allocation (shared with the HTTP route) — no
  // duplicate-key race with a concurrent draft on the same item.
  const version = await createNextDraftVersion(db, {
    orgId: proposal.orgId,
    itemId: item.id,
    content,
    changelog: `Drafted from approved proposal ${proposal.id}`,
    createdBy,
  });
  if (!version) throw new Error("registry_draft_create_failed");
  const active = await publishRegistryVersion(db, proposal.orgId, version.id);
  return { itemId: item.id, versionId: active.id, status: active.status };
}

async function executeGuardCandidate(
  db: Db,
  proposal: typeof proposals.$inferSelect,
  options: ExecuteApprovedProposalOptions,
) {
  if (!proposal.projectId) throw new Error("guard_candidate_missing_project");
  const payload = objectOrEmpty(proposal.payload);
  const title = stringField(payload.title) ?? `Guard candidate ${proposal.id}`;
  const rawContent = stringField(payload.content);
  if (!rawContent) throw new Error("guard_candidate_content_missing");
  const content = executableGuardContent(rawContent);
  if (!/export\s+default/.test(content) || !/\brun\s*\(/.test(content)) {
    throw new Error("guard_candidate_not_executable");
  }
  const repo = (
    await db
      .select()
      .from(repos)
      .where(and(eq(repos.orgId, proposal.orgId), eq(repos.projectId, proposal.projectId)))
      .orderBy(repos.createdAt)
      .limit(1)
  )[0];
  if (!repo?.installationId) throw new Error("guard_candidate_repo_unavailable");
  const factory =
    options.githubFactory ??
    (options.config?.githubAppId && options.config.githubAppPrivateKey
      ? createGithubClientFactory(options.config)
      : null);
  if (!factory) throw new Error("github_app_unconfigured");
  const client = await createGithubClientForRepo(db, factory, repo);
  const evidence = Array.isArray(payload.evidence_refs)
    ? payload.evidence_refs.filter((value): value is string => typeof value === "string")
    : [];
  const recurrence = Array.isArray(payload.recurrence_fingerprints)
    ? payload.recurrence_fingerprints.filter(
        (value): value is string => typeof value === "string" && Boolean(value.trim()),
      )
    : [];
  const fingerprint = recurrence.length
    ? `guard:${[...recurrence].sort().join("|")}`
    : `guard:${title}:${createHash("sha256").update(content).digest("hex")}`;
  const issue = await ensureTrackedIssue(client, {
    kind: "learning",
    fingerprint,
    title: `[Facility learning] ${title}`,
    body: [
      `Approved learning proposal \`${proposal.id}\` identified recurring repository work. It is intentionally projected as a task before any code is changed.`,
      "",
      "## Context",
      "",
      proposal.contextMd,
      "",
      "## Evidence",
      "",
      ...(evidence.length ? evidence.map((value) => `- ${value}`) : ["- See proposal context"]),
      "",
      "## Proposed deterministic guard",
      "",
      "```js",
      content.trim(),
      "```",
      "",
      "## Delivery flow",
      "",
      "- Run `/architect` to turn this evidence into a repository-specific plan and acceptance checks.",
      "- Review or steer that plan in this issue.",
      "- Approve the plan, then use `/builder` to implement and open the pull request.",
      "- Keep the existing test and guard bar intact; the implementation must pass the repository checks.",
    ].join("\n"),
    labels: [
      {
        name: "facility-learning",
        color: "5319E7",
        description: "Repository work discovered by Facility learning",
      },
      {
        name: "type:task",
        color: "1D76DB",
        description: "Implementation-ready task",
      },
    ],
    reopen: false,
  });
  await insertAuditEvent(db, {
    orgId: proposal.orgId,
    projectId: proposal.projectId,
    actor: { type: "system", id: "learning-guard-executor" },
    action: issue.created
      ? "github.issue.created"
      : issue.updated
        ? "github.issue.updated"
        : "github.issue.deduplicated",
    target: { type: "proposal", id: proposal.id },
    payload: { kind: "guard_candidate", fingerprint, issue },
  });
  return { fingerprint, issue };
}

function executableGuardContent(content: string) {
  const fenced = content.match(/```(?:js|javascript|mjs)?\s*\n([\s\S]*?)```/i);
  return fenced?.[1] ?? content;
}

async function executeKbAmendment(db: Db, proposal: ProposalExecutionContext) {
  if (!proposal.projectId) throw new Error("kb_amendment_missing_project");
  const payload = objectOrEmpty(proposal.payload);
  const type = stringField(payload.type);
  const slug = stringField(payload.slug);
  const bodyMd = stringField(payload.bodyMd);
  if (!type || !slug || !bodyMd) throw new Error("kb_amendment_payload_invalid");
  const space = (
    await db
      .select()
      .from(kbSpaces)
      .where(and(eq(kbSpaces.orgId, proposal.orgId), eq(kbSpaces.projectId, proposal.projectId)))
      .limit(1)
  )[0];
  if (!space) throw new Error("kb_space_missing");
  const graph = await loadKbGraph(db, proposal.orgId, proposal.projectId);
  if (!graph) throw new Error("kb_space_missing");
  const max =
    (
      await db
        .select()
        .from(kbEntries)
        .where(
          and(
            eq(kbEntries.orgId, proposal.orgId),
            eq(kbEntries.spaceId, space.id),
            eq(kbEntries.type, type),
          ),
        )
        .orderBy(desc(kbEntries.number))
        .limit(1)
    )[0]?.number ?? 0;
  const links = arrayOfStrings(payload.links);
  const parentEntries = graph.entries.filter((entry) => links.includes(entry.id));
  if (parentEntries.length !== links.length) throw new Error("kb_amendment_link_target_missing");
  // Optional supersedence: the approved amendment retires an existing entry
  // (payload.supersedes = artifact id, e.g. "D2"). Decisions change only this
  // way — never edited in place.
  const supersedesId = stringField(payload.supersedes);
  const predecessor = supersedesId
    ? graph.entries.find((entry) => artifactIdFor(entry) === supersedesId)
    : undefined;
  if (supersedesId && !predecessor) throw new Error("kb_amendment_supersedes_target_missing");
  if (predecessor && predecessor.type !== type) {
    throw new Error("kb_amendment_supersedes_type_mismatch");
  }
  const status =
    stringField(payload.status) ?? (supersedesId && type === "D" ? "decided" : "draft");
  const normalized = normalizeKbDraft({
    type,
    number: max + 1,
    slug,
    frontmatter: supersedesId
      ? { ...objectOrEmpty(payload.frontmatter), supersedes: supersedesId }
      : objectOrEmpty(payload.frontmatter),
    bodyMd,
    parentEntries,
  });
  const draft = {
    id: "__draft__",
    type,
    number: max + 1,
    slug,
    frontmatter: normalized.frontmatter,
    bodyMd: normalized.bodyMd,
    status,
    supersedes: supersedesId ?? null,
  };
  const report = validate({
    space: toHarnessSpace(space),
    entries: [...graph.entries, draft],
    links: [
      ...graph.links,
      ...parentEntries.flatMap((parent) => [
        { fromEntry: "__draft__", toEntry: parent.id },
        { fromEntry: parent.id, toEntry: "__draft__" },
      ]),
    ],
    entryId: "__draft__",
    validateSpecials: false,
  });
  if (!report.ok) throw new Error("kb_validation_failed");
  return db.transaction(async (tx) => {
    const inserted = (
      await tx
        .insert(kbEntries)
        .values({
          id: newId("kb"),
          orgId: proposal.orgId,
          spaceId: space.id,
          type,
          number: max + 1,
          slug,
          frontmatter: normalized.frontmatter,
          bodyMd: normalized.bodyMd,
          status,
          supersedes: supersedesId ?? null,
        })
        .returning()
    )[0];
    if (!inserted) throw new Error("kb_amendment_insert_failed");
    if (predecessor) {
      await tx
        .update(kbEntries)
        .set({ status: "superseded", updatedAt: new Date() })
        .where(and(eq(kbEntries.orgId, proposal.orgId), eq(kbEntries.id, predecessor.id)));
    }
    const childArtifactId = artifactIdFor(toHarnessEntry(inserted));
    for (const link of links) {
      await tx
        .insert(kbLinks)
        .values([
          { orgId: proposal.orgId, spaceId: space.id, fromEntry: inserted.id, toEntry: link },
          { orgId: proposal.orgId, spaceId: space.id, fromEntry: link, toEntry: inserted.id },
        ])
        .onConflictDoNothing();
      const parent = parentEntries.find((candidate) => candidate.id === link);
      if (parent) {
        await tx
          .update(kbEntries)
          .set({ bodyMd: ensureLinks(parent.bodyMd, [childArtifactId]), updatedAt: new Date() })
          .where(and(eq(kbEntries.orgId, proposal.orgId), eq(kbEntries.id, parent.id)));
      }
    }
    await tx
      .update(kbSpaces)
      .set({ activeMd: ensureActive(space.activeMd, [childArtifactId]), updatedAt: new Date() })
      .where(and(eq(kbSpaces.orgId, proposal.orgId), eq(kbSpaces.id, space.id)));
    return inserted.id;
  });
}

async function appendProposalEvent(
  db: Db,
  proposal: typeof proposals.$inferSelect,
  type: string,
  actor: { type: string; id: string },
  data: Record<string, unknown>,
) {
  const current = await db
    .select()
    .from(proposalEvents)
    .where(
      and(eq(proposalEvents.orgId, proposal.orgId), eq(proposalEvents.proposalId, proposal.id)),
    )
    .orderBy(desc(proposalEvents.seq))
    .limit(1);
  await db.insert(proposalEvents).values({
    orgId: proposal.orgId,
    proposalId: proposal.id,
    seq: (current[0]?.seq ?? 0) + 1,
    type,
    actor,
    data,
  });
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function arrayOfStrings(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

async function captureRecurrenceBaseline(db: Db, proposal: typeof proposals.$inferSelect) {
  const payload = objectOrEmpty(proposal.payload);
  const fingerprints = [...new Set(arrayOfStrings(payload.recurrence_fingerprints))].slice(0, 20);
  const requestedDays = Number(payload.evaluation_window_days);
  const evaluationWindowDays =
    Number.isInteger(requestedDays) && requestedDays >= 1 && requestedDays <= 30
      ? requestedDays
      : 7;
  if (!proposal.projectId || fingerprints.length === 0) {
    return { configured: false, evaluationWindowDays, fingerprints: [], baseline: [] };
  }
  const baseline = await db
    .select({
      fingerprint: platformIssues.fingerprint,
      count: platformIssues.count,
      firstSeen: platformIssues.firstSeen,
      lastSeen: platformIssues.lastSeen,
    })
    .from(platformIssues)
    .where(
      and(
        eq(platformIssues.orgId, proposal.orgId),
        eq(platformIssues.projectId, proposal.projectId),
        inArray(platformIssues.fingerprint, fingerprints),
      ),
    );
  const byFingerprint = new Map(baseline.map((issue) => [issue.fingerprint, issue]));
  return {
    configured: true,
    evaluationWindowDays,
    fingerprints,
    baseline: fingerprints.map((fingerprint) => {
      const issue = byFingerprint.get(fingerprint);
      return {
        fingerprint,
        count: issue?.count ?? 0,
        firstSeen: issue?.firstSeen?.toISOString() ?? null,
        lastSeen: issue?.lastSeen?.toISOString() ?? null,
      };
    }),
  };
}

function validatePayload(schema: unknown, payload: unknown) {
  const required = Array.isArray((schema as { required?: unknown }).required)
    ? (schema as { required: string[] }).required
    : [];
  const objectPayload = objectOrEmpty(payload);
  for (const key of required) {
    if (!(key in objectPayload)) throw new Error(`schema_validation_failed:${key}`);
  }
}
