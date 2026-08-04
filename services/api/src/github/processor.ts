import { newId } from "@facility/core";
import {
  agentDefs,
  type FacilityDb,
  githubInstallations,
  inboundEvents,
  insertAuditEvent,
  integrations,
  outcomes,
  previewSandboxes,
  repos,
  runEvents,
  runs,
} from "@facility/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { applyFacilitySignal } from "../integrations/signals.js";
import type { AppConfig } from "../types.js";
import {
  createGithubClientFactory,
  FacilityGithubClient,
  type GithubClientFactory,
} from "./client.js";
import {
  bumpGhIssueCommentCount,
  syncRepoIssues,
  upsertGhIssueFromWebhook,
} from "./issues-sync.js";
import { syncRepoFacilityConfig, verifyFingerprints } from "./kickstart.js";
import { laneFor, routeTrigger, type TriggerPayload } from "./router.js";
import { renderGithubRunProgress } from "./run-progress.js";

type WebhookPayload = TriggerPayload & {
  action?: string;
  installation?: {
    id?: number;
    account?: { id?: number; login?: string; type?: string };
    target_type?: string;
  };
  repositories?: {
    full_name?: string;
    name?: string;
    owner?: { login?: string };
    default_branch?: string;
  }[];
  repository?: TriggerPayload["repository"] & { full_name?: string; default_branch?: string };
  pull_request?: {
    number?: number;
    title?: string;
    body?: string | null;
    draft?: boolean;
    html_url?: string;
    merged?: boolean;
    base?: { ref?: string };
    head?: { ref?: string; sha?: string };
    created_at?: string;
    closed_at?: string;
  };
  review?: { id?: number; body?: string | null; state?: string; user?: { login?: string } };
  workflow_run?: {
    id?: number;
    name?: string;
    conclusion?: string;
    html_url?: string;
    head_branch?: string;
    head_sha?: string;
    pull_requests?: Array<{ number?: number; head?: { ref?: string }; base?: { ref?: string } }>;
  };
  deployment_status?: {
    id?: number;
    state?: string;
    description?: string;
    environment?: string;
    target_url?: string;
  };
  check_run?: {
    id?: number;
    name?: string;
    status?: string;
    conclusion?: string | null;
    html_url?: string;
  };
};

export async function processGithubWebhook(
  db: FacilityDb,
  config: AppConfig,
  data: { inboundEventId?: string },
  factory?: GithubClientFactory,
  enqueue?: (queue: string, data: Record<string, unknown>) => Promise<unknown>,
) {
  if (!data.inboundEventId) return;
  const event = (
    await db.select().from(inboundEvents).where(eq(inboundEvents.id, data.inboundEventId)).limit(1)
  )[0];
  if (!event || event.processedAt) return;
  const payload = event.payload as WebhookPayload;
  try {
    if (event.eventType === "installation" || event.eventType === "installation_repositories") {
      await processInstallation(db, event.orgId, payload, enqueue);
    } else if (event.eventType === "push") {
      await processPush(db, event.orgId, payload, config, factory, enqueue);
    } else if (event.eventType === "issues") {
      await upsertGhIssueFromWebhook(db, event.orgId, payload);
      await processTrigger(
        db,
        event.orgId,
        factory ?? createGithubClientFactory(config),
        payload,
        enqueue,
      );
    } else if (event.eventType === "issue_comment") {
      await bumpGhIssueCommentCount(db, event.orgId, payload);
      await processTrigger(
        db,
        event.orgId,
        factory ?? createGithubClientFactory(config),
        payload,
        enqueue,
      );
    } else if (event.eventType === "pull_request") {
      await processPullRequest(
        db,
        event.orgId,
        event.id,
        payload,
        factory ?? createGithubClientFactory(config),
        enqueue,
      );
    } else if (event.eventType === "pull_request_review") {
      await processGithubAgentEvent(
        db,
        event.orgId,
        event.id,
        "pull_request_review",
        payload,
        factory ?? createGithubClientFactory(config),
        enqueue,
      );
    } else if (event.eventType === "workflow_run") {
      await processWorkflowRun(
        db,
        event.orgId,
        event.id,
        payload,
        factory ?? createGithubClientFactory(config),
        enqueue,
      );
    } else if (event.eventType === "deployment_status" || event.eventType === "check_run") {
      await processOperationalSignal(db, event.orgId, event.eventType, payload);
    }
    await db
      .update(inboundEvents)
      .set({ processedAt: new Date() })
      .where(eq(inboundEvents.id, event.id));
  } catch (error) {
    await db
      .update(inboundEvents)
      .set({ error: error instanceof Error ? error.message : "unknown error" })
      .where(eq(inboundEvents.id, event.id));
    throw error;
  }
}

