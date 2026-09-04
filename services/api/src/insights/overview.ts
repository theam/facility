import {
  agentManifests,
  attentionItems,
  auditEvents,
  type FacilityDb,
  githubCiEvents,
  githubIssues,
  githubPullRequests,
  githubWebhookEvents,
  turns,
  turnUsage,
  workspaces,
} from "@facility/db";
import { and, desc, eq, gte } from "drizzle-orm";
import type { CostBudgetService } from "./costs.js";

export class InsightsService {
  constructor(
    private readonly db: FacilityDb,
    private readonly costs: CostBudgetService,
  ) {}

  async overview(orgId: string, projectId: string, days = 30, now = new Date()) {
    const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1_000);
    const [
      turnRows,
      usageRows,
      workspaceRows,
      openAttention,
      webhooks,
      issueRows,
      pullRows,
      ciRows,
      manifestRows,
      budget,
      recentAudit,
    ] = await Promise.all([
      this.db
        .select()
        .from(turns)
        .where(
          and(eq(turns.orgId, orgId), eq(turns.projectId, projectId), gte(turns.createdAt, from)),
        ),
      this.db
        .select()
        .from(turnUsage)
        .where(
          and(
            eq(turnUsage.orgId, orgId),
            eq(turnUsage.projectId, projectId),
            gte(turnUsage.createdAt, from),
          ),
        ),
      this.db
        .select()
        .from(workspaces)
        .where(and(eq(workspaces.orgId, orgId), eq(workspaces.projectId, projectId))),
      this.db
        .select()
        .from(attentionItems)
        .where(
          and(
            eq(attentionItems.orgId, orgId),
            eq(attentionItems.projectId, projectId),
            eq(attentionItems.status, "open"),
          ),
        ),
      this.db
        .select()
        .from(githubWebhookEvents)
        .where(
          and(
            eq(githubWebhookEvents.orgId, orgId),
            eq(githubWebhookEvents.projectId, projectId),
            gte(githubWebhookEvents.receivedAt, from),
          ),
        ),
      this.db
        .select()
        .from(githubIssues)
        .where(and(eq(githubIssues.orgId, orgId), eq(githubIssues.projectId, projectId))),
      this.db
        .select()
        .from(githubPullRequests)
        .where(
          and(eq(githubPullRequests.orgId, orgId), eq(githubPullRequests.projectId, projectId)),
        ),
      this.db
        .select()
        .from(githubCiEvents)
        .where(
          and(
            eq(githubCiEvents.orgId, orgId),
            eq(githubCiEvents.projectId, projectId),
            gte(githubCiEvents.observedAt, from),
          ),
        ),
      this.db
        .select()
        .from(agentManifests)
        .where(and(eq(agentManifests.orgId, orgId), eq(agentManifests.projectId, projectId))),
      this.costs.budgetState(orgId, projectId, now),
      this.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.orgId, orgId), eq(auditEvents.projectId, projectId)))
        .orderBy(desc(auditEvents.createdAt))
        .limit(25),
    ]);
    const turnCounts = countBy(turnRows, (row) => row.state);
    const workspaceCounts = countBy(workspaceRows, (row) => row.state);
    const usage = usageSummary(usageRows);
    const daily = dailySeries(turnRows, usageRows, pullRows, from, now);
    const delivery = deliverySummary(pullRows, ciRows, from);
    const failedWebhooks = webhooks.filter((event) => event.error).length;
    const failedChecks = pullRows.filter(
      (pull) => pull.state === "open" && pull.ciState === "failure",
    ).length;
    const errorWorkspaces = workspaceRows.filter((workspace) => workspace.state === "error").length;
    const health =
      failedWebhooks > 0 || errorWorkspaces > 0
        ? "degraded"
        : turnRows.some((turn) => turn.state === "failed") || failedChecks > 0
          ? "attention"
          : "healthy";
    return {
      period: { from, to: now, days },
      health,
      turns: {
        total: turnRows.length,
        queued: turnCounts.queued ?? 0,
        running: turnCounts.running ?? 0,
        succeeded: turnCounts.succeeded ?? 0,
        failed: turnCounts.failed ?? 0,
        canceled: turnCounts.canceled ?? 0,
        successRate: ratio(
          turnCounts.succeeded ?? 0,
          (turnCounts.succeeded ?? 0) + (turnCounts.failed ?? 0),
        ),
      },
      usage,
      budget: presentBudget(budget),
      workspaces: {
        total: workspaceRows.length,
        states: workspaceCounts,
        retained: workspaceRows.filter((workspace) => workspace.state !== "destroyed").length,
      },
      github: {
        openIssues: issueRows.filter((issue) => issue.state === "open").length,
        openPullRequests: pullRows.filter((pull) => pull.state === "open").length,
        failedChecks,
        webhookEvents: webhooks.length,
        failedWebhooks,
      },
      analytics: {
        activeAgents: manifestRows.filter(
          (row) => (row.manifest as { enabled?: unknown }).enabled !== false,
        ).length,
        ...delivery,
      },
      attention: { open: openAttention.length },
      daily,
      byAgent: groupedUsage(usageRows, (row) => row.agentName),
      byModel: groupedUsage(usageRows, (row) => row.model),
      recentAudit,
    };
  }
}

