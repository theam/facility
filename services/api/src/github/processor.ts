import { createHash } from "node:crypto";
import { newId } from "@facility/core";
import {
  agentDefs,
  auditEvents,
  type FacilityDb,
  ghPullRequests,
  githubInstallations,
  inboundEvents,
  insertAuditEvent,
  integrations,
  outcomes,
  previewSandboxes,
  projects,
  repos,
  runDeliveries,
  runEvents,
  runs,
} from "@facility/db";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  builderPlanDenialCode,
  isBuilderPlanDenialError,
  lockBuilderPlanPolicy,
  withBuilderPlanPreflight,
} from "../builder-plan-policy.js";
import { applyFacilitySignal } from "../integrations/signals.js";
import type { AppConfig } from "../types.js";
import { resolvePlatformIssue } from "../watchtower/issues.js";
import { decideAddressReviewAdmission, isTrustedReviewBot } from "./address-review-policy.js";
import { laneFor } from "./agent-routing.js";
import { type CiDoctorDecision, decideCiDoctorAction } from "./ci-doctor-policy.js";
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
import {
  createGithubClientForRepo,
  syncRepoFacilityConfig,
  verifyFingerprints,
} from "./kickstart.js";
import {
  refreshGhPullRequest,
  refreshPullRequestsForSignal,
  syncRepoPullRequests,
  upsertGhPullRequestFromWebhook,
} from "./pull-requests-sync.js";
import { githubTriggerRequiresClient, routeTrigger, type TriggerPayload } from "./router.js";
import { renderBuilderPlanDenial, renderGithubRunProgress } from "./run-progress.js";

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
    state?: string;
    user?: { login?: string | null; type?: string | null } | null;
    html_url?: string;
    merged?: boolean;
    base?: { ref?: string; repo?: { full_name?: string } | null };
    head?: { ref?: string; sha?: string; repo?: { full_name?: string } | null };
    created_at?: string;
    updated_at?: string;
    closed_at?: string;
    merged_at?: string;
  };
  review?: {
    id?: number;
    body?: string | null;
    state?: string;
    commit_id?: string;
    user?: { login?: string };
  };
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
    head_sha?: string;
    pull_requests?: Array<{ number?: number }>;
    check_suite?: {
      head_branch?: string;
      head_sha?: string;
      pull_requests?: Array<{ number?: number }>;
    };
  };
  check_suite?: {
    status?: string;
    conclusion?: string | null;
    head_branch?: string;
    head_sha?: string;
    pull_requests?: Array<{ number?: number }>;
  };
  sha?: string;
  state?: string;
};

type GithubWebhookLogger = {
  warn: (context: Record<string, unknown>, message: string) => void;
};

type GithubReconciliationWork = {
  key: string;
  eventId: string;
  orgId: string;
  receivedAt: Date;
  payload: WebhookPayload;
  runCiDoctor: boolean;
};

type DeferGithubReconciliation = (work: GithubReconciliationWork) => boolean;

export type GithubWebhookBatchResult = {
  events: number;
  reconciledEvents: number;
  reconciliations: number;
  coalescedEvents: number;
  projectionMs: number;
  reconciliationMs: number;
  maxReconciliationMs: number;
};

const GITHUB_RECONCILIATION_CONCURRENCY = 4;

const fallbackGithubWebhookLogger: GithubWebhookLogger = {
  warn: (context, message) => console.warn(message, context),
};