async function processInstallation(
  db: FacilityDb,
  orgId: string,
  payload: WebhookPayload,
  enqueue?: (queue: string, data: Record<string, unknown>) => Promise<unknown>,
) {
  const installationId = payload.installation?.id;
  const accountId = payload.installation?.account?.id;
  const accountLogin = payload.installation?.account?.login;
  if (!installationId || !accountId || !accountLogin) return;
  const row = (
    await db
      .insert(githubInstallations)
      .values({
        id: newId("int"),
        orgId,
        installationId,
        accountId,
        accountLogin,
        targetType:
          payload.installation?.target_type ??
          payload.installation?.account?.type ??
          "Organization",
        suspendedAt: payload.action === "suspend" ? new Date() : null,
      })
      .onConflictDoUpdate({
        target: githubInstallations.installationId,
        set: {
          accountLogin,
          accountId,
          targetType:
            payload.installation?.target_type ??
            payload.installation?.account?.type ??
            "Organization",
          suspendedAt:
            payload.action === "suspend"
              ? new Date()
              : payload.action === "unsuspend"
                ? null
                : undefined,
          updatedAt: new Date(),
        },
      })
      .returning()
  )[0];
  if (!row) return;
  if (payload.action === "deleted" || payload.action === "suspend") {
    await db
      .update(repos)
      .set({ fingerprintStatus: "orphaned", updatedAt: new Date() })
      .where(eq(repos.installationId, row.id));
    return;
  }
  const installationRepos =
    payload.repositories?.map((repo) => ({
      owner: repo.owner?.login ?? repo.full_name?.split("/")[0],
      name: repo.name ?? repo.full_name?.split("/")[1],
      defaultBranch: repo.default_branch,
    })) ?? [];
  for (const item of installationRepos) {
    if (!item.owner || !item.name) continue;
    const updated = await db
      .update(repos)
      .set({
        installationId: row.id,
        defaultBranch: item.defaultBranch ?? sql`${repos.defaultBranch}`,
        updatedAt: new Date(),
      })
      .where(and(eq(repos.orgId, orgId), eq(repos.owner, item.owner), eq(repos.name, item.name)))
      .returning();
    for (const repo of updated) {
      await enqueue?.("github.issues-sync", { repoId: repo.id, orgId: repo.orgId });
    }
  }
}

