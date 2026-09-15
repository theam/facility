import type { AgentManifest } from "@facility/agents";

/**
 * The work phase answers "where is this unit of work?" for humans and API
 * consumers alike. It is derived from persisted control-plane state only and
 * is deliberately separate from agent activity (is a turn queued or running?)
 * and from the recorded workspace state (is a machine on?).
 */
export const WORK_PHASES = [
  "not_started",
  "in_progress",
  "attention",
  "review",
  "done",
  "archived",
] as const;
export type WorkPhase = (typeof WORK_PHASES)[number];

export const PHASE_REASONS = [
  "issue_open",
  "ready",
  "started",
  "queued",
  "running",
  "draft_pull_request",
  "pull_request_closed",
  "attention",
  "checks_failing",
  "changes_requested",
  "awaiting_review",
  "approved",
  "merged",
  "completed",
  "issue_closed",
  "archived",
  "deleted",
] as const;
export type PhaseReason = (typeof PHASE_REASONS)[number];

export type ReviewState = "approved" | "changes_requested" | "commented" | null;

export type PullRequestSummary = {
  number: number;
  title: string;
  url: string;
  repository: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  ciState: "pending" | "success" | "failure" | null;
  ciFailureNames: string[];
  reviewState: ReviewState;
  headRef: string;
  updatedAt: Date;
};

export type PhaseInput = {
  story?: {
    status: string;
    deletedAt: Date | null;
    hasTurns: boolean;
  } | null;
  issue?: { state: "open" | "closed" } | null;
  pullRequest?: PullRequestSummary | null;
  activeTurn?: { state: "queued" | "running" } | null;
  openAttention: Array<{ kind: string }>;
};

export type PhaseResult = { phase: WorkPhase; reason: PhaseReason };

/** Precedence: archived/deleted, delivered, live execution, blockers, review, progress, backlog. */
export function derivePhase(input: PhaseInput): PhaseResult {
  const story = input.story ?? null;
  const pull = input.pullRequest ?? null;
  if (story?.deletedAt) return { phase: "archived", reason: "deleted" };
  if (story?.status === "archived") return { phase: "archived", reason: "archived" };
  if (pull?.state === "merged") return { phase: "done", reason: "merged" };
  if (story?.status === "done") return { phase: "done", reason: "completed" };
  // An active turn is real work in progress even on a closed issue.
  if (input.activeTurn?.state === "running") return { phase: "in_progress", reason: "running" };
  if (input.activeTurn?.state === "queued") return { phase: "in_progress", reason: "queued" };
  if (input.issue?.state === "closed") return { phase: "done", reason: "issue_closed" };
  if (input.openAttention.length > 0) return { phase: "attention", reason: "attention" };
  if (pull?.state === "open" && pull.ciState === "failure") {
    return { phase: "attention", reason: "checks_failing" };
  }
  if (pull?.state === "open" && pull.reviewState === "changes_requested") {
    return { phase: "attention", reason: "changes_requested" };
  }
  if (story?.status === "attention") return { phase: "attention", reason: "attention" };
  if (pull?.state === "open" && pull.draft) {
    return { phase: "in_progress", reason: "draft_pull_request" };
  }
  if (pull?.state === "open") {
    return {
      phase: "review",
      reason: pull.reviewState === "approved" ? "approved" : "awaiting_review",
    };
  }
  if (story) {
    // A closed, unmerged pull request is not delivery: the story keeps its own progress.
    if (pull?.state === "closed") return { phase: "in_progress", reason: "pull_request_closed" };
    if (story.status === "ready" && !story.hasTurns)
      return { phase: "not_started", reason: "ready" };
    return { phase: "in_progress", reason: "started" };
  }
  return { phase: "not_started", reason: "issue_open" };
}

/** Human wording for a phase; API consumers use the machine value. */
export const PHASE_LABELS: Record<WorkPhase, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  attention: "Needs attention",
  review: "In review",
  done: "Done",
  archived: "Archived",
};

/** The pull request that best represents the unit of work: open first, then merged, then closed. */
export function pickPullRequest<T extends { state: string; draft: boolean; updatedAt: Date }>(
  pulls: T[],
): T | null {
  const rank = (pull: T) =>
    pull.state === "open" ? (pull.draft ? 1 : 0) : pull.state === "merged" ? 2 : 3;
  return (
    [...pulls].sort(
      (left, right) =>
        rank(left) - rank(right) || right.updatedAt.getTime() - left.updatedAt.getTime(),
    )[0] ?? null
  );
}

/**
 * GitHub-style review decision: the latest review from each reviewer counts,
 * changes requested outranks approval, and comment-only reviews never approve.
 */
export function reviewDecision(
  reviews: Array<{ author: string | null; state: string; submittedAt: Date | null }>,
  pullAuthor: string | null,
): ReviewState {
  const latest = new Map<string, { state: string; submittedAt: number }>();
  for (const review of reviews) {
    const author = review.author ?? "";
    if (!author || author === pullAuthor) continue;
    const state = review.state.toLowerCase();
    if (!["approved", "changes_requested", "commented"].includes(state)) continue;
    const submittedAt = review.submittedAt?.getTime() ?? 0;
    const previous = latest.get(author);
    if (state === "commented" && previous && previous.state !== "commented") continue;
    if (!previous || submittedAt >= previous.submittedAt)
      latest.set(author, { state, submittedAt });
  }
  const states = [...latest.values()].map((entry) => entry.state);
  if (states.length === 0) return null;
  if (states.includes("changes_requested")) return "changes_requested";
  if (states.includes("approved")) return "approved";
  return "commented";
}

const TITLE_LIMIT = 80;

/** A readable placeholder derived from the request; the request itself is never altered. */
export function provisionalTitle(request: string): string {
  const line =
    request
      .split(/\r?\n/)
      .map((candidate) =>
        candidate
          .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s+)/, "")
          .replace(/[*_`~]/g, "")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .find((candidate) => candidate.length > 0) ?? "";
  if (!line) return "Untitled request";
  if (line.length <= TITLE_LIMIT) return line;
  const cut = line.slice(0, TITLE_LIMIT - 1);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > TITLE_LIMIT / 2 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

export type AgentSurface = "manual" | "mcp" | "ui" | "github" | "schedule";

/**
 * When the caller does not name an agent, the project's own catalog decides:
 * an enabled agent that accepts this surface, preferring the conventional
 * `builder`, otherwise the first by name. No agent means the request is refused
 * rather than silently routed somewhere unexpected.
 */
export function resolveDefaultAgent<T extends Pick<AgentManifest, "name" | "enabled" | "triggers">>(
  manifests: T[],
  surface: AgentSurface,
): T | null {
  const eligible = manifests
    .filter(
      (manifest) =>
        manifest.enabled && manifest.triggers.some((trigger) => trigger.type === surface),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  return eligible.find((manifest) => manifest.name === "builder") ?? eligible[0] ?? null;
}