export async function processGithubWebhook(
  db: FacilityDb,
  config: AppConfig,
  data: { inboundEventId?: string },
  factory?: GithubClientFactory,
  enqueue?: (queue: string, data: Record<string, unknown>) => Promise<unknown>,
  logger: GithubWebhookLogger = fallbackGithubWebhookLogger,
  deferReconciliation?: DeferGithubReconciliation,
) {
  if (!data.inboundEventId) return;
  const event = (
    await db.select().from(inboundEvents).where(eq(inboundEvents.id, data.inboundEventId)).limit(1)
  )[0];
  if (!event || event.processedAt) return;
  const payload = event.payload as WebhookPayload;
  let completionDeferred = false;
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
        event.id,
      );
    } else if (event.eventType === "issue_comment") {
      await bumpGhIssueCommentCount(db, event.orgId, payload);
      await processTrigger(
        db,
        event.orgId,
        factory ?? createGithubClientFactory(config),
        payload,
        enqueue,
        event.id,
      );
    } else if (event.eventType === "pull_request") {
      await upsertGhPullRequestFromWebhook(db, event.orgId, payload);
      await processPullRequest(
        db,
        event.orgId,
        event.id,
        payload,
        factory ?? createGithubClientFactory(config),
        enqueue,
      );
      await refreshPullRequestsBestEffort(
        () =>
          refreshPullRequestFromWebhook(
            db,
            event.orgId,
            payload,
            factory ?? createGithubClientFactory(config),
            { sourceEventId: event.id, observedAt: event.receivedAt },
          ),
        logger,
        pullRequestRefreshContext(event.id, event.orgId, event.eventType, payload),
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
        undefined,
        config.githubAppSlug,
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
      if (isTerminalPullRequestSignal(event.eventType, payload)) {
        completionDeferred =
          deferReconciliation?.(githubReconciliationWork(event, payload, false)) ?? false;
        if (!completionDeferred) {
          await refreshPullRequestsBestEffort(
            () =>
              refreshPullRequestsAndPromoteReady(
                db,
                event.orgId,
                payload,
                factory ?? createGithubClientFactory(config),
                { sourceEventId: event.id, observedAt: event.receivedAt },
              ),
            logger,
            pullRequestRefreshContext(event.id, event.orgId, event.eventType, payload),
          );
        }
      }
    } else if (event.eventType === "check_run" || event.eventType === "check_suite") {
      if (event.eventType === "check_run") {
        await processOperationalSignal(db, event.orgId, "check_run", payload);
      }
      completionDeferred =
        deferReconciliation?.(
          githubReconciliationWork(
            event,
            payload,
            event.eventType === "check_run" &&
              isTerminalPullRequestSignal(event.eventType, payload),
          ),
        ) ?? false;
      if (!completionDeferred) {
        if (event.eventType === "check_run") {
          await processCiDoctorCheckRun(
            db,
            event.orgId,
            event.id,
            payload,
            factory ?? createGithubClientFactory(config),
            enqueue,
          );
        }
        await refreshPullRequestsBestEffort(
          () =>
            refreshPullRequestsAndPromoteReady(
              db,
              event.orgId,
              payload,
              factory ?? createGithubClientFactory(config),
              { sourceEventId: event.id, observedAt: event.receivedAt },
            ),
          logger,
          pullRequestRefreshContext(event.id, event.orgId, event.eventType, payload),
        );
      }
    } else if (event.eventType === "status") {
      if (isPullRequestStatusSignal(payload)) {
        completionDeferred =
          deferReconciliation?.(githubReconciliationWork(event, payload, false)) ?? false;
        if (!completionDeferred) {
          await refreshPullRequestsBestEffort(
            () =>
              refreshPullRequestsAndPromoteReady(
                db,
                event.orgId,
                payload,
                factory ?? createGithubClientFactory(config),
                { sourceEventId: event.id, observedAt: event.receivedAt },
              ),
            logger,
            pullRequestRefreshContext(event.id, event.orgId, event.eventType, payload),
          );
        }
      }
    } else if (event.eventType === "deployment_status") {
      await processOperationalSignal(db, event.orgId, "deployment_status", payload);
    }
    if (!completionDeferred) {
      await db
        .update(inboundEvents)
        .set({ processedAt: new Date(), error: null })
        .where(eq(inboundEvents.id, event.id));
    }
  } catch (error) {
    await db
      .update(inboundEvents)
      .set({ error: error instanceof Error ? error.message : "unknown error" })
      .where(eq(inboundEvents.id, event.id));
    throw error;
  }
}

export async function processGithubWebhookBatch(
  db: FacilityDb,
  config: AppConfig,
  deliveries: Array<{ inboundEventId?: string }>,
  factory?: GithubClientFactory,
  enqueue?: (queue: string, data: Record<string, unknown>) => Promise<unknown>,
  logger: GithubWebhookLogger = fallbackGithubWebhookLogger,
): Promise<GithubWebhookBatchResult> {
  const startedAt = Date.now();
  const reconciliations = new Map<
    string,
    {
      eventIds: Set<string>;
      latest: GithubReconciliationWork;
      ciDoctor?: GithubReconciliationWork;
    }
  >();

  for (const delivery of deliveries) {
    await processGithubWebhook(db, config, delivery, factory, enqueue, logger, (work) => {
      const current = reconciliations.get(work.key);
      if (!current) {
        reconciliations.set(work.key, {
          eventIds: new Set([work.eventId]),
          latest: work,
          ...(work.runCiDoctor ? { ciDoctor: work } : {}),
        });
        return true;
      }
      current.eventIds.add(work.eventId);
      if (isLaterGithubWork(work, current.latest)) current.latest = work;
      if (work.runCiDoctor && (!current.ciDoctor || isLaterGithubWork(work, current.ciDoctor))) {
        current.ciDoctor = work;
      }
      return true;
    });
  }

  const projectionMs = Date.now() - startedAt;
  const groups = [...reconciliations.values()];
  const errors: unknown[] = [];
  const reconciliationDurations: number[] = [];
  const reconciliationStartedAt = Date.now();
  await runWithConcurrency(groups, GITHUB_RECONCILIATION_CONCURRENCY, async (group) => {
    const groupStartedAt = Date.now();
    try {
      if (group.ciDoctor) {
        await processCiDoctorCheckRun(
          db,
          group.ciDoctor.orgId,
          group.ciDoctor.eventId,
          group.ciDoctor.payload,
          factory ?? createGithubClientFactory(config),
          enqueue,
        );
      }
      await refreshPullRequestsBestEffort(
        () =>
          refreshPullRequestsAndPromoteReady(
            db,
            group.latest.orgId,
            group.latest.payload,
            factory ?? createGithubClientFactory(config),
            {
              sourceEventId: group.latest.eventId,
              observedAt: group.latest.receivedAt,
            },
          ),
        logger,
        pullRequestRefreshContext(
          group.latest.eventId,
          group.latest.orgId,
          "github.reconciliation",
          group.latest.payload,
        ),
      );
      await db
        .update(inboundEvents)
        .set({ processedAt: new Date(), error: null })
        .where(inArray(inboundEvents.id, [...group.eventIds]));
    } catch (error) {
      await db
        .update(inboundEvents)
        .set({ error: error instanceof Error ? error.message : "unknown error" })
        .where(inArray(inboundEvents.id, [...group.eventIds]));
      errors.push(error);
    } finally {
      reconciliationDurations.push(Date.now() - groupStartedAt);
    }
  });
  if (errors.length) throw new AggregateError(errors, "GitHub webhook reconciliation batch failed");

  const reconciledEvents = groups.reduce((count, group) => count + group.eventIds.size, 0);
  return {
    events: deliveries.length,
    reconciledEvents,
    reconciliations: groups.length,
    coalescedEvents: Math.max(0, reconciledEvents - groups.length),
    projectionMs,
    reconciliationMs: Date.now() - reconciliationStartedAt,
    maxReconciliationMs: Math.max(0, ...reconciliationDurations),
  };
}

