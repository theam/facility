import type {
  AgentStatus,
  Catalog,
  LlmRequest,
  Outcome,
  Pipeline,
  PipelineStory,
  Run,
  SpendRow,
} from "./api";
import { storyHref } from "./pipeline";

export type AgentSpendRow = {
  key: string;
  agentId: string | null;
  agentName: string;
  engine: string;
  provider: string;
  model: string;
  additionalModelCount: number;
  spendCents: number;
  sharePercent: number;
  shippedCount: number;
  costPerShippedCents: number | null;
};

export type ShippedDeliveryRow = {
  outcomeId: string;
  runId: string | null;
  repo: string;
  pullNumber: number;
  pullHref: string;
  storyHref: string | null;
  storyLabel: string;
  storyTitle: string;
  assignees: string[];
  agentName: string;
  engine: string;
  provider: string;
  model: string;
  additionalModelCount: number;
  costCents: number | null;
  terminalAt: string;
  oneShot: boolean;
};

export type DeliveryIntelligence = {
  totalSpendCents: number;
  shippedCount: number;
  costPerShippedCents: number | null;
  spendRows: AgentSpendRow[];
  shippedRows: ShippedDeliveryRow[];
};

type AgentConfiguration = {
  agentName: string;
  engine: string;
  provider: string;
  model: string;
  additionalModelCount: number;
};

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function configuredModel(value: unknown) {
  const model = objectValue(value);
  for (const key of ["model", "primary", "name"]) {
    if (typeof model[key] === "string" && model[key]) return model[key];
  }
  return "default model";
}

function inferredProvider(model: string) {
  if (model.startsWith("claude") || model.startsWith("opus") || model.startsWith("sonnet")) {
    return "anthropic";
  }
  if (model.startsWith("gpt")) return "openai";
  return "custom";
}

function receiptCost(run: Run | undefined) {
  const receipt = objectValue(run?.receipt);
  const usage = objectValue(receipt.usage);
  return typeof usage.cost_cents === "number" ? usage.cost_cents : null;
}

function dominantConfiguration(
  requests: LlmRequest[],
): Pick<AgentConfiguration, "provider" | "model" | "additionalModelCount"> | null {
  if (requests.length === 0) return null;
  const costs = new Map<string, { provider: string; model: string; cents: number }>();
  for (const request of requests) {
    const key = `${request.provider}\0${request.model}`;
    const row = costs.get(key) ?? { provider: request.provider, model: request.model, cents: 0 };
    row.cents += request.costCents ?? 0;
    costs.set(key, row);
  }
  const ordered = [...costs.values()].sort(
    (left, right) => right.cents - left.cents || left.model.localeCompare(right.model),
  );
  const primary = ordered[0];
  return primary
    ? {
        provider: primary.provider,
        model: primary.model,
        additionalModelCount: Math.max(0, ordered.length - 1),
      }
    : null;
}

function fallbackConfiguration(
  agent: AgentStatus | undefined,
  catalog: Catalog | null,
): AgentConfiguration {
  const model = agent ? configuredModel(agent.model) : "unknown model";
  const provider = catalog?.models.find((candidate) => candidate.id === model)?.provider;
  return {
    agentName: agent?.name ?? "unattributed agent",
    engine: agent?.engine ?? "unknown engine",
    provider: provider ?? inferredProvider(model),
    model,
    additionalModelCount: 0,
  };
}

function configurationFor(
  agent: AgentStatus | undefined,
  requests: LlmRequest[],
  catalog: Catalog | null,
) {
  const fallback = fallbackConfiguration(agent, catalog);
  return { ...fallback, ...(dominantConfiguration(requests) ?? {}) };
}

function storyForOutcome(outcome: Outcome, run: Run | undefined, stories: PipelineStory[]) {
  const [owner, repoName] = outcome.repo.split("/");
  const pullMatch = stories.find(
    (story) =>
      story.repoOwner === owner &&
      story.repoName === repoName &&
      story.prs.some((pull) => pull.number === outcome.prNumber),
  );
  if (pullMatch) return pullMatch;

  const gh = objectValue(run?.gh);
  const issueNumber = typeof gh.issueNumber === "number" ? gh.issueNumber : null;
  if (issueNumber !== null) {
    const issueMatch = stories.find(
      (story) =>
        story.repoOwner === owner && story.repoName === repoName && story.number === issueNumber,
    );
    if (issueMatch) return issueMatch;
  }

  return stories.find(
    (story) =>
      story.repoOwner === owner &&
      story.repoName === repoName &&
      story.storyType === "pull_request" &&
      story.number === outcome.prNumber,
  );
}

function isInPeriod(value: string | null, periodStart: string) {
  return value !== null && new Date(value).getTime() >= new Date(periodStart).getTime();
}

