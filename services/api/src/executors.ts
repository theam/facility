import { newId } from "@facility/core";
import type { createDb } from "@facility/db";
import {
  actionTypes,
  agentDefs,
  budgets,
  githubInstallations,
  insertAuditEvent,
  kbEntries,
  kbLinks,
  kbSpaces,
  platformIssues,
  poTasks,
  projects,
  proposalEvents,
  proposals,
  registryItems,
  registryVersions,
  repos,
  runEvents,
  runs,
  sandboxProfiles,
  steerMessages,
} from "@facility/db";
import { artifactIdFor, validate } from "@facility/harness";
import { and, desc, eq, isNull, notInArray, sql } from "drizzle-orm";
import { assertBudgetAgentInProject, resolveBudgetScope } from "./budget-scope.js";
import {
  createGithubClientFactory,
  FacilityGithubClient,
  type GithubClientFactory,
} from "./github/client.js";
import { type KickstartAnswers, kickstartRepo, upgradeRepo } from "./github/kickstart.js";
import { findAgentDef, laneFor } from "./github/router.js";
import {
  ensureActive,
  ensureLinks,
  loadKbGraph,
  normalizeKbDraft,
  toHarnessEntry,
  toHarnessSpace,
} from "./harness.js";
import { createNextDraftVersion, publishRegistryVersion } from "./registry.js";
import { cancelRun } from "./sandbox/orchestrator.js";
import { appendRunEvents, TERMINAL_RUN_STATUSES } from "./sandbox/state.js";
import type { AppConfig } from "./types.js";

type Db = ReturnType<typeof createDb>["db"];

export type GitHubIssueClient = {
  createIssue(input: {
    repo: { owner: string; name: string };
    title: string;
    body: string;
    labels: string[];
  }): Promise<{ number: number; url: string }>;
  addToBoard?(input: { org: string; number: number; issueUrl: string }): Promise<void>;
};

type ExecuteApprovedProposalOptions = {
  config?: AppConfig;
  github?: GitHubIssueClient;
  githubFactory?: GithubClientFactory;
  enqueue?: (queue: string, data: Record<string, unknown>) => Promise<string | null>;
};