function usageSummary(rows: Array<typeof turnUsage.$inferSelect>) {
  return rows.reduce(
    (summary, row) => {
      summary.turns += 1;
      summary.inputTokens += row.inputTokens;
      summary.outputTokens += row.outputTokens;
      summary.cacheReadTokens += row.cacheReadTokens;
      summary.cacheWriteTokens += row.cacheWriteTokens;
      summary.costCents += row.costCents ?? 0;
      if (!row.priced) summary.unpricedTurns += 1;
      summary.durationMs += row.durationMs;
      return summary;
    },
    {
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costCents: 0,
      unpricedTurns: 0,
      durationMs: 0,
    },
  );
}

function dailySeries(
  turnRows: Array<typeof turns.$inferSelect>,
  usageRows: Array<typeof turnUsage.$inferSelect>,
  pullRows: Array<typeof githubPullRequests.$inferSelect>,
  from: Date,
  to: Date,
) {
  const days = new Map<
    string,
    {
      day: string;
      started: number;
      succeeded: number;
      failed: number;
      costCents: number;
      tokens: number;
      mergedPullRequests: number;
    }
  >();
  for (
    let cursor = utcDay(from);
    cursor <= utcDay(to);
    cursor = new Date(cursor.getTime() + 86_400_000)
  ) {
    const key = cursor.toISOString().slice(0, 10);
    days.set(key, {
      day: key,
      started: 0,
      succeeded: 0,
      failed: 0,
      costCents: 0,
      tokens: 0,
      mergedPullRequests: 0,
    });
  }
  for (const turn of turnRows) {
    const day = days.get(turn.createdAt.toISOString().slice(0, 10));
    if (!day) continue;
    day.started += 1;
    if (turn.state === "succeeded") day.succeeded += 1;
    if (turn.state === "failed") day.failed += 1;
  }
  for (const usage of usageRows) {
    const day = days.get(usage.createdAt.toISOString().slice(0, 10));
    if (!day) continue;
    day.costCents += usage.costCents ?? 0;
    day.tokens +=
      usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  }
  for (const pull of pullRows) {
    if (!pull.mergedAt) continue;
    const day = days.get(pull.mergedAt.toISOString().slice(0, 10));
    if (day) day.mergedPullRequests += 1;
  }
  return [...days.values()];
}

function deliverySummary(
  pullRows: Array<typeof githubPullRequests.$inferSelect>,
  ciRows: Array<typeof githubCiEvents.$inferSelect>,
  from: Date,
) {
  const merged = pullRows.filter((pull) => pull.mergedAt && pull.mergedAt >= from);
  const observed = new Set(ciRows.map((event) => `${event.repositoryId}:${event.pullNumber}`));
  const failed = new Set(
    ciRows
      .filter((event) => event.state === "failure")
      .map((event) => `${event.repositoryId}:${event.pullNumber}`),
  );
  const assessed = merged.filter((pull) => observed.has(`${pull.repositoryId}:${pull.number}`));
  const firstPass = assessed.filter(
    (pull) => !failed.has(`${pull.repositoryId}:${pull.number}`),
  ).length;
  const leadTimes = merged.flatMap((pull) =>
    pull.githubCreatedAt && pull.mergedAt
      ? [(pull.mergedAt.getTime() - pull.githubCreatedAt.getTime()) / 3_600_000]
      : [],
  );
  return {
    mergedPullRequests: merged.length,
    ciEvidenceMerges: assessed.length,
    ciEvidenceRate: ratio(assessed.length, merged.length),
    observedFirstPassMerges: firstPass,
    observedFirstPassRate: ratio(firstPass, assessed.length),
    averagePullRequestLeadTimeHours:
      leadTimes.length === 0
        ? null
        : leadTimes.reduce((total, value) => total + value, 0) / leadTimes.length,
  };
}

function groupedUsage(
  rows: Array<typeof turnUsage.$inferSelect>,
  key: (row: typeof turnUsage.$inferSelect) => string,
) {
  return [...new Set(rows.map(key))].map((name) => ({
    name,
    ...usageSummary(rows.filter((row) => key(row) === name)),
  }));
}

function presentBudget(state: Awaited<ReturnType<CostBudgetService["budgetState"]>>) {
  return {
    id: state.budget?.id ?? null,
    enabled: state.budget?.enabled ?? false,
    monthlyLimitCents: state.budget?.monthlyLimitCents ?? null,
    warningPercent: state.budget?.warningPercent ?? null,
    windowStart: state.windowStart,
    windowEnd: state.windowEnd,
    spentCents: state.spentCents,
    remainingCents: state.remainingCents,
    percentUsed: state.percentUsed,
    state: state.state,
    enforcement: "block_new_turns",
  };
}

function countBy<T>(rows: T[], key: (row: T) => string) {
  return rows.reduce<Record<string, number>>((counts, row) => {
    const value = key(row);
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function ratio(numerator: number, denominator: number) {
  return denominator === 0 ? null : numerator / denominator;
}

function utcDay(value: Date) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}
