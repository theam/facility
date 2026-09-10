import type {
  OverviewAttentionItem,
  OverviewRecentTurn,
  OverviewReviewItem,
  ProjectOverview,
} from "./api";
import { errorSummary, safeExternalUrl } from "./story-presentation";

// Presentation decisions for the project overview, kept free of React so the
// state interpretation is unit-testable. Server data stays untouched; these
// helpers only decide labels, ordering and destinations.

export type Tone = "agent" | "human" | "ok" | "bad" | "info" | "machine";

export function storyHref(projectId: string, storyId: string) {
  return `/projects/${encodeURIComponent(projectId)}/stories/${encodeURIComponent(storyId)}`;
}

/** One sentence about agent activity. Only a running turn means an agent is executing. */
export function activitySummary(activity: ProjectOverview["activity"]) {
  const running = activity.running.length;
  const queued = activity.queued.length;
  if (running === 0 && queued === 0) return { label: "No agent running", active: false };
  const parts = [];
  if (running > 0) parts.push(`${running} ${running === 1 ? "agent" : "agents"} running`);
  if (queued > 0) parts.push(`${queued} queued`);
  return { label: parts.join(" · "), active: running > 0 };
}

export function relativeTime(value: string | null, now: Date) {
  if (!value) return "unknown time";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "unknown time";
  const diff = now.getTime() - date.getTime();
  const future = diff < 0;
  const abs = Math.abs(diff);
  const minutes = Math.round(abs / 60_000);
  const hours = Math.round(abs / 3_600_000);
  const days = Math.round(abs / 86_400_000);
  let span: string;
  if (abs < 45_000) return future ? "in a moment" : "just now";
  if (minutes < 60) span = `${minutes} min`;
  else if (hours < 48) span = `${hours} h`;
  else span = `${days} d`;
  return future ? `in ${span}` : `${span} ago`;
}

export function duration(ms: number | null) {
  if (ms === null) return null;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 90) return `${minutes} min`;
  const hours = ms / 3_600_000;
  return `${hours.toFixed(1)} h`;
}

export function triggerLabel(triggerType: string) {
  switch (triggerType) {
    case "github":
      return "from GitHub";
    case "schedule":
      return "on schedule";
    case "mcp":
      return "from MCP";
    case "ui":
      return "from the web";
    case "manual":
      return "from the API";
    default:
      return `from ${triggerType}`;
  }
}

export function attentionKindLabel(kind: string) {
  switch (kind) {
    case "agent_waiting":
      return "Agent waiting for a reply";
    case "turn_error":
      return "Agent run failed";
    case "worker_interrupted":
      return "Agent run interrupted";
    case "queued_turn_dispatch_error":
      return "Turn could not start";
    case "runtime_error":
      return "Environment error";
    default:
      return kind.replaceAll("_", " ");
  }
}

export type AttentionEntry = {
  key: string;
  tone: Tone;
  title: string;
  storyId: string | null;
  storyTitle: string | null;
  summary: string;
  at: string | null;
  action: { label: string; href: string; external?: boolean } | null;
  item: OverviewAttentionItem | null;
  detail: string | null;
};

/**
 * Everything that waits for a person, in the order to handle it: agent questions
 * and failed runs first (Facility is blocked on the user), then pull requests
 * whose checks failed, then a budget that blocks or is about to block new work.
 */
export function attentionQueue(
  overview: Pick<ProjectOverview, "attention" | "review" | "spend">,
  projectId: string,
): AttentionEntry[] {
  const entries: AttentionEntry[] = overview.attention.items.map((item) => ({
    key: `attention:${item.id}`,
    tone: item.kind === "agent_waiting" ? "human" : "bad",
    title: attentionKindLabel(item.kind),
    storyId: item.storyId,
    storyTitle: item.storyTitle,
    summary:
      item.kind === "agent_waiting"
        ? (item.detail ?? "The agent is waiting for your reply.")
        : errorSummary(item.detail),
    at: item.createdAt,
    action:
      item.action === "reply"
        ? {
            label: "Reply in the story",
            href: `${storyHref(projectId, item.storyId)}#story-composer`,
          }
        : { label: "Open the story", href: storyHref(projectId, item.storyId) },
    item,
    detail: item.kind === "agent_waiting" ? null : item.detail,
  }));
  for (const review of overview.review.items) {
    if (review.pullRequest.ciState !== "failure") continue;
    const url = safeExternalUrl(review.pullRequest.url);
    const failing = review.pullRequest.ciFailureNames;
    entries.push({
      key: `checks:${review.pullRequest.repository}:${review.pullRequest.number}`,
      tone: "bad",
      title: `Checks failed on pull request #${review.pullRequest.number}`,
      storyId: review.storyId,
      storyTitle: review.storyTitle ?? review.pullRequest.title,
      summary:
        failing.length > 0
          ? `Failing: ${failing.join(", ")}. Review the checks, then send a fix task or fix it yourself.`
          : "Review the failed checks, then send a fix task or fix it yourself.",
      at: review.pullRequest.updatedAt,
      action: url ? { label: "Open the pull request", href: url, external: true } : null,
      item: null,
      detail: null,
    });
  }
  const budget = overview.spend.budget;
  if (budget.available && (budget.state === "exceeded" || budget.state === "warning")) {
    entries.push({
      key: "budget",
      tone: budget.state === "exceeded" ? "bad" : "human",
      title:
        budget.state === "exceeded"
          ? "Monthly budget exhausted: new agent turns are blocked"
          : "Monthly budget warning",
      storyId: null,
      storyTitle: null,
      summary: `${money(budget.spentCents)} of ${money(budget.monthlyLimitCents ?? 0)} used this month.${
        budget.state === "exceeded"
          ? " Raise the limit or wait for the next month to continue."
          : " New turns are blocked once the limit is reached."
      }`,
      at: null,
      action: {
        label: "Review the budget",
        href: `/projects/${encodeURIComponent(projectId)}/insights`,
      },
      item: null,
      detail: null,
    });
  }
  return entries;
}

