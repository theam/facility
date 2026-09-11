import type {
  StoryEnvironment,
  StoryMessage,
  StoryMessageAuthor,
  StoryTurnSummary,
  WorkspaceStoryBundle,
} from "./api";

/** The story phase is durable; only an active turn means an agent is executing. */
export function storyActivity(bundle: Pick<WorkspaceStoryBundle, "story" | "turns" | "attention">) {
  const running = bundle.turns.find((turn) => turn.state === "running");
  const queued = bundle.turns.find((turn) => turn.state === "queued");
  if (running) return { label: `${running.agentName} is running`, active: true };
  if (queued) return { label: `${queued.agentName} is queued`, active: false };
  if (bundle.attention.some((item) => item.status === "open"))
    return { label: "Needs your attention", active: false };
  if (bundle.story.status === "done") return { label: "Completed", active: false };
  if (bundle.story.status === "archived") return { label: "Archived", active: false };
  return { label: "No agent running", active: false };
}

export function computeLabel(environment: StoryEnvironment | null) {
  if (!environment) return "Status unavailable";
  const labels = {
    running: "Machine on",
    sleeping: "Suspended",
    creating: "Starting",
    error: "Environment error",
    deleting: "Deleting",
    destroyed: "Deleted",
  };
  return labels[environment.inspection.state];
}

export function phaseLabel(status: WorkspaceStoryBundle["story"]["status"]) {
  const labels = {
    ready: "Ready",
    working: "In progress",
    attention: "Needs attention",
    review: "In review",
    done: "Done",
    archived: "Archived",
  };
  return labels[status] ?? status;
}

export function newestMessages(messages: StoryMessage[]) {
  return [...messages].sort((a, b) => b.seq - a.seq || b.id.localeCompare(a.id));
}

/**
 * A request and what it produced. Messages that share a run belong together
 * even when queued messages interleave their sequence numbers; a message
 * without a run (still queued, or a system note) stands on its own.
 */
export type Exchange = {
  key: string;
  turn: StoryTurnSummary | null;
  request: StoryMessage | null;
  response: StoryMessage | null;
  extra: StoryMessage[];
  latestSeq: number;
};

export function groupExchanges(messages: StoryMessage[]): Exchange[] {
  const byKey = new Map<string, Exchange>();
  for (const message of newestMessages(messages)) {
    const key = message.turnId ? `turn:${message.turnId}` : `message:${message.id}`;
    const exchange = byKey.get(key) ?? {
      key,
      turn: null,
      request: null,
      response: null,
      extra: [],
      latestSeq: 0,
    };
    exchange.turn ??= message.turn;
    exchange.latestSeq = Math.max(exchange.latestSeq, message.seq);
    if (message.role === "agent" && !exchange.response) exchange.response = message;
    else if (message.role !== "agent" && !exchange.request) exchange.request = message;
    else exchange.extra.push(message);
    byKey.set(key, exchange);
  }
  return [...byKey.values()]
    .map((exchange) => ({ ...exchange, extra: newestMessages(exchange.extra).reverse() }))
    .sort((a, b) => b.latestSeq - a.latestSeq);
}

/** Merge message pages by id; later pages win so run state updates replace stale rows. */
export function mergeMessages(...pages: StoryMessage[][]): StoryMessage[] {
  const byId = new Map<string, StoryMessage>();
  for (const page of pages) for (const message of page) byId.set(message.id, message);
  return newestMessages([...byId.values()]);
}

export type RunStatus = {
  state: "queued" | "running" | "succeeded" | "failed" | "canceled" | "unknown";
  label: string;
  tone: "agent" | "info" | "ok" | "bad" | "machine" | "human";
  pulse: boolean;
  detail: string | null;
};

/**
 * What a run is doing, in words. A finished run with no stored response is
 * said so; nothing is presented as a result when the run did not produce one.
 */
export function runStatus(
  turn: StoryTurnSummary | null,
  options: { waitingForReply?: boolean } = {},
): RunStatus {
  if (!turn) {
    return {
      state: "queued",
      label: "Queued",
      tone: "info",
      pulse: false,
      detail: "Waits for the current run to finish before its own run is created.",
    };
  }
  switch (turn.state) {
    case "queued":
      return {
        state: "queued",
        label: "Queued",
        tone: "info",
        pulse: false,
        detail: "The run is created and starts as soon as a worker picks it up.",
      };
    case "running":
      return {
        state: "running",
        label: "Running",
        tone: "agent",
        pulse: true,
        detail: "The agent is still working; the final response appears when it finishes.",
      };
    case "succeeded":
      return options.waitingForReply
        ? {
            state: "succeeded",
            label: "Needs your reply",
            tone: "human",
            pulse: false,
            detail: "The agent stopped to ask a question. Reply to continue.",
          }
        : { state: "succeeded", label: "Completed", tone: "ok", pulse: false, detail: null };
    case "failed":
      return {
        state: "failed",
        label: "Failed",
        tone: "bad",
        pulse: false,
        detail: errorSummary(turn.error),
      };
    case "canceled":
      return {
        state: "canceled",
        label: "Canceled",
        tone: "machine",
        pulse: false,
        detail: "This run was stopped before it produced a response.",
      };
    default:
      return { state: "unknown", label: turn.state, tone: "machine", pulse: false, detail: null };
  }
}

