import { engineIdentity, providerIdentity } from "./ai-identity";
import type { BacklogItem, BacklogPhase, BacklogQuery, StoryAgent } from "./api";

/**
 * Presentation helpers for the unified backlog. They only interpret the
 * server's semantics; none of them decides what a phase means.
 */

export const PHASES: Array<{ value: BacklogPhase; label: string; tone: PhaseTone }> = [
  { value: "attention", label: "Needs attention", tone: "bad" },
  { value: "in_progress", label: "In progress", tone: "agent" },
  { value: "review", label: "In review", tone: "human" },
  { value: "not_started", label: "Not started", tone: "machine" },
  { value: "done", label: "Done", tone: "ok" },
  { value: "archived", label: "Archived", tone: "muted" },
];
export type PhaseTone = "agent" | "human" | "ok" | "bad" | "machine" | "muted";

export function phaseLabel(phase: BacklogPhase) {
  return PHASES.find((entry) => entry.value === phase)?.label ?? phase;
}

export function phaseTone(phase: BacklogPhase): PhaseTone {
  return PHASES.find((entry) => entry.value === phase)?.tone ?? "machine";
}

/** One line that says what is actually happening, never inferred from the phase alone. */
export function activityLine(item: BacklogItem, now = new Date()): string {
  const pull = item.pullRequest;
  if (item.activity.state === "running") {
    return `${item.activity.agentName ?? "An agent"} is running${
      item.activity.since ? ` · ${relativeTime(item.activity.since, now)}` : ""
    }`;
  }
  if (item.activity.state === "queued") return `${item.activity.agentName ?? "An agent"} is queued`;
  const facility = item.attention.find((entry) => entry.source === "facility");
  if (facility) {
    return facility.kind === "agent_waiting" ? "Waiting for your reply" : facility.title;
  }
  switch (item.reason) {
    case "checks_failing":
      return pull?.ciFailureNames.length
        ? `Checks failing: ${pull.ciFailureNames.join(", ")}`
        : "Checks failing";
    case "changes_requested":
      return "Changes requested in review";
    case "approved":
      return "Approved, ready to merge";
    case "awaiting_review":
      return pull?.ciState === "pending"
        ? "Awaiting review · checks running"
        : pull?.ciState === "success"
          ? "Awaiting review · checks passed"
          : "Awaiting review";
    case "draft_pull_request":
      return "Draft pull request";
    case "pull_request_closed":
      return "Pull request closed without merge";
    case "merged":
      return `Merged${pull ? ` #${pull.number}` : ""}`;
    case "completed":
      return "Completed";
    case "issue_closed":
      return "Closed on GitHub";
    case "archived":
      return "Archived";
    case "deleted":
      return "Workspace deleted";
    case "ready":
      return "Restored, no agent has run yet";
    case "started":
      return item.environment.recordedState === "sleeping"
        ? "No agent running · workspace suspended"
        : "No agent running";
    case "queued":
    case "running":
    case "attention":
      return "Needs attention";
    default:
      return "Not started";
  }
}

/** Where the title came from, when that matters to the reader. */
export function titleStatus(
  item: Pick<BacklogItem, "titleSource"> & { createdAt?: string | Date },
  now = new Date(),
): string | null {
  if (item.titleSource === "pending") {
    const created = item.createdAt ? new Date(item.createdAt) : null;
    return created && now.getTime() - created.getTime() > 5 * 60 * 1_000
      ? "Title still generating; using your request"
      : "Generating title…";
  }
  if (item.titleSource === "fallback") return "Title taken from your request";
  return null;
}