export function reviewState(item: OverviewReviewItem): { label: string; tone: Tone } {
  const pull = item.pullRequest;
  if (pull.draft) return { label: "Draft", tone: "machine" };
  if (pull.ciState === "failure") return { label: "Checks failed", tone: "bad" };
  if (pull.ciState === "success") return { label: "Ready for review", tone: "ok" };
  if (pull.ciState === "pending") return { label: "Checks running", tone: "info" };
  return { label: "Checks unknown", tone: "machine" };
}

export function turnResult(turn: OverviewRecentTurn): { label: string; tone: Tone } {
  if (turn.state === "succeeded") return { label: `${turn.agentName} finished`, tone: "ok" };
  if (turn.state === "canceled")
    return { label: `${turn.agentName} was canceled`, tone: "machine" };
  return { label: `${turn.agentName} failed`, tone: "bad" };
}

export function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export type SpendReading = {
  kind: "none" | "unknown" | "partial" | "known";
  amount: string;
  note: string;
};

/**
 * Agent cost for one window. A real zero (no turns) is different from an unknown
 * cost (turns exist but none were priced) and from a partial one (some turns were
 * not priced or reported no usage). The amount is never presented as a bill.
 */
export function spendReading(window: {
  turns: number;
  pricedTurns: number;
  unpricedTurns: number;
  unmeasuredTurns: number;
  costCents: number;
}): SpendReading {
  const gaps = window.unpricedTurns + window.unmeasuredTurns;
  if (window.turns === 0 && window.unmeasuredTurns === 0) {
    return { kind: "none", amount: money(0), note: "no agent turns" };
  }
  if (window.pricedTurns === 0) {
    return {
      kind: "unknown",
      amount: "unknown",
      note: `${gaps} ${gaps === 1 ? "turn" : "turns"} without a price`,
    };
  }
  if (gaps > 0) {
    return {
      kind: "partial",
      amount: `at least ${money(window.costCents)}`,
      note: `${window.pricedTurns} priced · ${gaps} without a price`,
    };
  }
  return {
    kind: "known",
    amount: money(window.costCents),
    note: `${window.pricedTurns} priced ${window.pricedTurns === 1 ? "turn" : "turns"}`,
  };
}

export function budgetReading(budget: ProjectOverview["spend"]["budget"]) {
  if (!budget.available) return { label: "Not visible for your role", tone: "machine" as Tone };
  switch (budget.state) {
    case "not_configured":
      return { label: "No monthly budget", tone: "machine" as Tone };
    case "disabled":
      return { label: "Budget disabled", tone: "machine" as Tone };
    case "exceeded":
      return { label: "Budget exhausted", tone: "bad" as Tone };
    case "warning":
      return { label: "Budget warning", tone: "human" as Tone };
    default:
      return { label: "Within budget", tone: "ok" as Tone };
  }
}

export function environmentsLine(environments: ProjectOverview["environments"]) {
  if (environments.retained === 0) return "No retained workspaces.";
  const parts = [`${environments.retained} retained`];
  const { recorded } = environments;
  if (recorded.running > 0) parts.push(`${recorded.running} recorded as running`);
  if (recorded.sleeping > 0) parts.push(`${recorded.sleeping} suspended`);
  if (recorded.creating > 0) parts.push(`${recorded.creating} starting`);
  if (recorded.error > 0) parts.push(`${recorded.error} in error`);
  if (recorded.deleting > 0) parts.push(`${recorded.deleting} deleting`);
  return parts.join(" · ");
}

/** Where a story came from, in words rather than the provider:external_id token. */
export function storySource(story: { provider: string; externalId: string }) {
  if (story.provider === "github") {
    const issue = /^issue:(\d+)$/.exec(story.externalId);
    if (issue) return `GitHub issue #${issue[1]}`;
    const pull = /^pull-request:(\d+)$/.exec(story.externalId);
    if (pull) return `GitHub pull request #${pull[1]}`;
    return `GitHub · ${story.externalId}`;
  }
  if (story.provider === "schedule") return "Scheduled story";
  return "Manual story";
}

export function monthLabel(iso: string) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "this month";
  return new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    date,
  );
}