export async function executeApprovedProposal(
  db: Db,
  proposal: typeof proposals.$inferSelect,
  actor: { type: string; id: string },
  options: ExecuteApprovedProposalOptions | GitHubIssueClient = {},
) {
  const executionOptions = isGitHubIssueClient(options) ? { github: options } : options;
  if (proposal.state !== "approved" && proposal.state !== "execution_failed") return;
  const actionType = (
    await db.select().from(actionTypes).where(eq(actionTypes.id, proposal.actionTypeId)).limit(1)
  )[0];
  if (!actionType) return;
  try {
    validatePayload(actionType.payloadSchema, proposal.payload);
    if (actionType.name === "task_creation") {
      await executeTaskCreation(db, proposal, executionOptions);
    } else if (actionType.name === "skill_proposal" || actionType.name === "rule_proposal") {
      await executeRegistryDraft(
        db,
        proposal,
        actionType.name === "skill_proposal" ? "skill" : "rule",
      );
    } else if (actionType.name === "guard_candidate") {
      await executeGuardCandidate(db, proposal);
    } else if (actionType.name === "kb_amendment") {
      await executeKbAmendment(db, proposal);
    } else if (actionType.name === "plan_acceptance") {
      if (objectOrEmpty(actionType.executor).type !== "internal") return;
      await executePlanAcceptance(db, proposal, actor, executionOptions);
    } else if (actionType.name === "mcp_tool_call") {
      await executeMcpToolCall(db, proposal, actor, executionOptions);
    } else {
      return;
    }
    await db
      .update(proposals)
      .set({ state: "executed", updatedAt: new Date() })
      .where(and(eq(proposals.orgId, proposal.orgId), eq(proposals.id, proposal.id)));
    await appendProposalEvent(db, proposal, "executed", actor, { actionType: actionType.name });
  } catch (error) {
    await db
      .update(proposals)
      .set({ state: "execution_failed", updatedAt: new Date() })
      .where(and(eq(proposals.orgId, proposal.orgId), eq(proposals.id, proposal.id)));
    await appendProposalEvent(db, proposal, "execution_failed", actor, {
      actionType: actionType.name,
      error: error instanceof Error ? error.message : String(error),
    });
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
  if (architectRun.mode !== "architect") {
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

  const builder = await findAgentDef(db, proposal.orgId, proposal.projectId, "builder");
  if (!builder) throw new Error("plan_acceptance_builder_not_configured");

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
          proposalId: proposal.id,
          architectRunId: architectRun.id,
          architectTrigger: architectRun.trigger,
        },
        gh: architectRun.gh,
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
  }
  await options.enqueue?.("runs.dispatch", { runId: run.id, orgId: proposal.orgId });
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
  const result = await executeKnownMcpTool(
    db,
    proposal.orgId,
    actor,
    toolName,
    args,
    options,
    proposalProjectId,
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

async function executeKnownMcpTool(
  db: Db,
  orgId: string,
  actor: { type: string; id: string },
  toolName: string,
  args: Record<string, unknown>,
  options: ExecuteApprovedProposalOptions,
  proposalProjectId: string | null,
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
          mode: "manual",
          engine: "codex",
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

  if (toolName === "facility_create_agent") {
    const projectId = requiredString(args.projectId, "projectId");
    await assertMcpProjectInOrg(db, orgId, projectId);
    await assertMcpRegistryReference(
      db,
      orgId,
      projectId,
      requiredString(args.contractItemId, "contractItemId"),
    );
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
          contractItemId: requiredString(args.contractItemId, "contractItemId"),
          harnessItemId: optionalString(args.harnessItemId),
          triggers: Array.isArray(args.triggers) ? args.triggers : [],
          sandboxProfileId: optionalString(args.sandboxProfileId),
          enabled: true,
        })
        .returning()
    )[0];
    return { agentId: agent?.id };
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
    toolName === "facility_trigger_run" ||
    toolName === "facility_create_agent" ||
    toolName === "facility_kickstart" ||
    toolName === "facility_upgrade_project"
  ) {
    const projectId = requiredString(args.projectId, "projectId");
    await assertMcpProjectInOrg(db, orgId, projectId);
    return projectId;
  }
  if (toolName === "facility_cancel_run" || toolName === "facility_steer_run") {
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
  if (toolName === "facility_publish_registry_version") {
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
  throw new Error(`mcp_tool_not_allowed:${toolName}`);
}

function requiredString(value: unknown, field: string) {
  if (typeof value === "string" && value.trim()) return value;
  throw new Error(`mcp_tool_missing_${field}`);
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
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
  };
}

function isGitHubIssueClient(value: ExecuteApprovedProposalOptions | GitHubIssueClient) {
  return "createIssue" in value;
}

async function executeRegistryDraft(db: Db, proposal: typeof proposals.$inferSelect, kind: string) {
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
  await createNextDraftVersion(db, {
    orgId: proposal.orgId,
    itemId: item.id,
    content,
    changelog: `Drafted from approved proposal ${proposal.id}`,
    createdBy: "learning",
  });
}

async function executeGuardCandidate(db: Db, proposal: typeof proposals.$inferSelect) {
  const payload = objectOrEmpty(proposal.payload);
  const title = stringField(payload.title) ?? `Guard candidate ${proposal.id}`;
  await db
    .insert(platformIssues)
    .values({
      id: newId("iss"),
      orgId: proposal.orgId,
      projectId: proposal.projectId,
      kind: "learning",
      severity: "info",
      fingerprint: `learning:guard:${proposal.id}`,
      title,
      bodyMd: stringField(payload.content) ?? proposal.contextMd,
    })
    .onConflictDoNothing();
}

async function executeKbAmendment(db: Db, proposal: typeof proposals.$inferSelect) {
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
  const normalized = normalizeKbDraft({
    type,
    number: max + 1,
    slug,
    frontmatter: objectOrEmpty(payload.frontmatter),
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
    status: "draft",
    supersedes: null,
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
  await db.transaction(async (tx) => {
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
          status: "draft",
        })
        .returning()
    )[0];
    if (!inserted) throw new Error("kb_amendment_insert_failed");
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

function validatePayload(schema: unknown, payload: unknown) {
  const required = Array.isArray((schema as { required?: unknown }).required)
    ? (schema as { required: string[] }).required
    : [];
  const objectPayload = objectOrEmpty(payload);
  for (const key of required) {
    if (!(key in objectPayload)) throw new Error(`schema_validation_failed:${key}`);
  }
}