async function refreshPullRequestsBestEffort(
  refresh: () => Promise<unknown>,
  logger: GithubWebhookLogger,
  context: Record<string, unknown>,
) {
  try {
    await refresh();
  } catch (error) {
    logger.warn(
      { ...context, error: error instanceof Error ? error.message : String(error) },
      "GitHub pull-request snapshot refresh failed; scheduled reconciliation will retry",
    );
  }
}

function isTerminalPullRequestSignal(eventType: string, payload: WebhookPayload) {
  if (eventType === "workflow_run") return payload.action === "completed";
  if (eventType === "check_run") {
    return payload.action === "completed" || payload.check_run?.status === "completed";
  }
  if (eventType === "check_suite") {
    return payload.action === "completed" || payload.check_suite?.status === "completed";
  }
  if (eventType === "status") {
    return ["success", "failure", "error"].includes(payload.state?.toLowerCase() ?? "");
  }
  return false;
}

function githubReconciliationWork(
  event: { id: string; orgId: string; receivedAt: Date },
  payload: WebhookPayload,
  runCiDoctor: boolean,
): GithubReconciliationWork {
  const check = payload.check_run;
  const headSha =
    check?.head_sha ??
    check?.check_suite?.head_sha ??
    payload.check_suite?.head_sha ??
    payload.workflow_run?.head_sha ??
    payload.sha;
  const pullNumbers = [
    ...(check?.pull_requests ?? []),
    ...(check?.check_suite?.pull_requests ?? []),
    ...(payload.check_suite?.pull_requests ?? []),
    ...(payload.workflow_run?.pull_requests ?? []),
  ]
    .flatMap((pull) => (typeof pull.number === "number" ? [pull.number] : []))
    .sort((left, right) => left - right);
  const repository = `${payload.repository?.owner?.login ?? "unknown"}/${payload.repository?.name ?? "unknown"}`;
  const target = headSha ?? (pullNumbers.length ? `pulls:${pullNumbers.join(",")}` : event.id);
  return {
    key: `${event.orgId}:${repository}:${target}`,
    eventId: event.id,
    orgId: event.orgId,
    receivedAt: event.receivedAt,
    payload,
    runCiDoctor,
  };
}

function isLaterGithubWork(candidate: GithubReconciliationWork, current: GithubReconciliationWork) {
  const timeDifference = candidate.receivedAt.getTime() - current.receivedAt.getTime();
  return timeDifference > 0 || (timeDifference === 0 && candidate.eventId > current.eventId);
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next];
        next += 1;
        if (item !== undefined) await task(item);
      }
    }),
  );
}

function isPullRequestStatusSignal(payload: WebhookPayload) {
  return ["pending", "success", "failure", "error"].includes(payload.state?.toLowerCase() ?? "");
}

function pullRequestRefreshContext(
  inboundEventId: string,
  orgId: string,
  eventType: string,
  payload: WebhookPayload,
) {
  const check = payload.check_run;
  const pullRequestNumbers = [
    payload.pull_request,
    ...(check?.pull_requests ?? []),
    ...(check?.check_suite?.pull_requests ?? []),
    ...(payload.check_suite?.pull_requests ?? []),
    ...(payload.workflow_run?.pull_requests ?? []),
  ]
    .map((pull) => pull?.number)
    .filter((number): number is number => typeof number === "number");
  return {
    inboundEventId,
    orgId,
    eventType,
    action: payload.action ?? null,
    owner: payload.repository?.owner?.login ?? null,
    repo: payload.repository?.name ?? null,
    pullRequestNumbers: [...new Set(pullRequestNumbers)],
    headSha:
      payload.pull_request?.head?.sha ??
      check?.head_sha ??
      check?.check_suite?.head_sha ??
      payload.check_suite?.head_sha ??
      payload.workflow_run?.head_sha ??
      payload.sha ??
      null,
  };
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
    const affected = await db
      .select({ orgId: repos.orgId, projectId: repos.projectId })
      .from(repos)
      .where(eq(repos.installationId, row.id));
    for (const project of uniqueProjects(affected)) {
      await db.transaction(async (transaction) => {
        const tx = transaction as unknown as FacilityDb;
        await lockBuilderPlanPolicy(tx, project.orgId, project.projectId);
        await tx
          .update(repos)
          .set({
            fingerprintStatus: "orphaned",
            fingerprintVerifiedAt: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(repos.orgId, project.orgId),
              eq(repos.projectId, project.projectId),
              eq(repos.installationId, row.id),
            ),
          );
      });
    }
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
    const targets = await db
      .select({ id: repos.id, orgId: repos.orgId, projectId: repos.projectId })
      .from(repos)
      .where(and(eq(repos.orgId, orgId), eq(repos.owner, item.owner), eq(repos.name, item.name)));
    const updated = [];
    for (const target of targets) {
      const rows = await db.transaction(async (transaction) => {
        const tx = transaction as unknown as FacilityDb;
        await lockBuilderPlanPolicy(tx, target.orgId, target.projectId);
        return tx
          .update(repos)
          .set({
            installationId: row.id,
            defaultBranch: item.defaultBranch ?? sql`${repos.defaultBranch}`,
            fingerprintStatus: "pending",
            fingerprintVerifiedAt: null,
            updatedAt: new Date(),
          })
          .where(and(eq(repos.orgId, target.orgId), eq(repos.id, target.id)))
          .returning();
      });
      updated.push(...rows);
    }
    for (const repo of updated) {
      await enqueue?.("github.issues-sync", { repoId: repo.id, orgId: repo.orgId });
      await enqueue?.("fingerprints.verify", { repoId: repo.id });
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
    // Close the asynchronous verification window immediately. Approval and
    // dispatch refuse a non-ok fingerprint, so a managed default-branch push
    // cannot keep using the previous verified state while the worker is still
    // queued. syncRepoFacilityConfig above marks malformed/unsafe required
    // manifests drifted before it throws.
    await db.transaction(async (transaction) => {
      const tx = transaction as unknown as FacilityDb;
      await lockBuilderPlanPolicy(tx, repo.orgId, repo.projectId);
      await tx
        .update(repos)
        .set({ fingerprintStatus: "pending", fingerprintVerifiedAt: null, updatedAt: new Date() })
        .where(and(eq(repos.orgId, repo.orgId), eq(repos.id, repo.id)));
    });
    await enqueue?.("fingerprints.verify", { repoId: repo.id });
  }
}

