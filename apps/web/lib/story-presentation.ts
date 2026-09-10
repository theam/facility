import type { StoryEnvironment, StoryMessage, WorkspaceStoryBundle } from "./api";

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

export function newestMessages(messages: StoryMessage[]) {
  return [...messages].sort((a, b) => b.seq - a.seq || b.id.localeCompare(a.id));
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
export function presentMessage(message: StoryMessage) {
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
