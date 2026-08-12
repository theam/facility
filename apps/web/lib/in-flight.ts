import type { Pipeline, PipelineStageKey, PipelineStory, Run, RunEvent } from "./api";
import { pipelineStageStateLabel, storyHref } from "./pipeline";

export type InFlightRow = {
  runId: string;
  runStatus: string;
  mode: string;
  engine: string;
  startedAt: string | null;
  storyHref: string | null;
  storyLabel: string;
  storyTitle: string;
  stageLabel: string;
  stateLabel: string;
  activity: string;
};

const IGNORED_ACTIVITY_EVENTS = new Set(["assistant", "engine", "heartbeat", "queued"]);

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(data: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function compactText(value: string, max = 120) {
  const firstUsefulLine = value
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("<!--"));
  const text = (firstUsefulLine ?? value)
    .replace(/^[-*#>\s]+/, "")
    .replaceAll("`", "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function humanize(value: string) {
  return value.replaceAll("_", " ").replaceAll("-", " ");
}

function phaseActivity(name: string) {
  if (["bootstrap", "package_install", "provision", "runner_runtime", "workspace"].includes(name)) {
    return "Preparing workspace";
  }
  if (name === "acceptance" || name === "checks" || name === "tests") {
    return "Running acceptance checks";
  }
  if (name === "delivery") return "Preparing the pull request";
  if (name === "planning") return "Drafting the implementation plan";
  if (name === "implementation") return "Implementing the change";
  return humanize(name);
}

function activityForEvent(event: RunEvent) {
  if (IGNORED_ACTIVITY_EVENTS.has(event.type.toLowerCase())) return null;
  const data = objectValue(event.data);

  if (event.type === "agent_progress") {
    const progress = stringValue(data, "markdown", "text", "message");
    return progress ? compactText(progress) : null;
  }
  if (event.type === "phase") {
    const phase = stringValue(data, "name", "phase");
    return phase ? phaseActivity(phase) : null;
  }
  if (event.type === "check") {
    const check = stringValue(data, "name", "command", "text", "message") ?? "acceptance checks";
    const status = stringValue(data, "status", "result");
    if (["ok", "passed", "success", "succeeded"].includes(status ?? "")) {
      return compactText(`${check} passed`);
    }
    if (["error", "failed", "failure"].includes(status ?? "")) {
      return compactText(`${check} failed`);
    }
    return compactText(`Running check · ${check}`);
  }
  if (event.type === "shell") {
    const command = stringValue(data, "command", "text", "message");
    return command ? compactText(`Running · ${command}`) : null;
  }
  if (event.type === "tool") {
    const tool = stringValue(data, "name", "tool", "command", "text");
    return tool ? compactText(`Using ${tool}`) : null;
  }
  if (event.type === "provisioning") return "Preparing workspace";

  const text = stringValue(data, "text", "message", "phase", "name");
  return text ? compactText(text) : null;
}

function fallbackActivity(mode: string, status: string) {
  if (status === "queued") return "Waiting for an available runner";
  if (status === "provisioning") return "Preparing workspace";
  if (mode === "architect" || mode.endsWith("-architect")) {
    return "Drafting the implementation plan";
  }
  if (mode === "builder" || mode.endsWith("-builder")) return "Implementing the accepted plan";
  if (mode === "review") return "Reviewing the proposed change";
  if (mode === "address_review") return "Addressing review feedback";
  if (mode === "ci_doctor") return "Diagnosing failed checks";
  if (mode === "security_sweep") return "Reviewing security findings";
  return "Working on the session objective";
}

export function latestRunActivity(mode: string, status: string, events: RunEvent[]) {
  const ordered = [...events].sort((left, right) => right.seq - left.seq);
  for (const event of ordered) {
    const activity = activityForEvent(event);
    if (activity) return activity;
  }
  return fallbackActivity(mode, status);
}

function githubIdentity(run: Run) {
  const gh = objectValue(run.gh);
  return {
    number: typeof gh.issueNumber === "number" ? gh.issueNumber : null,
    owner: typeof gh.owner === "string" ? gh.owner : null,
    repo: typeof gh.repo === "string" ? gh.repo : null,
  };
}

function storyForRun(
  run: Run,
  storiesByRun: Map<
    string,
    { story: PipelineStory; stageKey: PipelineStageKey; stageLabel: string }
  >,
  stories: Array<{ story: PipelineStory; stageKey: PipelineStageKey; stageLabel: string }>,
) {
  const exact = storiesByRun.get(run.id);
  if (exact) return exact;

  const identity = githubIdentity(run);
  if (identity.number === null) return null;
  return (
    stories.find(
      ({ story }) =>
        story.number === identity.number &&
        (!identity.owner || story.repoOwner === identity.owner) &&
        (!identity.repo || story.repoName === identity.repo),
    ) ?? null
  );
}

/** Join runtime sessions to the durable story model used everywhere else on the overview. */
export function buildInFlightRows({
  projectId,
  runs,
  pipeline,
  eventsByRun,
}: {
  projectId: string;
  runs: Run[];
  pipeline: Pipeline | null;
  eventsByRun: Map<string, RunEvent[]>;
}): InFlightRow[] {
  const stories = (pipeline?.stages ?? []).flatMap((stage) =>
    stage.stories.map((story) => ({ story, stageKey: stage.key, stageLabel: stage.label })),
  );
  const storiesByRun = new Map(
    stories.flatMap((entry) =>
      entry.story.currentRun?.id ? ([[entry.story.currentRun.id, entry]] as const) : [],
    ),
  );

  return runs.map((run) => {
    const match = storyForRun(run, storiesByRun, stories);
    return {
      runId: run.id,
      runStatus: run.status,
      mode: humanize(run.mode),
      engine: run.engine,
      startedAt: run.startedAt,
      storyHref: match ? storyHref(projectId, match.story) : null,
      storyLabel: match
        ? `${match.story.repoOwner}/${match.story.repoName}#${match.story.number}`
        : `session ${run.id.slice(-8)}`,
      storyTitle: match?.story.title ?? "No linked story",
      stageLabel: match?.stageLabel ?? "Session",
      stateLabel: match
        ? pipelineStageStateLabel(match.stageKey, match.story.stageState, 1)
        : humanize(run.status),
      activity: latestRunActivity(run.mode, run.status, eventsByRun.get(run.id) ?? []),
    };
  });
}