function uniqueProjects(rows: Array<{ orgId: string; projectId: string }>) {
  return [...new Map(rows.map((row) => [`${row.orgId}:${row.projectId}`, row])).values()];
}

async function processTrigger(
  db: FacilityDb,
  orgId: string,
  factory: GithubClientFactory,
  payload: WebhookPayload,
  enqueue?: (queue: string, data: Record<string, unknown>) => Promise<unknown>,
  githubDeliveryId?: string,
) {
  if (!githubTriggerRequiresClient(payload)) return;
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
  const result = await routeTrigger(db, orgId, client, payload, enqueue, githubDeliveryId);
  if (result.routed && result.reason !== "delivery_replayed") {
    await auditGithub(db, repo.orgId, "github.comment.created", repo, {
      issueNumber: payload.issue?.number,
      runId: result.runId,
    });
  } else {
    const denialCode = builderPlanDenialCode(result.reason);
    const issueNumber = payload.issue?.number;
    if (denialCode && issueNumber) {
      try {
        await client.createIssueComment(issueNumber, renderBuilderPlanDenial(denialCode));
      } catch (error) {
        await auditGithub(db, repo.orgId, "github.comment.failed", repo, {
          issueNumber,
          kind: "builder_plan_denial",
          code: denialCode,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
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
  if (payload.action !== "completed") return;
  await processGithubAgentEvent(db, orgId, eventId, "workflow_run", payload, factory, enqueue);
}

async function processCiDoctorCheckRun(
  db: FacilityDb,
  orgId: string,
  eventId: string,
  payload: WebhookPayload,
  factory: GithubClientFactory,
  enqueue?: (queue: string, data: Record<string, unknown>) => Promise<unknown>,
) {
  const check = payload.check_run;
  const branch = check?.check_suite?.head_branch;
  const headSha = check?.head_sha ?? check?.check_suite?.head_sha;
  if ((payload.action !== "completed" && check?.status !== "completed") || !branch || !headSha) {
    return;
  }
  const pullRequests = [
    ...(check.pull_requests ?? []),
    ...(check.check_suite?.pull_requests ?? []),
  ];
  await processGithubAgentEvent(
    db,
    orgId,
    eventId,
    "workflow_run",
    {
      ...payload,
      action: "completed",
      workflow_run: {
        id: check.id,
        name: check.name,
        conclusion: check.conclusion ?? undefined,
        html_url: check.html_url,
        head_branch: branch,
        head_sha: headSha,
        pull_requests: pullRequests.map((pull) => ({
          number: pull.number,
          head: { ref: branch },
        })),
      },
    },
    factory,
    enqueue,
    "ci-doctor",
  );
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
  preferredAgentName?: string,
  githubAppSlug?: string,
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
  const agent = agents.find(
    (candidate) =>
      (!preferredAgentName || candidate.name === preferredAgentName) &&
      githubEventMatches(candidate.triggers, eventType, payload),
  );
  if (!agent) return;
  // Event-driven repository agents are opt-in just like slash commands. The
  // legacy/default lane is repo, so connecting an existing repository never
  // silently starts a weaker duplicate reviewer or repair agent.
  if (laneFor(repo, agent.name) !== "platform") return;
  let pullRequest = pullRequestContext(eventType, payload);
  const workflowBranch = pullRequest.head;
  if (eventType === "workflow_run" && workflowBranch && !pullRequest.number) {
    const mirrored = (
      await db
        .select()
        .from(ghPullRequests)
        .where(
          and(
            eq(ghPullRequests.repoId, repo.id),
            eq(ghPullRequests.state, "open"),
            eq(ghPullRequests.headRef, workflowBranch),
          ),
        )
        .orderBy(desc(ghPullRequests.updatedAt))
        .limit(1)
    )[0];
    if (mirrored) {
      pullRequest = {
        number: mirrored.number,
        title: mirrored.title,
        body: mirrored.bodyMd,
        url: mirrored.htmlUrl,
        head: mirrored.headRef,
        headSha: payload.workflow_run?.head_sha ?? mirrored.headSha,
        base: mirrored.baseRef,
      };
    }
  }
  const pullNumber = pullRequest.number;
  const branch = pullRequest.head;
  let deliveryContext = branch ? await githubDeliveryContext(db, repo, branch) : null;
  let reviewContext: unknown = payload.review ?? null;
  let ciDoctorContext: Record<string, unknown> | null = null;
  const isCiDoctor = agent.name.replace(/-/g, "_") === "ci_doctor";
  const isAddressReview = agent.name.replace(/-/g, "_") === "address_review";
  if (eventType === "pull_request_review" && isAddressReview) {
    const reviewer = payload.review?.user?.login;
    const sender = payload.sender?.login;
    if (!pullNumber) return;
    const client = new FacilityGithubClient(await factory(installationId), {
      owner,
      repo: name,
      defaultBranch: repo.defaultBranch,
    });
    const reviewId = payload.review?.id;
    if (!reviewId) return;
    const [livePullRequest, liveReview] = await Promise.all([
      client.getAddressReviewPullRequest(pullNumber),
      client.getAddressReviewSubmittedReview(pullNumber, reviewId),
    ]);
    const delivery = await addressReviewDeliveryLineage(db, repo, {
      pullNumber: livePullRequest.number,
      headBranch: livePullRequest.head.ref,
      headSha: livePullRequest.head.sha,
    });
    const installationMatches = await repoInstallationMatches(db, repo, installationId);
    const reviewerCanWrite = liveReview.author
      ? isTrustedReviewBot(liveReview.author) || (await client.userCanWrite(liveReview.author))
      : false;
    const admission = decideAddressReviewAdmission({
      repository: `${owner}/${name}`,
      defaultBranch: repo.defaultBranch,
      facilityAppSlug: githubAppSlug,
      event: {
        pullNumber,
        headRef: branch,
        headSha: pullRequest.headSha,
        reviewId: payload.review?.id,
        reviewState: payload.review?.state,
        reviewCommitSha: payload.review?.commit_id,
        reviewer,
        sender,
      },
      pullRequest: livePullRequest,
      review: liveReview,
      reviewerCanWrite,
      installationMatches,
      facilityDelivered: Boolean(delivery),
      deliveryBaseBranch: delivery?.baseBranch,
      headShaAuthorized: delivery?.headShaAuthorized ?? false,
    });
    if (!admission.admitted) {
      await auditGithub(db, orgId, "github.review_repair.denied", repo, {
        pullNumber,
        reason: admission.reason,
      });
      return;
    }
    pullRequest = {
      number: livePullRequest.number,
      title: payload.pull_request?.title ?? null,
      body: payload.pull_request?.body ?? null,
      url: livePullRequest.url,
      head: livePullRequest.head.ref,
      headSha: livePullRequest.head.sha,
      base: livePullRequest.base.ref,
    };
    deliveryContext = await githubDeliveryContext(db, repo, livePullRequest.head.ref);
    reviewContext = liveReview;
  } else if (eventType === "workflow_run" && !isCiDoctor) {
    // Generic workflow agents retain their old failure-only behavior and never
    // inherit CI-doctor's privileged deterministic repair semantics.
    if (payload.workflow_run?.conclusion !== "failure") return;
  } else if (eventType === "workflow_run") {
    if (!pullNumber || !branch || !pullRequest.headSha || !deliveryContext) return;
    const client = new FacilityGithubClient(await factory(installationId), {
      owner,
      repo: name,
      defaultBranch: repo.defaultBranch,
    });
    // GitHub is the freshness boundary. Missing, malformed, or rate-limited
    // evidence throws so pg-boss retries the inbound event; it never admits a
    // repair from the stale mirror or from one workflow's partial failure view.
    const evidence = await client.getCiDoctorEvidence(pullNumber, pullRequest.headSha);
    const preliminary = decideCiDoctorAction({
      eventHeadSha: pullRequest.headSha,
      eventBranch: branch,
      pullRequest: evidence.pullRequest,
      checks: evidence.checks,
      doctorRunIds: evidence.doctorRunIds,
      attemptsForFingerprint: 0,
      attemptsOnBranch: 0,
      attemptedAtHead: false,
      triageSeen: false,
      maxAttemptsForFingerprint: Number.MAX_SAFE_INTEGER,
      maxAttemptsOnBranch: Number.MAX_SAFE_INTEGER,
    });
    if (preliminary.action === "none") return;
    const history = await ciDoctorHistory(
      db,
      repo,
      branch,
      pullRequest.headSha,
      preliminary.failure.fingerprint,
    );
    const decision = decideCiDoctorAction({
      eventHeadSha: pullRequest.headSha,
      eventBranch: branch,
      pullRequest: evidence.pullRequest,
      checks: evidence.checks,
      doctorRunIds: evidence.doctorRunIds,
      ...history,
    });
    if (decision.action === "triage") {
      await client.createIssueComment(pullNumber, renderCiDoctorTriage(decision));
      await auditGithub(db, orgId, "github.ci_repair.triaged", repo, {
        pullNumber,
        branch,
        headSha: pullRequest.headSha,
        fingerprint: decision.failure.fingerprint,
        category: decision.failure.category,
        reason: decision.reason,
      });
      return;
    }
    if (decision.action === "none") {
      if (!["fingerprint_limit", "branch_limit"].includes(decision.code)) return;
      const fingerprint = preliminary.failure.fingerprint;
      if (
        await ciRepairNoticeReported(db, repo, "github.ci_repair.exhausted", branch, fingerprint)
      ) {
        return;
      }
      const limit =
        decision.code === "fingerprint_limit"
          ? `${history.maxAttemptsForFingerprint} attempts for this failure`
          : `${history.maxAttemptsOnBranch} attempts on this branch`;
      await client.createIssueComment(
        pullNumber,
        `Facility stopped automatic CI repair after ${limit}. The draft PR and failing GitHub checks remain available for human iteration.`,
      );
      await auditGithub(db, orgId, "github.ci_repair.exhausted", repo, {
        pullNumber,
        branch,
        headSha: pullRequest.headSha,
        fingerprint,
        attemptsForFingerprint: history.attemptsForFingerprint,
        attemptsOnBranch: history.attemptsOnBranch,
        maxAttemptsForFingerprint: history.maxAttemptsForFingerprint,
        maxAttemptsOnBranch: history.maxAttemptsOnBranch,
      });
      return;
    }
    pullRequest = {
      number: evidence.pullRequest.number,
      title: null,
      body: null,
      url: evidence.pullRequest.url,
      head: evidence.pullRequest.head.ref,
      headSha: evidence.pullRequest.head.sha,
      base: evidence.pullRequest.base.ref,
    };
    ciDoctorContext = {
      schema: "facility.doctor.context.v2",
      failure: decision.failure,
      fingerprint: decision.failure.fingerprint,
      admittedHeadSha: evidence.pullRequest.head.sha,
      attempt: decision.attemptsForFingerprint + 1,
      attemptsOnBranch: decision.attemptsOnBranch,
      maxAttempts: history.maxAttemptsForFingerprint,
      maxAttemptsOnBranch: history.maxAttemptsOnBranch,
    };
  }
  const values = {
    id: newId("run"),
    orgId,
    projectId: repo.projectId,
    agentDefId: agent.id,
    githubDeliveryId: eventId,
    ...(ciDoctorContext
      ? {
          ciRepairKey: ciRepairAdmissionKey(repo.id, branch ?? "", pullRequest.headSha ?? ""),
        }
      : {}),
    mode: agent.name.replace(/-/g, "_"),
    engine: agent.engine,
    trigger: {
      type: "github_event",
      event: eventType,
      action: payload.action ?? null,
      delivery: eventId,
      repository: { owner, name, defaultBranch: repo.defaultBranch },
      pullRequest,
      review: reviewContext,
      workflowRun: sanitizedWorkflowRun(payload.workflow_run),
      ...(ciDoctorContext ? { ciDoctor: ciDoctorContext } : {}),
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
  };
  let inserted: (typeof runs.$inferSelect)[];
  try {
    inserted = await withBuilderPlanPreflight(
      db,
      {
        orgId,
        projectId: repo.projectId,
        mode: values.mode,
        agentDefId: agent.id,
        trigger: values.trigger,
        gh: values.gh,
        actor: { type: "user", id: `github:${payload.sender?.login ?? `${eventType}-webhook`}` },
        source: `github_event:${eventType}`,
      },
      (tx, admission) =>
        tx
          // builder-plan-preflight: github_event
          .insert(runs)
          .values({ ...values, mode: admission.mode })
          .onConflictDoNothing()
          .returning(),
    );
  } catch (error) {
    if (isBuilderPlanDenialError(error)) {
      return;
    }
    throw error;
  }
  const run = inserted[0];
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

async function repoInstallationMatches(
  db: FacilityDb,
  repo: typeof repos.$inferSelect,
  installationId: number,
) {
  if (!repo.installationId) return false;
  const installation = (
    await db
      .select({ id: githubInstallations.id })
      .from(githubInstallations)
      .where(
        and(
          eq(githubInstallations.id, repo.installationId),
          eq(githubInstallations.orgId, repo.orgId),
          eq(githubInstallations.installationId, installationId),
        ),
      )
      .limit(1)
  )[0];
  return Boolean(installation);
}

async function addressReviewDeliveryLineage(
  db: FacilityDb,
  repo: typeof repos.$inferSelect,
  input: { pullNumber: number; headBranch: string; headSha: string },
) {
  const delivery = (
    await db
      .select({
        runId: runDeliveries.runId,
        baseBranch: runDeliveries.baseBranch,
        expectedHeadSha: runDeliveries.expectedHeadSha,
      })
      .from(runDeliveries)
      .innerJoin(
        runs,
        and(
          eq(runs.id, runDeliveries.runId),
          eq(runs.orgId, runDeliveries.orgId),
          eq(runs.projectId, runDeliveries.projectId),
          eq(runs.status, "succeeded"),
          inArray(runs.mode, ["builder", "codex_builder", "codex-builder"]),
        ),
      )
      .where(
        and(
          eq(runDeliveries.orgId, repo.orgId),
          eq(runDeliveries.projectId, repo.projectId),
          eq(runDeliveries.repoId, repo.id),
          eq(runDeliveries.owner, repo.owner),
          eq(runDeliveries.repoName, repo.name),
          eq(runDeliveries.status, "delivered"),
          eq(runDeliveries.prNumber, input.pullNumber),
          eq(runDeliveries.headBranch, input.headBranch),
        ),
      )
      .limit(1)
  )[0];
  if (!delivery) return null;
  if (delivery.expectedHeadSha === input.headSha) {
    return { ...delivery, headShaAuthorized: true };
  }
  const repair = (
    await db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.orgId, repo.orgId),
          eq(runs.projectId, repo.projectId),
          eq(runs.status, "succeeded"),
          inArray(runs.mode, ["address_review", "address-review", "ci_doctor", "ci-doctor"]),
          sql`${runs.gh}->>'owner' = ${repo.owner}`,
          sql`${runs.gh}->>'repo' = ${repo.name}`,
          sql`${runs.gh}->>'branch' = ${input.headBranch}`,
          sql`${runs.gh}->>'headSha' = ${input.headSha}`,
          sql`${runs.trigger}#>>'{deliveryContext,producingRunId}' = ${delivery.runId}`,
        ),
      )
      .limit(1)
  )[0];
  return { ...delivery, headShaAuthorized: Boolean(repair) };
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
          sql`${runs.gh}->>'owner' = ${repo.owner}`,
          sql`${runs.gh}->>'repo' = ${repo.name}`,
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
          sql`${runs.gh}->>'owner' = ${repo.owner}`,
          sql`${runs.gh}->>'repo' = ${repo.name}`,
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
        // Historical CI-doctor runs may predate deterministic admission and
        // contain downloaded job log tails. Never rehydrate those raw logs
        // into a new model scope.
        workflowRun: sanitizedStoredWorkflowRun(followUpTrigger.workflowRun),
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

async function ciDoctorHistory(
  db: FacilityDb,
  repo: typeof repos.$inferSelect,
  branch: string,
  headSha: string,
  fingerprint: string,
) {
  const project = (
    await db
      .select({ settings: projects.settings })
      .from(projects)
      .where(and(eq(projects.orgId, repo.orgId), eq(projects.id, repo.projectId)))
      .limit(1)
  )[0];
  const configured = objectValue(project?.settings).ci_repair_max_attempts;
  const maxAttemptsOnBranch =
    typeof configured === "number" && Number.isInteger(configured) && configured >= 1
      ? Math.min(configured, 10)
      : 3;
  const repairRuns = await db
    .select({ trigger: runs.trigger })
    .from(runs)
    .where(
      and(
        eq(runs.orgId, repo.orgId),
        eq(runs.projectId, repo.projectId),
        sql`${runs.gh}->>'owner' = ${repo.owner}`,
        sql`${runs.gh}->>'repo' = ${repo.name}`,
        sql`${runs.gh}->>'branch' = ${branch}`,
        inArray(runs.mode, ["ci_doctor", "ci-doctor"]),
        sql`${runs.trigger}->>'event' = 'workflow_run'`,
      ),
    );
  const attemptedAtHead = repairRuns.some(
    (run) => objectValue(objectValue(run.trigger).pullRequest).headSha === headSha,
  );
  const attemptsForFingerprint = repairRuns.filter(
    (run) => objectValue(objectValue(run.trigger).ciDoctor).fingerprint === fingerprint,
  ).length;
  return {
    attemptsForFingerprint,
    attemptsOnBranch: repairRuns.length,
    attemptedAtHead,
    triageSeen: await ciRepairNoticeReported(
      db,
      repo,
      "github.ci_repair.triaged",
      branch,
      fingerprint,
    ),
    maxAttemptsForFingerprint: Math.min(2, maxAttemptsOnBranch),
    maxAttemptsOnBranch,
  };
}

function ciRepairAdmissionKey(repoId: string, branch: string, headSha: string) {
  return createHash("sha256")
    .update("facility/ci-repair-admission/v1")
    .update("\0")
    .update(repoId)
    .update("\0")
    .update(branch)
    .update("\0")
    .update(headSha)
    .digest("hex");
}

async function ciRepairNoticeReported(
  db: FacilityDb,
  repo: typeof repos.$inferSelect,
  action: "github.ci_repair.exhausted" | "github.ci_repair.triaged",
  branch: string,
  fingerprint: string,
) {
  const reported = (
    await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.orgId, repo.orgId),
          eq(auditEvents.projectId, repo.projectId),
          eq(auditEvents.action, action),
          sql`${auditEvents.target}->>'id' = ${repo.id}`,
          sql`${auditEvents.payload}->>'branch' = ${branch}`,
          sql`${auditEvents.payload}->>'fingerprint' = ${fingerprint}`,
        ),
      )
      .limit(1)
  )[0];
  return Boolean(reported);
}

function renderCiDoctorTriage(decision: Extract<CiDoctorDecision, { action: "triage" }>) {
  return [
    "### Facility CI Doctor triage",
    "",
    `- Failing check: ${decision.failure.check}`,
    `- Category: ${decision.failure.category.replaceAll("_", " ")}`,
    `- Reason: ${decision.reason}.`,
    "",
    "A human must review this failure; no repair agent was started.",
  ].join("\n");
}

function sanitizedWorkflowRun(workflowRun: WebhookPayload["workflow_run"]) {
  return sanitizedStoredWorkflowRun(workflowRun);
}

function sanitizedStoredWorkflowRun(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const workflowRun = value as Record<string, unknown>;
  return {
    id: typeof workflowRun.id === "number" ? workflowRun.id : null,
    name: String(workflowRun.name ?? "unknown")
      .replace(/[\r\n\t]+/g, " ")
      .slice(0, 160),
    conclusion: typeof workflowRun.conclusion === "string" ? workflowRun.conclusion : null,
    url:
      typeof workflowRun.html_url === "string"
        ? workflowRun.html_url
        : typeof workflowRun.url === "string"
          ? workflowRun.url
          : null,
    headBranch:
      typeof workflowRun.head_branch === "string"
        ? workflowRun.head_branch
        : typeof workflowRun.headBranch === "string"
          ? workflowRun.headBranch
          : null,
    headSha:
      typeof workflowRun.head_sha === "string"
        ? workflowRun.head_sha
        : typeof workflowRun.headSha === "string"
          ? workflowRun.headSha
          : null,
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
      ["opened", "reopened", "synchronize"].includes(payload.action ?? "") &&
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
  const status = githubSignalStatus(check?.conclusion ?? check?.status);
  const branch = check?.check_suite?.head_branch;
  // Resolve branchless incidents created before scoped fingerprints shipped
  // only when the default branch is demonstrably healthy. A PR-branch result
  // cannot prove which legacy lifecycle raised the incident.
  if (branch === repo.defaultBranch && (status === "succeeded" || status === "recovered")) {
    await resolvePlatformIssue(
      db,
      orgId,
      `check:${repo.id}:${checkName}`,
      branch ? `check signal now tracked on ${branch}` : "check signal now branch-scoped",
      { projectId: repo.projectId },
    );
  }
  // PR checks are story state, and non-default branch checks are neither a
  // production incident nor a default-branch lifecycle condition.
  if (!branch || branch !== repo.defaultBranch) return;
  await applyFacilitySignal(db, {
    orgId,
    projectId: repo.projectId,
    fallbackFingerprint: `${repo.id}:${branch}:${checkName}`,
    signal: {
      schema: "facility.signal.v1",
      type: "check",
      status,
      source: "github.check_run",
      fingerprint: `check:${repo.id}:${branch}:${checkName}`,
      title: `Check ${checkName} on ${branch} ${check?.conclusion ?? check?.status ?? "unknown"}`,
      bodyMd: `GitHub check signal for ${owner}/${name} on ${branch}.`,
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
  factory?: GithubClientFactory,
  enqueue?: (queue: string, data: Record<string, unknown>) => Promise<unknown>,
) {
  if (!data.repoId && !data.orgId) {
    const installedRepos = await db
      .select({ id: repos.id, orgId: repos.orgId })
      .from(repos)
      .where(isNotNull(repos.installationId));
    for (const repo of installedRepos) {
      await enqueue?.("github.issues-sync", { repoId: repo.id, orgId: repo.orgId });
    }
    return { reposScheduled: enqueue ? installedRepos.length : 0 };
  }
  if (!data.repoId || !data.orgId) return;
  const repo = (
    await db
      .select()
      .from(repos)
      .where(and(eq(repos.orgId, data.orgId), eq(repos.id, data.repoId)))
      .limit(1)
  )[0];
  if (!repo) return;
  const resolvedFactory = factory ?? createGithubClientFactory(config);
  const issues = await syncRepoIssues(db, resolvedFactory, repo);
  const pullRequests = await syncRepoPullRequests(db, resolvedFactory, repo);
  if (issues.incomplete || pullRequests.incomplete) {
    await enqueue?.("github.issues-sync", { repoId: repo.id, orgId: repo.orgId });
  }
  return { issues, pullRequests };
}

async function refreshPullRequestFromWebhook(
  db: FacilityDb,
  orgId: string,
  payload: WebhookPayload,
  factory: GithubClientFactory,
  observation: { sourceEventId: string; observedAt: Date },
) {
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
  // The basic row is written first; callers keep this richer snapshot
  // best-effort so GraphQL availability cannot block webhook lifecycle work.
  await refreshGhPullRequest(db, factory, repo, number, observation);
}

async function refreshPullRequestsAndPromoteReady(
  db: FacilityDb,
  orgId: string,
  payload: WebhookPayload,
  factory: GithubClientFactory,
  observation: { sourceEventId: string; observedAt: Date },
) {
  const owner = payload.repository?.owner?.login;
  const name = payload.repository?.name;
  if (!owner || !name) return 0;
  const repo = (
    await db
      .select()
      .from(repos)
      .where(and(eq(repos.orgId, orgId), eq(repos.owner, owner), eq(repos.name, name)))
      .limit(1)
  )[0];
  if (!repo) return 0;
  const check = payload.check_run;
  const numbers = [
    ...(check?.pull_requests ?? []),
    ...(check?.check_suite?.pull_requests ?? []),
    ...(payload.check_suite?.pull_requests ?? []),
    ...(payload.workflow_run?.pull_requests ?? []),
  ]
    .map((pull) => pull.number)
    .filter((number): number is number => typeof number === "number");
  const headSha =
    check?.head_sha ??
    check?.check_suite?.head_sha ??
    payload.check_suite?.head_sha ??
    payload.workflow_run?.head_sha ??
    payload.sha;
  const refreshed = await refreshPullRequestsForSignal(db, factory, repo, {
    numbers,
    headSha,
    ...observation,
  });
  await promotePassingFacilityDrafts(db, factory, repo, { numbers, headSha });
  return refreshed;
}

async function promotePassingFacilityDrafts(
  db: FacilityDb,
  factory: GithubClientFactory,
  repo: typeof repos.$inferSelect,
  input: { numbers: number[]; headSha?: string | null },
) {
  const candidates = await db
    .select()
    .from(ghPullRequests)
    .where(
      and(
        eq(ghPullRequests.repoId, repo.id),
        eq(ghPullRequests.state, "open"),
        eq(ghPullRequests.draft, true),
        eq(ghPullRequests.ciState, "success"),
        sql`${ghPullRequests.ciHeadSha} = ${ghPullRequests.headSha}`,
        input.headSha
          ? eq(ghPullRequests.headSha, input.headSha)
          : input.numbers.length
            ? inArray(ghPullRequests.number, input.numbers)
            : sql`false`,
      ),
    );
  if (!candidates.length) return;
  const client = await createGithubClientForRepo(db, factory, repo);
  let firstError: unknown;
  for (const pull of candidates) {
    try {
      const deliveryContext = await githubDeliveryContext(db, repo, pull.headRef);
      if (!deliveryContext) continue;
      const transitioned = await client.markPullRequestReadyForReview(pull.number, pull.headSha);
      if (!transitioned) continue;
      await db
        .update(ghPullRequests)
        .set({ draft: false, updatedAt: new Date() })
        .where(
          and(
            eq(ghPullRequests.orgId, repo.orgId),
            eq(ghPullRequests.repoId, repo.id),
            eq(ghPullRequests.number, pull.number),
            eq(ghPullRequests.headSha, pull.headSha),
            eq(ghPullRequests.ciState, "success"),
          ),
        );
      await auditGithub(db, repo.orgId, "github.pr.ready", repo, {
        pullNumber: pull.number,
        branch: pull.headRef,
        headSha: pull.headSha,
      });
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
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