async function processPush(
  db: FacilityDb,
  orgId: string,
  payload: WebhookPayload,
  config: AppConfig,
  factory?: GithubClientFactory,
  enqueue?: (queue: string, data: Record<string, unknown>) => Promise<unknown>,
) {
  const owner = payload.repository?.owner?.login;
  const name = payload.repository?.name;
  const branch = String((payload as { ref?: string }).ref ?? "").replace(/^refs\/heads\//, "");
  if (!owner || !name) return;
  // Scope to the webhook's resolved org: repos are per-org unique (migration
  // 0012), so a global owner/name lookup could select another tenant's repo.
  const repo = (
    await db
      .select()
      .from(repos)
      .where(and(eq(repos.orgId, orgId), eq(repos.owner, owner), eq(repos.name, name)))
      .limit(1)
  )[0];
  if (!repo || branch !== repo.defaultBranch) return;
  const commits =
    (payload as { commits?: { added?: string[]; modified?: string[]; removed?: string[] }[] })
      .commits ?? [];
  const changed = new Set(
    commits.flatMap((commit) => [
      ...(commit.added ?? []),
      ...(commit.modified ?? []),
      ...(commit.removed ?? []),
    ]),
  );
  const managed = new Set(
    ((repo.fingerprint as { files?: { path: string }[] } | null)?.files ?? []).map(
      (file) => file.path,
    ),
  );
  if (changed.has(".facility.json")) {
    await syncRepoFacilityConfig({
      db,
      factory: factory ?? createGithubClientFactory(config),
      repo,
    });
  }
  if ([...changed].some((path) => managed.has(path))) {
    await enqueue?.("fingerprints.verify", { repoId: repo.id });
  }
}

async function processTrigger(
  db: FacilityDb,
  orgId: string,
  factory: GithubClientFactory,
  payload: WebhookPayload,
  enqueue?: (queue: string, data: Record<string, unknown>) => Promise<unknown>,
) {
  const owner = payload.repository?.owner?.login;
  const name = payload.repository?.name;
  const installationId = payload.installation?.id;
  if (!owner || !name || !installationId) return;
  const repo = (
    await db
      .select()
      .from(repos)
      .where(and(eq(repos.orgId, orgId), eq(repos.owner, owner), eq(repos.name, name)))
      .limit(1)
  )[0];
  if (!repo) return;
  const client = new FacilityGithubClient(await factory(installationId), {
    owner,
    repo: name,
    defaultBranch: repo.defaultBranch,
  });
  const result = await routeTrigger(db, orgId, client, payload, enqueue);
  if (result.routed) {
    await auditGithub(db, repo.orgId, "github.comment.created", repo, {
      issueNumber: payload.issue?.number,
      runId: result.runId,
    });
  }
}

async function processPullRequest(
  db: FacilityDb,
  orgId: string,
  eventId: string,
  payload: WebhookPayload,
  factory: GithubClientFactory,
  enqueue?: (queue: string, data: Record<string, unknown>) => Promise<unknown>,
) {
  if (payload.action !== "closed") {
    await processGithubAgentEvent(db, orgId, eventId, "pull_request", payload, factory, enqueue);
    return;
  }
  const head = payload.pull_request?.head?.ref ?? "";
  const owner = payload.repository?.owner?.login;
  const name = payload.repository?.name;
  const number = payload.pull_request?.number;
  if (!owner || !name || !number) return;
  const repo = (
    await db
      .select()
      .from(repos)
      .where(and(eq(repos.orgId, orgId), eq(repos.owner, owner), eq(repos.name, name)))
      .limit(1)
  )[0];
  if (!repo) return;
  const producingRun = (
    await db
      .select({ id: runs.id, engine: runs.engine })
      .from(runs)
      .where(
        and(
          eq(runs.orgId, repo.orgId),
          eq(runs.projectId, repo.projectId),
          sql`${runs.gh}->>'branch' = ${head}`,
        ),
      )
      .limit(1)
  )[0];
  const activePreviews = await db
    .select({ id: previewSandboxes.id })
    .from(previewSandboxes)
    .where(
      and(
        eq(previewSandboxes.orgId, orgId),
        eq(previewSandboxes.repoId, repo.id),
        eq(previewSandboxes.prNumber, number),
        inArray(previewSandboxes.status, ["provisioning", "running", "failed"]),
      ),
    );
  for (const preview of activePreviews) {
    await enqueue?.("previews.destroy", { previewId: preview.id });
  }
  // Legacy agent branches carry an explicit lane prefix. Current builders use
  // ordinary semantic branch names, so a linked platform run or preview is the
  // authoritative evidence that this PR belongs to Facility.
  if (!producingRun && activePreviews.length === 0 && !/^(claude|codex|facility)\//.test(head)) {
    return;
  }
  const metrics = await pullRequestMetrics(factory, payload, owner, name, number);
  await db
    .insert(outcomes)
    .values({
      id: newId("evt"),
      orgId: repo.orgId,
      projectId: repo.projectId,
      repo: `${owner}/${name}`,
      prNumber: number,
      agentLane: producingRun?.engine ?? (head.split("/")[0] || "repository"),
      runId: producingRun?.id,
      openedAt: payload.pull_request?.created_at
        ? new Date(payload.pull_request.created_at)
        : new Date(),
      terminalAt: payload.pull_request?.closed_at
        ? new Date(payload.pull_request.closed_at)
        : new Date(),
      fate: payload.pull_request?.merged ? "merged" : "closed",
      accepted: payload.pull_request?.merged ? null : false,
      reviewRounds: metrics.reviewRounds,
      fixupCommits: metrics.fixupCommits,
    })
    .onConflictDoUpdate({
      target: [outcomes.orgId, outcomes.repo, outcomes.prNumber],
      set: {
        terminalAt: payload.pull_request?.closed_at
          ? new Date(payload.pull_request.closed_at)
          : new Date(),
        fate: payload.pull_request?.merged ? "merged" : "closed",
        accepted: payload.pull_request?.merged
          ? sql`case
              when ${outcomes.mergeMethod} is not null and ${outcomes.mergedBy} is not null
                then ${outcomes.accepted}
              else null
            end`
          : false,
        reviewRounds: metrics.reviewRounds,
        fixupCommits: metrics.fixupCommits,
        runId: producingRun?.id,
        updatedAt: new Date(),
      },
    });
}

async function pullRequestMetrics(
  factory: GithubClientFactory,
  payload: WebhookPayload,
  owner: string,
  repo: string,
  pullNumber: number,
) {
  const installationId = payload.installation?.id;
  if (!installationId) return { reviewRounds: 0, fixupCommits: 0 };
  const octokit = await factory(installationId);
  const [reviews, commits] = await Promise.all([
    octokit.rest.pulls
      .listReviews?.({ owner, repo, pull_number: pullNumber })
      .catch(() => ({ data: [] })) ?? Promise.resolve({ data: [] }),
    octokit.rest.pulls
      .listCommits?.({ owner, repo, pull_number: pullNumber })
      .catch(() => ({ data: [] })) ?? Promise.resolve({ data: [] }),
  ]);
  const reviewRounds = reviews.data.length;
  const fixupCommits = commits.data.filter((commit) => {
    const row = commit as { author?: { type?: string } };
    return row.author?.type !== "Bot";
  }).length;
  return { reviewRounds, fixupCommits };
}

async function processWorkflowRun(
  db: FacilityDb,
  orgId: string,
  eventId: string,
  payload: WebhookPayload,
  factory: GithubClientFactory,
  enqueue?: (queue: string, data: Record<string, unknown>) => Promise<unknown>,
) {
  if (payload.action !== "completed" || !payload.workflow_run?.name?.startsWith("facility-"))
    return;
  const owner = payload.repository?.owner?.login;
  const name = payload.repository?.name;
  if (!owner || !name || payload.workflow_run.conclusion !== "failure") return;
  const repo = (
    await db
      .select()
      .from(repos)
      .where(and(eq(repos.orgId, orgId), eq(repos.owner, owner), eq(repos.name, name)))
      .limit(1)
  )[0];
  if (!repo) return;
  // Store as an audit-visible health signal; watchtower escalation is a later worker chunk.
  await auditGithub(db, repo.orgId, "github.workflow.failed", repo, {
    workflow: payload.workflow_run.name,
    url: payload.workflow_run.html_url,
  });
  await processGithubAgentEvent(db, orgId, eventId, "workflow_run", payload, factory, enqueue);
}

type GithubAgentEvent = "pull_request" | "pull_request_review" | "workflow_run";

async function processGithubAgentEvent(
  db: FacilityDb,
  orgId: string,
  eventId: string,
  eventType: GithubAgentEvent,
  payload: WebhookPayload,
  factory: GithubClientFactory,
  enqueue?: (queue: string, data: Record<string, unknown>) => Promise<unknown>,
) {
  const owner = payload.repository?.owner?.login;
  const name = payload.repository?.name;
  const installationId = payload.installation?.id;
  if (!owner || !name || !installationId) return;
  const repo = (
    await db
      .select()
      .from(repos)
      .where(and(eq(repos.orgId, orgId), eq(repos.owner, owner), eq(repos.name, name)))
      .limit(1)
  )[0];
  if (!repo) return;
  const agents = await db
    .select()
    .from(agentDefs)
    .where(
      and(
        eq(agentDefs.orgId, orgId),
        eq(agentDefs.projectId, repo.projectId),
        eq(agentDefs.enabled, true),
      ),
    );
  const agent = agents.find((candidate) =>
    githubEventMatches(candidate.triggers, eventType, payload),
  );
  if (!agent) return;
  // Event-driven repository agents are opt-in just like slash commands. The
  // legacy/default lane is repo, so connecting an existing repository never
  // silently starts a weaker duplicate reviewer or repair agent.
  if (laneFor(repo, agent.name) !== "platform") return;
  const pullRequest = pullRequestContext(eventType, payload);
  const pullNumber = pullRequest.number;
  const branch = pullRequest.head;
  const deliveryContext = branch ? await githubDeliveryContext(db, repo, branch) : null;
  const run = (
    await db
      .insert(runs)
      .values({
        id: newId("run"),
        orgId,
        projectId: repo.projectId,
        agentDefId: agent.id,
        mode: agent.name.replace(/-/g, "_"),
        engine: agent.engine,
        trigger: {
          type: "github_event",
          event: eventType,
          action: payload.action ?? null,
          delivery: eventId,
          repository: { owner, name, defaultBranch: repo.defaultBranch },
          pullRequest,
          review: payload.review ?? null,
          workflowRun: payload.workflow_run ?? null,
          deliveryContext,
        },
        gh: {
          owner,
          repo: name,
          ...(pullNumber ? { issueNumber: pullNumber } : {}),
          ...(branch ? { branch } : {}),
        },
        createdBy: {
          type: "github",
          id: payload.sender?.login ?? `${eventType}-webhook`,
        },
      })
      .returning()
  )[0];
  if (!run) return;
  await db.insert(runEvents).values({
    orgId,
    runId: run.id,
    seq: 1,
    type: "queued",
    data: { queue: "runs.dispatch", source: "github_event", event: eventType },
  });
  if (pullNumber) {
    try {
      const client = new FacilityGithubClient(await factory(installationId), {
        owner,
        repo: name,
        defaultBranch: repo.defaultBranch,
      });
      const progress = await client.createIssueComment(
        pullNumber,
        renderGithubRunProgress({
          runId: run.id,
          mode: run.mode,
          command: agent.name,
          phase: "queued",
          issueNumber: pullNumber,
          issueTitle: pullRequest.title,
          sender: payload.sender?.login,
        }),
      );
      await db
        .update(runs)
        .set({
          gh: {
            ...(run.gh as Record<string, unknown>),
            progressComment: {
              id: progress.id,
              url: progress.url ?? null,
              command: agent.name,
              sender: payload.sender?.login ?? null,
              issueTitle: pullRequest.title ?? null,
            },
          },
          updatedAt: new Date(),
        })
        .where(and(eq(runs.orgId, orgId), eq(runs.id, run.id)));
    } catch (error) {
      await db.insert(runEvents).values({
        orgId,
        runId: run.id,
        seq: 2,
        type: "artifact_error",
        data: {
          kind: "github_progress_comment_failed",
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
  await auditGithub(db, orgId, "github.agent.dispatched", repo, {
    runId: run.id,
    agent: agent.name,
    event: eventType,
    action: payload.action,
  });
  await enqueue?.("runs.dispatch", { runId: run.id, orgId });
}

async function githubDeliveryContext(
  db: FacilityDb,
  repo: typeof repos.$inferSelect,
  branch: string,
) {
  const [producingRun, followUpRuns] = await Promise.all([
    db
      .select({ id: runs.id, trigger: runs.trigger, receipt: runs.receipt })
      .from(runs)
      .where(
        and(
          eq(runs.orgId, repo.orgId),
          eq(runs.projectId, repo.projectId),
          sql`${runs.gh}->>'branch' = ${branch}`,
          // The builder run owns the accepted plan and original request. Newer
          // review/repair runs on the same branch must not erase that lineage.
          sql`${runs.mode} in ('builder', 'codex-builder')`,
        ),
      )
      .orderBy(desc(runs.createdAt))
      .limit(1)
      .then((rows) => rows[0]),
    db
      .select({
        id: runs.id,
        mode: runs.mode,
        trigger: runs.trigger,
        receipt: runs.receipt,
      })
      .from(runs)
      .where(
        and(
          eq(runs.orgId, repo.orgId),
          eq(runs.projectId, repo.projectId),
          eq(runs.status, "succeeded"),
          sql`${runs.gh}->>'branch' = ${branch}`,
          inArray(runs.mode, ["address_review", "address-review", "ci_doctor", "ci-doctor"]),
        ),
      )
      .orderBy(desc(runs.createdAt))
      .limit(10),
  ]);
  if (!producingRun) return null;
  const trigger = objectValue(producingRun.trigger);
  const architectTrigger =
    trigger.source === "plan_acceptance" ? objectValue(trigger.architectTrigger) : trigger;
  const receipt = objectValue(producingRun.receipt);
  const integrity = objectValue(receipt.integrity);
  return {
    producingRunId: producingRun.id,
    originalRequest: objectValue(architectTrigger.request),
    approvedPlan: typeof trigger.approvedPlan === "string" ? trigger.approvedPlan : null,
    receipt: {
      result: typeof receipt.result === "string" ? receipt.result : null,
      checks: Array.isArray(receipt.checks) ? receipt.checks : [],
      payloadSha256: typeof integrity.payload_sha256 === "string" ? integrity.payload_sha256 : null,
    },
    followUpRuns: followUpRuns.map((followUp) => {
      const followUpTrigger = objectValue(followUp.trigger);
      const followUpReceipt = objectValue(followUp.receipt);
      const followUpIntegrity = objectValue(followUpReceipt.integrity);
      return {
        runId: followUp.id,
        mode: followUp.mode,
        review: objectValue(followUpTrigger.review),
        workflowRun: objectValue(followUpTrigger.workflowRun),
        receipt: {
          result: typeof followUpReceipt.result === "string" ? followUpReceipt.result : null,
          checks: Array.isArray(followUpReceipt.checks) ? followUpReceipt.checks : [],
          payloadSha256:
            typeof followUpIntegrity.payload_sha256 === "string"
              ? followUpIntegrity.payload_sha256
              : null,
        },
      };
    }),
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function githubEventMatches(
  triggers: unknown,
  eventType: GithubAgentEvent,
  payload: WebhookPayload,
) {
  if (!Array.isArray(triggers)) return false;
  return triggers.some((raw) => {
    if (!raw || typeof raw !== "object") return false;
    const trigger = raw as { type?: unknown; event?: unknown; action?: unknown };
    if (trigger.type !== "github" || trigger.event !== eventType) return false;
    if (trigger.action === payload.action) return true;
    return (
      eventType === "pull_request" &&
      trigger.action === "ready_for_review" &&
      payload.action === "opened" &&
      payload.pull_request?.draft !== true
    );
  });
}

function pullRequestContext(eventType: GithubAgentEvent, payload: WebhookPayload) {
  if (eventType === "workflow_run") {
    const pull = payload.workflow_run?.pull_requests?.[0];
    return {
      number: pull?.number ?? null,
      title: null,
      body: null,
      url: payload.workflow_run?.html_url ?? null,
      head: pull?.head?.ref ?? payload.workflow_run?.head_branch ?? null,
      headSha: payload.workflow_run?.head_sha ?? null,
      base: pull?.base?.ref ?? null,
    };
  }
  return {
    number: payload.pull_request?.number ?? payload.issue?.number ?? null,
    title: payload.pull_request?.title ?? payload.issue?.title ?? null,
    body: payload.pull_request?.body ?? payload.issue?.body ?? null,
    url: payload.pull_request?.html_url ?? null,
    head: payload.pull_request?.head?.ref ?? null,
    headSha: payload.pull_request?.head?.sha ?? null,
    base: payload.pull_request?.base?.ref ?? null,
  };
}

async function processOperationalSignal(
  db: FacilityDb,
  orgId: string,
  eventType: "deployment_status" | "check_run",
  payload: WebhookPayload,
) {
  const owner = payload.repository?.owner?.login;
  const name = payload.repository?.name;
  if (!owner || !name) return;
  const repo = (
    await db
      .select()
      .from(repos)
      .where(and(eq(repos.orgId, orgId), eq(repos.owner, owner), eq(repos.name, name)))
      .limit(1)
  )[0];
  if (!repo) return;

  if (eventType === "deployment_status") {
    const deployment = payload.deployment_status;
    const environment = deployment?.environment ?? "default";
    await applyFacilitySignal(db, {
      orgId,
      projectId: repo.projectId,
      fallbackFingerprint: `${repo.id}:${environment}`,
      signal: {
        schema: "facility.signal.v1",
        type: "deployment",
        status: githubSignalStatus(deployment?.state),
        source: "github.deployment_status",
        fingerprint: `deployment:${repo.id}:${environment}`,
        title: `Deployment ${environment} ${deployment?.state ?? "unknown"}`,
        bodyMd: deployment?.description ?? `GitHub deployment status for ${owner}/${name}.`,
        url: deployment?.target_url,
      },
    });
    return;
  }

  const check = payload.check_run;
  const checkName = check?.name ?? "unnamed";
  await applyFacilitySignal(db, {
    orgId,
    projectId: repo.projectId,
    fallbackFingerprint: `${repo.id}:${checkName}`,
    signal: {
      schema: "facility.signal.v1",
      type: "check",
      status: githubSignalStatus(check?.conclusion ?? check?.status),
      source: "github.check_run",
      fingerprint: `check:${repo.id}:${checkName}`,
      title: `Check ${checkName} ${check?.conclusion ?? check?.status ?? "unknown"}`,
      bodyMd: `GitHub check signal for ${owner}/${name}.`,
      url: check?.html_url,
    },
  });
}

function githubSignalStatus(
  status: string | null | undefined,
): "failed" | "recovered" | "pending" | "succeeded" {
  const normalized = status?.trim().toLowerCase();
  if (["failure", "failed", "error", "timed_out", "action_required"].includes(normalized ?? "")) {
    return "failed";
  }
  if (["success", "succeeded", "neutral", "skipped"].includes(normalized ?? "")) {
    return "succeeded";
  }
  if (["inactive", "recovered"].includes(normalized ?? "")) return "recovered";
  return "pending";
}

export async function enqueueFingerprintVerify(
  db: FacilityDb,
  config: AppConfig,
  data: { repoId?: string },
  factory: GithubClientFactory = createGithubClientFactory(config),
) {
  if (!data.repoId) return;
  const repo = (await db.select().from(repos).where(eq(repos.id, data.repoId)).limit(1))[0];
  if (!repo) return;
  await verifyFingerprints({ db, factory, repo });
}

export async function enqueueGithubIssuesSync(
  db: FacilityDb,
  config: AppConfig,
  data: { repoId?: string; orgId?: string },
  factory: GithubClientFactory = createGithubClientFactory(config),
) {
  if (!data.repoId || !data.orgId) return;
  const repo = (
    await db
      .select()
      .from(repos)
      .where(and(eq(repos.orgId, data.orgId), eq(repos.id, data.repoId)))
      .limit(1)
  )[0];
  if (!repo) return;
  await syncRepoIssues(db, factory, repo);
}

/**
 * Map a verified webhook to its org. A known installation resolves to its
 * bound org. An UNKNOWN installation is only bound when the deployment has
 * exactly one org (single-tenant self-host — unambiguous); with multiple orgs
 * we refuse rather than bind to an arbitrary tenant (finding #5). Installations
 * become known via the `installation` event, which carries its own org context.
 */
export async function resolveGithubIntegration(
  db: FacilityDb,
  payload: WebhookPayload,
): Promise<{ orgId: string; integrationId: string } | null> {
  const installationId = payload.installation?.id;
  if (installationId) {
    const installation = (
      await db
        .select()
        .from(githubInstallations)
        .where(eq(githubInstallations.installationId, installationId))
        .limit(1)
    )[0];
    if (installation) {
      const integration = await findOrCreateGithubIntegration(db, installation.orgId);
      return { orgId: installation.orgId, integrationId: integration.id };
    }
  }
  // Unknown installation: only safe to bind when there is exactly one org.
  const orgRows = (await db.execute(
    sql`select id from orgs order by created_at asc limit 2` as never,
  )) as unknown as { id: string }[];
  if (orgRows.length !== 1 || !orgRows[0]) return null;
  const integration = await findOrCreateGithubIntegration(db, orgRows[0].id);
  return { orgId: orgRows[0].id, integrationId: integration.id };
}

async function findOrCreateGithubIntegration(db: FacilityDb, orgId: string) {
  const existing = (
    await db
      .select()
      .from(integrations)
      .where(and(eq(integrations.orgId, orgId), eq(integrations.kind, "github_app")))
      .limit(1)
  )[0];
  if (existing) return existing;
  const inserted = (
    await db
      .insert(integrations)
      .values({ id: newId("int"), orgId, kind: "github_app", name: "GitHub App", config: {} })
      .returning()
  )[0];
  if (!inserted) throw new Error("Could not create GitHub integration");
  return inserted;
}

async function auditGithub(
  db: FacilityDb,
  orgId: string,
  action: string,
  repo: typeof repos.$inferSelect,
  payload: Record<string, unknown>,
) {
  await insertAuditEvent(db, {
    orgId,
    projectId: repo.projectId,
    actor: { type: "system", name: "github-app" },
    action,
    target: { type: "repo", id: repo.id },
    payload: { repo: `${repo.owner}/${repo.name}`, ...payload },
  });
}
