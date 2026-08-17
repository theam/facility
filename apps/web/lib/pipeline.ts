import type {
  Pipeline,
  PipelineStage,
  PipelineStageKey,
  PipelineStageState,
  PipelineStory,
} from "./api";

export type {
  Pipeline,
  PipelineStage,
  PipelineStageKey,
  PipelineStageKind,
  PipelineStageState,
  PipelineStory,
} from "./api";

export type PipelineStatusTone = "human" | "agent" | "machine" | "bad" | "ok";

const STATUS_ORDER: Record<PipelineStageKey, PipelineStageState[]> = {
  backlog: ["needs_attention", "ready_to_plan"],
  planning: ["in_progress", "needs_review", "ready_to_build", "failed"],
  building: ["in_progress", "draft_pr", "failed"],
  validating: ["checks_running", "checks_failed"],
  review: ["in_progress", "awaiting_review", "failed"],
  shipped: ["shipped_recently"],
};

const STATUS_TONE: Record<PipelineStageState, PipelineStatusTone> = {
  ready_to_plan: "human",
  needs_attention: "bad",
  in_progress: "agent",
  needs_review: "human",
  ready_to_build: "agent",
  failed: "bad",
  draft_pr: "machine",
  checks_running: "machine",
  checks_failed: "bad",
  awaiting_review: "human",
  shipped_recently: "ok",
};

export function pipelineStageStateLabel(
  stage: PipelineStageKey,
  state: PipelineStageState,
  count: number,
) {
  switch (state) {
    case "ready_to_plan":
      return "Ready to plan";
    case "needs_attention":
      return "Need attention";
    case "in_progress":
      return "In progress";
    case "needs_review":
      return "Need plan review";
    case "ready_to_build":
      return "Ready to build";
    case "failed":
      if (stage === "planning") return count === 1 ? "Plan failed" : "Plans failed";
      if (stage === "building") return count === 1 ? "Build failed" : "Builds failed";
      return count === 1 ? "Review failed" : "Reviews failed";
    case "draft_pr":
      return count === 1 ? "Draft PR" : "Draft PRs";
    case "checks_running":
      return "Checks running";
    case "checks_failed":
      return "Checks failed";
    case "awaiting_review":
      return "Awaiting your review";
    case "shipped_recently":
      return "Shipped this week";
  }
}

export function pipelineStageStateTone(state: PipelineStageState) {
  return STATUS_TONE[state];
}

export function pipelineStageSummaries(stage: PipelineStage) {
  const countByState = new Map<PipelineStageState, number>();
  for (const story of stage.stories) {
    countByState.set(story.stageState, (countByState.get(story.stageState) ?? 0) + 1);
  }
  return STATUS_ORDER[stage.key]
    .map((state) => ({
      state,
      count: countByState.get(state) ?? 0,
      label: pipelineStageStateLabel(stage.key, state, countByState.get(state) ?? 0),
      tone: pipelineStageStateTone(state),
    }))
    .filter((summary) => summary.count > 0);
}

/** Stable story identity for projects that mirror more than one repository. */
function storyQuery(story: Pick<PipelineStory, "repoId" | "storyType">) {
  return new URLSearchParams({ repoId: story.repoId, storyType: story.storyType }).toString();
}

export function storyHref(
  projectId: string,
  story: Pick<PipelineStory, "number" | "repoId" | "storyType">,
) {
  return `/projects/${projectId}/stories/${story.number}?${storyQuery(story)}`;
}

export type BoardFilter = {
  stage?: PipelineStageKey | null;
  status?: PipelineStageState | null;
  mine?: boolean;
};

/** The stories board URL for a given combination of filter chips. */
export function boardHref(projectId: string, filter: BoardFilter = {}) {
  const params = new URLSearchParams();
  if (filter.stage) params.set("stage", filter.stage);
  if (filter.status) params.set("status", filter.status);
  if (filter.mine) params.set("mine", "1");
  const query = params.toString();
  return `/projects/${projectId}/stories${query ? `?${query}` : ""}`;
}

/** Whether a story's assignees include the signed-in viewer, by GitHub login. */
export function ownedBy(assignees: string[], login: string | undefined): boolean {
  if (!login) return false;
  const target = login.toLowerCase();
  return assignees.some((assignee) => assignee.toLowerCase() === target);
}

/**
 * Whether the mine filter should actually apply. It is inert — never on —
 * for a viewer with no GitHub login to match against, even if `?mine=1`
 * is already sitting in the URL (a shared link, a bookmark, browser
 * history), so such a viewer is never trapped on a board with every
 * story filtered out and no chip left to undo it.
 */
export function mineFilterOn(mine: string | undefined, login: string | undefined): boolean {
  return mine === "1" && Boolean(login);
}

export type StoryOwner = { login: string; extra: number };

/** The story's lead assignee, GitHub-ordered, with a count of the rest. */
export function storyOwner(assignees: string[]): StoryOwner | null {
  const logins = assignees.map((login) => login.trim()).filter(Boolean);
  const [login] = logins;
  if (!login) return null;
  return { login, extra: logins.length - 1 };
}

/**
 * GitHub serves an avatar for any login at this path, so no avatar URL has to
 * travel on the wire. It 302s to `avatars.githubusercontent.com`.
 *
 * `?size=40` rather than the 14–20 CSS px we draw at, so 2× displays stay sharp.
 */
export function avatarUrlFor(login: string): string | null {
  const trimmed = login.trim();
  if (!trimmed) return null;
  return `https://github.com/${encodeURIComponent(trimmed)}.png?size=40`;
}

/** The letter an avatar falls back to when there is no image to draw. */
export function avatarInitial(value: string | null | undefined): string {
  const trimmed = (value ?? "").trim();
  // Spread, not `[0]`, so an astral first character survives intact.
  const [first] = [...trimmed];
  return first ? first.toUpperCase() : "?";
}

export function pipelineStories(pipeline: Pipeline): PipelineStory[] {
  return pipeline.stages.flatMap((stage) => stage.stories);
}

/** Open, non-draft pull requests that are genuinely waiting on a human review. */
export function reviewablePullRequests<Story extends Pick<PipelineStory, "repoId" | "prs">>(
  stories: Story[],
) {
  return [
    ...new Map(
      stories.flatMap((story) =>
        story.prs
          .filter((pull) => pull.state === "open" && !pull.draft)
          .map((pull) => [`${story.repoId}:${pull.number}`, { story, pull }] as const),
      ),
    ).values(),
  ];
}