/**
 * Attribute spend and shipped outcomes to the exact agent configuration that produced them.
 * Aggregate spend remains gateway-authoritative; request rows only supply provider/model identity.
 */
export function buildDeliveryIntelligence({
  projectId,
  periodStart,
  spend,
  agents,
  runs,
  outcomes,
  requests,
  pipeline,
  catalog,
}: {
  projectId: string;
  periodStart: string;
  spend: SpendRow[];
  agents: AgentStatus[];
  runs: Run[];
  outcomes: Outcome[];
  requests: LlmRequest[];
  pipeline: Pipeline | null;
  catalog: Catalog | null;
}): DeliveryIntelligence {
  const agentsById = new Map(agents.map((agent) => [agent.agentId, agent]));
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const requestsByAgent = new Map<string, LlmRequest[]>();
  const requestsByRun = new Map<string, LlmRequest[]>();
  for (const request of requests) {
    if (request.agentDefId) {
      const rows = requestsByAgent.get(request.agentDefId) ?? [];
      rows.push(request);
      requestsByAgent.set(request.agentDefId, rows);
    }
    if (request.runId) {
      const rows = requestsByRun.get(request.runId) ?? [];
      rows.push(request);
      requestsByRun.set(request.runId, rows);
    }
  }

  const mergedOutcomes = outcomes.filter(
    (outcome) => outcome.fate === "merged" && isInPeriod(outcome.terminalAt, periodStart),
  );
  const shippedByAgent = new Map<string, number>();
  for (const outcome of mergedOutcomes) {
    const agentId = outcome.runId ? runsById.get(outcome.runId)?.agentDefId : null;
    if (agentId) shippedByAgent.set(agentId, (shippedByAgent.get(agentId) ?? 0) + 1);
  }

  const totalSpendCents = spend.reduce((total, row) => total + row.cost_cents, 0);
  const spendRows = spend
    .filter((row) => row.cost_cents > 0)
    .map((row): AgentSpendRow => {
      const agentId = row.bucket === "none" ? null : row.bucket;
      const configuration = configurationFor(
        agentId ? agentsById.get(agentId) : undefined,
        agentId ? (requestsByAgent.get(agentId) ?? []) : [],
        catalog,
      );
      const shippedCount = agentId ? (shippedByAgent.get(agentId) ?? 0) : 0;
      return {
        key: row.bucket,
        agentId,
        ...configuration,
        spendCents: row.cost_cents,
        sharePercent:
          totalSpendCents > 0 ? Math.round((1000 * row.cost_cents) / totalSpendCents) / 10 : 0,
        shippedCount,
        costPerShippedCents: shippedCount > 0 ? Math.round(row.cost_cents / shippedCount) : null,
      };
    })
    .sort(
      (left, right) =>
        right.spendCents - left.spendCents || left.agentName.localeCompare(right.agentName),
    );

  const stories = (pipeline?.stages ?? []).flatMap((stage) => stage.stories);
  const shippedRows = mergedOutcomes
    .map((outcome): ShippedDeliveryRow | null => {
      if (!outcome.terminalAt) return null;
      const run = outcome.runId ? runsById.get(outcome.runId) : undefined;
      const agent = run?.agentDefId ? agentsById.get(run.agentDefId) : undefined;
      const runRequests = outcome.runId ? (requestsByRun.get(outcome.runId) ?? []) : [];
      const configuration = configurationFor(agent, runRequests, catalog);
      const story = storyForOutcome(outcome, run, stories);
      const requestCost = runRequests.reduce(
        (total, request) => total + (request.costCents ?? 0),
        0,
      );
      return {
        outcomeId: outcome.id,
        runId: outcome.runId,
        repo: outcome.repo,
        pullNumber: outcome.prNumber,
        pullHref: `https://github.com/${outcome.repo}/pull/${outcome.prNumber}`,
        storyHref: story ? storyHref(projectId, story) : null,
        storyLabel: story
          ? `${story.repoOwner}/${story.repoName}#${story.number}`
          : `${outcome.repo} PR #${outcome.prNumber}`,
        storyTitle: story?.title ?? `Pull request #${outcome.prNumber}`,
        assignees: story?.assignees ?? [],
        ...configuration,
        costCents: receiptCost(run) ?? (runRequests.length > 0 ? Math.round(requestCost) : null),
        terminalAt: outcome.terminalAt,
        oneShot: outcome.reviewRounds === 0 && outcome.fixupCommits === 0,
      };
    })
    .filter((row): row is ShippedDeliveryRow => row !== null)
    .sort((left, right) => right.terminalAt.localeCompare(left.terminalAt))
    .slice(0, 6);

  return {
    totalSpendCents,
    shippedCount: mergedOutcomes.length,
    costPerShippedCents:
      mergedOutcomes.length > 0 ? Math.round(totalSpendCents / mergedOutcomes.length) : null,
    spendRows,
    shippedRows,
  };
}
