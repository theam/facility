import { newId } from "@facility/core";
import {
  type FacilityDb,
  githubInstallations,
  inboundEvents,
  insertAuditEvent,
  integrations,
  outcomes,
  repos,
  runs,
} from "@facility/db";
import { and, eq, sql } from "drizzle-orm";
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
import { verifyFingerprints } from "./kickstart.js";
import { routeTrigger, type TriggerPayload } from "./router.js";

type WebhookPayload = TriggerPayload & {
  action?: string;
  installation?: { id?: number; account?: { login?: string; type?: string }; target_type?: string };
  repositories?: {
    full_name?: string;
    name?: string;
    owner?: { login?: string };
    default_branch?: string;
  }[];
  repository?: TriggerPayload["repository"] & { full_name?: string; default_branch?: string };
  pull_request?: {
    number?: number;
    merged?: boolean;
    head?: { ref?: string };
    created_at?: string;
    closed_at?: string;
  };
  workflow_run?: { name?: string; conclusion?: string; html_url?: string };
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
      await processPush(db, event.orgId, payload, enqueue);
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
        payload,
        factory ?? createGithubClientFactory(config),
      );
    } else if (event.eventType === "workflow_run") {
      await processWorkflowRun(db, event.orgId, payload);
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
  const accountLogin = payload.installation?.account?.login;
  if (!installationId || !accountLogin) return;
  const row = (
    await db
      .insert(githubInstallations)
      .values({
        id: newId("int"),
        orgId,
        installationId,
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
  payload: WebhookPayload,
  factory: GithubClientFactory,
) {
  if (payload.action !== "closed") return;
  const head = payload.pull_request?.head?.ref ?? "";
  if (!/^(claude|codex|facility)\//.test(head)) return;
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
  const metrics = await pullRequestMetrics(factory, payload, owner, name, number);
  const producingRun = (
    await db
      .select({ id: runs.id })
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
  await db
    .insert(outcomes)
    .values({
      id: newId("evt"),
      orgId: repo.orgId,
      projectId: repo.projectId,
      repo: `${owner}/${name}`,
      prNumber: number,
      agentLane: head.split("/")[0] ?? "facility",
      runId: producingRun?.id,
      openedAt: payload.pull_request?.created_at
        ? new Date(payload.pull_request.created_at)
        : new Date(),
      terminalAt: payload.pull_request?.closed_at
        ? new Date(payload.pull_request.closed_at)
        : new Date(),
      fate: payload.pull_request?.merged ? "merged" : "closed",
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

async function processWorkflowRun(db: FacilityDb, orgId: string, payload: WebhookPayload) {
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