export function relativeTime(value: string | Date, now = new Date()): string {
  const date = typeof value === "string" ? new Date(value) : value;
  const seconds = Math.round((now.getTime() - date.getTime()) / 1_000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(date);
}

export function personLabel(person: { login: string | null; name: string | null; key: string }) {
  return person.name ?? (person.login ? `@${person.login}` : person.key.replace(/^user:/, ""));
}

export type StoriesSearch = {
  q: string;
  phase: string[];
  label: string[];
  assignee: string[];
  repository: string[];
  sort: "priority" | "updated" | "created";
  page: number;
  start?: string;
};

export const PAGE_SIZE = 50;

/** URL search params are the only state; every filter round-trips through them. */
export function parseStoriesSearch(
  params: Record<string, string | string[] | undefined>,
): StoriesSearch {
  const list = (value: string | string[] | undefined) =>
    (Array.isArray(value) ? value : value ? [value] : [])
      .flatMap((entry) => entry.split(","))
      .map((entry) => entry.trim())
      .filter(Boolean)
      .slice(0, 50);
  const sortValue = Array.isArray(params.sort) ? params.sort[0] : params.sort;
  const pageValue = Number(Array.isArray(params.page) ? params.page[0] : params.page);
  return {
    q: (Array.isArray(params.q) ? params.q[0] : params.q)?.trim().slice(0, 200) ?? "",
    phase: list(params.phase),
    label: list(params.label),
    assignee: list(params.assignee),
    repository: list(params.repository),
    sort: sortValue === "updated" || sortValue === "created" ? sortValue : "priority",
    page: Number.isSafeInteger(pageValue) && pageValue > 0 ? pageValue : 1,
    start: (Array.isArray(params.start) ? params.start[0] : params.start) || undefined,
  };
}

export function toBacklogQuery(search: StoriesSearch): BacklogQuery {
  return {
    ...(search.q ? { q: search.q } : {}),
    ...(search.phase.length > 0 ? { phase: search.phase as BacklogQuery["phase"] } : {}),
    ...(search.label.length > 0 ? { label: search.label } : {}),
    ...(search.assignee.length > 0 ? { assignee: search.assignee } : {}),
    ...(search.repository.length > 0 ? { repository: search.repository } : {}),
    sort: search.sort,
    limit: PAGE_SIZE,
    offset: (search.page - 1) * PAGE_SIZE,
  };
}

export function storiesHref(
  projectId: string,
  search: StoriesSearch,
  changes: Partial<StoriesSearch> = {},
) {
  const next = { ...search, ...changes };
  const params = new URLSearchParams();
  if (next.q) params.set("q", next.q);
  for (const phase of next.phase) params.append("phase", phase);
  for (const label of next.label) params.append("label", label);
  for (const assignee of next.assignee) params.append("assignee", assignee);
  for (const repository of next.repository) params.append("repository", repository);
  if (next.sort !== "priority") params.set("sort", next.sort);
  if (next.page > 1) params.set("page", String(next.page));
  const query = params.toString();
  return `/projects/${encodeURIComponent(projectId)}/stories${query ? `?${query}` : ""}`;
}

export function activeFilterCount(search: StoriesSearch) {
  return (
    (search.q ? 1 : 0) +
    search.label.length +
    search.assignee.length +
    search.repository.length +
    (search.sort !== "priority" ? 1 : 0)
  );
}

/** The phase chip that is selected: a single explicit phase, `all`, or the default open view. */
export function selectedPhaseChip(search: StoriesSearch): string {
  if (search.phase.length === 0) return "open";
  if (search.phase.length === 1) return search.phase[0] ?? "open";
  return "custom";
}

export type AgentChoice = {
  name: string;
  description: string;
  engine: ReturnType<typeof engineIdentity>;
  provider: ReturnType<typeof providerIdentity>;
  model: string;
  isDefault: boolean;
};

/** Reusable actions offered by the project, each with the engine and provider that run it. */
export function agentChoices(agents: StoryAgent[], defaultName: string | null): AgentChoice[] {
  return agents
    .filter((agent) => agent.enabled && agent.triggers.some((trigger) => trigger.type === "ui"))
    .map((agent) => ({
      name: agent.name,
      description: agent.description,
      engine: engineIdentity(agent.engine),
      provider: providerIdentity(agent.engine === "claude_code" ? "anthropic" : "openai"),
      model: agent.model,
      isDefault: agent.name === defaultName,
    }))
    .sort((left, right) =>
      left.isDefault === right.isDefault
        ? left.name.localeCompare(right.name)
        : left.isDefault
          ? -1
          : 1,
    );
}

/** The key of a not-started GitHub issue the composer should link to, if the URL names one. */
export function startTarget(start: string | undefined, items: BacklogItem[]): BacklogItem | null {
  if (!start) return null;
  const item = items.find((candidate) => candidate.key === start);
  return item?.kind === "issue" && item.issue && item.phase !== "done" ? item : null;
}