/** Two-letter fallback for a missing avatar image. */
export function initials(name: string) {
  const parts = name
    .replace(/^@/, "")
    .split(/[\s._-]+/)
    .filter(Boolean);
  const letters =
    parts.length >= 2
      ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`
      : (parts[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

export function authorDescription(author: StoryMessageAuthor) {
  switch (author.kind) {
    case "user":
      return "Team member";
    case "github":
      return "GitHub";
    case "schedule":
      return "Scheduled trigger";
    case "service":
      return "API client";
    case "agent":
      return "Agent";
    default:
      return "System";
  }
}

export function formatTime(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date)
    : value;
}

export function formatDurationBetween(start: string | null, end: string | null) {
  if (!start || !end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown) {
  return typeof value === "string" ? value : "";
}
export function safeExternalUrl(value: string | null) {
  if (!value) return null;
  try {
    return ["https:", "http:"].includes(new URL(value).protocol) ? value : null;
  } catch {
    return null;
  }
}

/** Presentation only: the original message and agent instructions remain unchanged. */
export function presentMessage(message: Pick<StoryMessage, "body">) {
  const envelope = /^Handle the GitHub ([\w_]+) event for trigger ([\w.-]+)\./.exec(message.body);
  if (!envelope) return { title: null, body: message.body, sourceUrl: null, technical: false };
  const title =
    envelope[2] === "architect-command"
      ? "Planning requested via GitHub"
      : envelope[2] === "builder-command"
        ? "Implementation requested via GitHub"
        : `GitHub update: ${envelope[1]?.replaceAll("_", " ")}`;
  try {
    const start = message.body.indexOf("\n\n{");
    const event = record(JSON.parse(message.body.slice(start + 2)));
    const comment = record(event.comment);
    const issue = record(event.issue);
    const pull = record(event.pull_request);
    const review = record(event.review);
    const body =
      text(comment.body) ||
      text(review.body) ||
      text(issue.title) ||
      text(pull.title) ||
      "An update was delivered to the agent.";
    return {
      title,
      body,
      sourceUrl: safeExternalUrl(
        text(comment.html_url) ||
          text(review.html_url) ||
          text(issue.html_url) ||
          text(pull.html_url),
      ),
      technical: true,
    };
  } catch {
    // Older prompts can contain truncated JSON. Never put that payload in the main conversation.
    return {
      title,
      body: "An update was delivered to the agent. Open the original event for technical details.",
      sourceUrl: null,
      technical: true,
    };
  }
}

export function errorSummary(detail: string | null) {
  if (!detail) return "The agent could not complete this run. Review the details before retrying.";
  if (/401|unauthorized/i.test(detail))
    return "The provider rejected authentication. Check the agent credentials before retrying.";
  if (/fetch failed|failed to connect|network/i.test(detail))
    return "The agent could not connect to a required service. Check connectivity before retrying.";
  if (/timeout/i.test(detail))
    return "The run encountered a timeout or timeout configuration error. Review the details before retrying.";
  return "The run reported an error. Review the technical details before retrying.";
}

/** Short human line for a timeline entry; agent entries arrive already summarized. */
export function timelineSummary(type: string, data: Record<string, unknown>) {
  const value = (key: string) => (typeof data[key] === "string" ? String(data[key]) : null);
  const count = (key: string) => (Array.isArray(data[key]) ? data[key].length : 0);
  if (typeof data.title === "string" && typeof data.kind === "string" && type.startsWith("engine."))
    return data.title;
  if (type === "story.created") return value("title") ?? "Story created.";
  if (type === "turn.context_recorded") {
    return [value("agent"), value("model"), value("initialSha")?.slice(0, 10), value("branch")]
      .filter(Boolean)
      .join(" · ");
  }
  if (type === "git.changes_recorded") {
    return `${count("commits")} commits · ${count("changedFiles")} changed files · ${value("initialSha")?.slice(0, 10) ?? "unknown"} → ${value("finalSha")?.slice(0, 10) ?? "unknown"}`;
  }
  if (type === "github.branch_observed" || type === "github.branch_deleted") {
    return `${value("branch") ?? "branch"} · ${value("headSha")?.slice(0, 10) ?? "unknown"} · ${value("actor") ?? "external"}`;
  }
  if (type === "github.pull_request_observed") {
    return `PR #${String(data.number ?? "?")} · ${value("state") ?? "unknown"} · ${value("title") ?? ""}`;
  }
  if (type === "github.review_observed") {
    return `${value("author") ?? "unknown reviewer"} · ${value("state") ?? "reviewed"} · PR #${String(data.pullNumber ?? "?")}`;
  }
  if (type === "github.check_observed") {
    return `${value("name") ?? "check"} · ${value("conclusion") ?? value("status") ?? "unknown"}`;
  }
  if (type === "artifact.recorded") return value("label") ?? "Artifact recorded.";
  if (type.startsWith("attention.")) return value("title") ?? type;
  if (type === "turn.failed") return value("error") ?? value("title") ?? "Turn failed.";
  if (value("title")) return value("title") ?? type;
  return type.replaceAll(".", " ");
}
