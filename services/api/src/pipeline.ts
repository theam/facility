/** Server-owned story assembly and pipeline classification. */

import { validateWsjf, type WsjfInput } from "@facility/harness";

export type StoryWsjf = WsjfInput & { score: number };

export type PipelineStage =
  | "backlog"
  | "planning"
  | "building"
  | "validating"
  | "review"
  | "shipped";

export type PipelineStageState =
  | "ready_to_plan"
  | "needs_attention"
  | "in_progress"
  | "needs_review"
  | "ready_to_build"
  | "failed"
  | "draft_pr"
  | "checks_running"
  | "checks_failed"
  | "awaiting_review"
  | "shipped_recently";

export type StageKind = "human" | "agent" | "machine" | "done";

export const PIPELINE_STAGES = [
  { key: "backlog", label: "Backlog", sub: "work not started", kind: "human" },
  { key: "planning", label: "Planning", sub: "shape the approach", kind: "agent" },
  { key: "building", label: "Building", sub: "implement the plan", kind: "agent" },
  { key: "validating", label: "Validating", sub: "run the checks", kind: "machine" },
  { key: "review", label: "In review", sub: "review and merge", kind: "human" },
  { key: "shipped", label: "Shipped", sub: "merged · last 7 days", kind: "done" },
] as const satisfies ReadonlyArray<{
  key: PipelineStage;
  label: string;
  sub: string;
  kind: StageKind;
}>;

export type PipelineRun = {
  id: string;
  mode: string;
  status: string;
  engine: string;
  pr?: unknown;
  gh?: unknown;
};

export type PipelinePullRequest = {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  headSha: string | null;
  ciState: "pending" | "success" | "failure" | null;
  ciHeadSha: string | null;
  ciFailureNames: string[];
  createdAt: Date | null;
  closedAt: Date | null;
  mergedAt: Date | null;
  closingIssues: number[];
};

export type PipelineStoryInput = {
  key: string;
  id: string;
  storyType: "issue" | "pull_request";
  repoId: string;
  repoOwner: string;
  repoName: string;
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  labels: string[];
  assignees: string[];
  author: string | null;
  htmlUrl: string;
  commentsCount: number;
  ghCreatedAt: Date | null;
  ghUpdatedAt: Date | null;
  closedAt: Date | null;
  wsjf: StoryWsjf | null;
  linkedRuns: PipelineRun[];
  prs: PipelinePullRequest[];
};

export type PlacedPipelineStory = Omit<PipelineStoryInput, "linkedRuns"> & {
  stageState: PipelineStageState;
  runState: "live" | "failed" | null;
  currentRun: { id: string; mode: string; status: string; engine: string } | null;
  attemptCount: number;
  ciState: "pending" | "success" | "failure" | null;
  ciUrl: string | null;
  ciFailureNames: string[];
};

export type PipelineIssueRecord = {
  id: string;
  repoId: string;
  number: number;
  title: string;
  state: string;
  labels: unknown;
  assignees: unknown;
  author: string | null;
  htmlUrl: string;
  bodyMd: string | null;
  commentsCount: number;
  ghCreatedAt: Date | null;
  ghUpdatedAt: Date | null;
  closedAt: Date | null;
};

export type PipelinePullRequestRecord = {
  id: string;
  repoId: string;
  number: number;
  title: string;
  state: string;
  draft: boolean;
  author: string | null;
  htmlUrl: string;
  headSha: string;
  ciState: string | null;
  ciHeadSha: string | null;
  ciFailureNames: string[];
  closingIssues: number[];
  ghCreatedAt: Date | null;
  ghUpdatedAt: Date | null;
  closedAt: Date | null;
  mergedAt: Date | null;
};

export type PipelineRepoRecord = { id: string; owner: string; name: string };

/**
 * A PO task as Facility recorded it: `wsjf` is the accepted judgement and `gh`
 * is the provenance Facility wrote when it created the mirrored issue. This —
 * not the world-writable issue body — is what a story's rank binds to.
 */
export type PipelineTaskRecord = { wsjf: unknown; gh: unknown };

export type PipelineRunRecord = PipelineRun & { gh: unknown };

export type PipelineAssembly = {
  stories: PipelineStoryInput[];
  storyKeysByRunId: Map<string, Set<string>>;
};

const LIVE = new Set(["queued", "provisioning", "running"]);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function assemblePipelineStories(input: {
  issues: PipelineIssueRecord[];
  pullRequests: PipelinePullRequestRecord[];
  repos: PipelineRepoRecord[];
  runs: PipelineRunRecord[];
  tasks?: PipelineTaskRecord[];
}): PipelineAssembly {
  const reposById = new Map(input.repos.map((repo) => [repo.id, repo]));
  const repoIdByName = new Map(
    input.repos.map((repo) => [`${repo.owner}/${repo.name}`.toLowerCase(), repo.id]),
  );

  // Scores bind to the judgement Facility itself recorded on the PO task,
  // located through the `gh` provenance written when the issue was created.
  // The `## Value` block mirrored into the issue body is world-writable —
  // any issue author can edit it — so it never ranks a story. Records that
  // fail the canonical schema, or whose score is not finite, stay unscored.
  // Callers pass tasks newest-first; the first canonical record per issue wins.
  const wsjfByIssue = new Map<string, StoryWsjf>();
  for (const task of input.tasks ?? []) {
    const gh = objectValue(task.gh);
    const fullName = stringValue(gh.repo);
    const issueNumber = numberValue(gh.issue_number);
    const repoId = fullName ? repoIdByName.get(fullName.toLowerCase()) : null;
    if (!repoId || !issueNumber) continue;
    const scored = validateWsjf(task.wsjf);
    if (!scored) continue;
    const key = repoNumberKey(repoId, issueNumber);
    if (!wsjfByIssue.has(key)) wsjfByIssue.set(key, scored);
  }
  const stories = new Map<string, PipelineStoryInput>();
  const issueKeyByRepoNumber = new Map<string, string>();
  const storyKeysByPull = new Map<string, Set<string>>();
  const storyKeysByRunId = new Map<string, Set<string>>();
  const runIssueNumbersByPull = new Map<string, Set<number>>();

  // Facility already knows which issue produced a PR before GitHub has
  // necessarily indexed a closing reference. Preserve that provenance as a
  // fallback so a mirrored PR cannot temporarily split into an orphan story.
  for (const run of input.runs) {
    const gh = objectValue(run.gh);
    const owner = stringValue(gh.owner);
    const repoName = stringValue(gh.repo);
    const repoId =
      owner && repoName ? repoIdByName.get(`${owner}/${repoName}`.toLowerCase()) : null;
    const issueNumber = numberValue(gh.issueNumber);
    const pullNumber = numberValue(objectValue(gh.pr).number);
    if (!repoId || !issueNumber || !pullNumber) continue;
    const key = repoNumberKey(repoId, pullNumber);
    const issueNumbers = runIssueNumbersByPull.get(key) ?? new Set<number>();
    issueNumbers.add(issueNumber);
    runIssueNumbersByPull.set(key, issueNumbers);
  }

  for (const issue of input.issues) {
    const repo = reposById.get(issue.repoId);
    if (!repo) continue;
    const key = storyKey(issue.repoId, "issue", issue.number);
    issueKeyByRepoNumber.set(repoNumberKey(issue.repoId, issue.number), key);
    stories.set(key, {
      key,
      id: issue.id,
      storyType: "issue",
      repoId: issue.repoId,
      repoOwner: repo.owner,
      repoName: repo.name,
      number: issue.number,
      title: issue.title,
      state: issue.state === "closed" ? "closed" : "open",
      labels: stringArray(issue.labels),
      assignees: stringArray(issue.assignees),
      author: issue.author,
      htmlUrl: issue.htmlUrl,
      commentsCount: issue.commentsCount,
      ghCreatedAt: issue.ghCreatedAt,
      ghUpdatedAt: issue.ghUpdatedAt,
      closedAt: issue.closedAt,
      wsjf: wsjfByIssue.get(repoNumberKey(issue.repoId, issue.number)) ?? null,
      linkedRuns: [],
      prs: [],
    });
  }

  for (const pull of input.pullRequests) {
    const repo = reposById.get(pull.repoId);
    if (!repo) continue;
    const pullKey = repoNumberKey(pull.repoId, pull.number);
    const linkedStoryKeys = new Set<string>();
    const linkToIssue = (issueNumber: number) => {
      const issueKey = issueKeyByRepoNumber.get(repoNumberKey(pull.repoId, issueNumber));
      const issueStory = issueKey ? stories.get(issueKey) : null;
      if (!issueKey || !issueStory || linkedStoryKeys.has(issueKey)) return;
      issueStory.prs.push(pullRequestOf(pull));
      linkedStoryKeys.add(issueKey);
    };
    for (const issueNumber of pull.closingIssues) linkToIssue(issueNumber);
    if (linkedStoryKeys.size === 0) {
      for (const issueNumber of runIssueNumbersByPull.get(pullKey) ?? []) {
        linkToIssue(issueNumber);
      }
    }
    if (linkedStoryKeys.size === 0) {
      const key = storyKey(pull.repoId, "pull_request", pull.number);
      stories.set(key, {
        key,
        id: pull.id,
        storyType: "pull_request",
        repoId: pull.repoId,
        repoOwner: repo.owner,
        repoName: repo.name,
        number: pull.number,
        title: pull.title,
        state: pullRequestState(pull.state),
        labels: [],
        assignees: [],
        author: pull.author,
        htmlUrl: pull.htmlUrl,
        commentsCount: 0,
        ghCreatedAt: pull.ghCreatedAt,
        ghUpdatedAt: pull.ghUpdatedAt,
        closedAt: pull.mergedAt ?? pull.closedAt,
        wsjf: null,
        linkedRuns: [],
        prs: [pullRequestOf(pull)],
      });
      linkedStoryKeys.add(key);
    }
    storyKeysByPull.set(pullKey, linkedStoryKeys);
  }

  for (const run of input.runs) {
    const gh = objectValue(run.gh);
    const owner = stringValue(gh.owner);
    const repoName = stringValue(gh.repo);
    const repoId =
      owner && repoName ? repoIdByName.get(`${owner}/${repoName}`.toLowerCase()) : null;
    if (!repoId) continue;
    const keys = new Set<string>();
    const issueNumber = numberValue(gh.issueNumber);
    if (issueNumber) {
      const directIssue = issueKeyByRepoNumber.get(repoNumberKey(repoId, issueNumber));
      if (directIssue) keys.add(directIssue);
      for (const key of storyKeysByPull.get(repoNumberKey(repoId, issueNumber)) ?? [])
        keys.add(key);
    }
    const runPr = objectValue(gh.pr);
    const runPrNumber = numberValue(runPr.number);
    if (runPrNumber) {
      const mirroredKeys = storyKeysByPull.get(repoNumberKey(repoId, runPrNumber));
      if (mirroredKeys) {
        for (const key of mirroredKeys) keys.add(key);
      } else {
        const directIssue = issueNumber
          ? issueKeyByRepoNumber.get(repoNumberKey(repoId, issueNumber))
          : null;
        const issueStory = directIssue ? stories.get(directIssue) : null;
        const url = stringValue(runPr.url);
        if (issueStory && url && !issueStory.prs.some((pull) => pull.number === runPrNumber)) {
          issueStory.prs.push({
            number: runPrNumber,
            title: `PR #${runPrNumber}`,
            url,
            state: "open",
            draft: false,
            headSha: null,
            ciState: null,
            ciHeadSha: null,
            ciFailureNames: [],
            createdAt: null,
            closedAt: null,
            mergedAt: null,
            closingIssues: [],
          });
        }
      }
    }
    for (const key of keys) {
      const story = stories.get(key);
      if (story && !story.linkedRuns.some((candidate) => candidate.id === run.id)) {
        story.linkedRuns.push(run);
      }
    }
    if (keys.size > 0) storyKeysByRunId.set(run.id, keys);
  }

  for (const story of stories.values()) {
    story.prs.sort((a, b) => a.number - b.number);
  }
  return { stories: [...stories.values()], storyKeysByRunId };
}

export function classifyPipeline(
  stories: PipelineStoryInput[],
  proposalStoryKeys: ReadonlySet<string>,
  now = Date.now(),
): Map<PipelineStage, PlacedPipelineStory[]> {
  const stages = new Map<PipelineStage, PlacedPipelineStory[]>(
    PIPELINE_STAGES.map((stage) => [stage.key, []]),
  );
  for (const story of stories) {
    if (story.state === "open") {
      const { stage, placed } = placeOpen(story, proposalStoryKeys.has(story.key));
      stages.get(stage)?.push(placed);
      continue;
    }
    const shipped =
      story.storyType === "issue" ? story.state === "closed" : story.state === "merged";
    const closedStamp = story.closedAt ?? story.ghUpdatedAt;
    if (shipped && closedStamp && now - closedStamp.getTime() < WEEK_MS) {
      stages.get("shipped")?.push(placeBase(story, "shipped_recently"));
    }
  }
  for (const [stage, placed] of stages) {
    placed.sort(stage === "shipped" ? byRecency : byPriority);
  }
  return stages;
}

/** Shipped is a log, not a queue: most recently touched on top. */
function byRecency(left: PlacedPipelineStory, right: PlacedPipelineStory) {
  return (
    (right.ghUpdatedAt?.getTime() ?? 0) - (left.ghUpdatedAt?.getTime() ?? 0) ||
    right.number - left.number ||
    right.repoId.localeCompare(left.repoId)
  );
}

/**
 * Active stages order by the WSJF judgement Facility recorded on the PO task,
 * not by last activity — a comment, a label, or Facility's own acknowledgement
 * must not reorder a stage, and neither can an edited issue body. Unscored
 * stories sit below scored ones and keep GitHub's own newest-created-first
 * grammar.
 */
function byPriority(left: PlacedPipelineStory, right: PlacedPipelineStory) {
  if (left.wsjf || right.wsjf) {
    if (!right.wsjf) return -1;
    if (!left.wsjf) return 1;
    if (right.wsjf.score !== left.wsjf.score) return right.wsjf.score - left.wsjf.score;
  }
  return (
    (right.ghCreatedAt?.getTime() ?? 0) - (left.ghCreatedAt?.getTime() ?? 0) ||
    right.number - left.number ||
    right.repoId.localeCompare(left.repoId)
  );
}

function placeOpen(
  story: PipelineStoryInput,
  hasOpenProposal: boolean,
): { stage: PipelineStage; placed: PlacedPipelineStory } {
  const runs = [...story.linkedRuns].sort((a, b) => a.id.localeCompare(b.id));
  const current = runs.at(-1) ?? null;
  if (current && LIVE.has(current.status)) {
    return {
      stage: stageForMode(current),
      placed: { ...placeBase(story, "in_progress"), runState: "live" },
    };
  }
  if (current?.status === "failed") {
    return {
      stage: stageForMode(current),
      placed: { ...placeBase(story, "failed"), runState: "failed" },
    };
  }
  const openPulls = story.prs.filter((pull) => pull.state === "open");
  const reviewablePulls = openPulls.filter((pull) => !pull.draft);
  const checksFailed = reviewablePulls.some(hasCurrentCiState("failure"));
  if (checksFailed) {
    return { stage: "validating", placed: placeBase(story, "checks_failed") };
  }
  const pending = reviewablePulls.some(hasCurrentCiState("pending"));
  if (pending) return { stage: "validating", placed: placeBase(story, "checks_running") };
  const builderDelivered = runs.some(
    (run) =>
      isMode(run, "builder") &&
      run.status === "succeeded" &&
      numberValue(objectValue(objectValue(run.gh).pr).number) !== null,
  );
  if (reviewablePulls.length > 0) {
    return { stage: "review", placed: placeBase(story, "awaiting_review") };
  }
  if (openPulls.some((pull) => pull.draft)) {
    return { stage: "building", placed: placeBase(story, "draft_pr") };
  }
  if (builderDelivered) {
    return { stage: "review", placed: placeBase(story, "awaiting_review") };
  }
  const planPublished = runs.some((run) => isMode(run, "architect") && run.status === "succeeded");
  if (hasOpenProposal) {
    return { stage: "planning", placed: placeBase(story, "needs_review") };
  }
  if (planPublished) {
    return { stage: "planning", placed: placeBase(story, "ready_to_build") };
  }
  return {
    stage: "backlog",
    placed: placeBase(story, runs.length > 0 ? "needs_attention" : "ready_to_plan"),
  };
}

function placeBase(story: PipelineStoryInput, stageState: PipelineStageState): PlacedPipelineStory {
  const runs = [...story.linkedRuns].sort((a, b) => a.id.localeCompare(b.id));
  const current = runs.at(-1) ?? null;
  const reviewablePulls = story.prs.filter((pull) => pull.state === "open" && !pull.draft);
  const failedPull = reviewablePulls.find(hasCurrentCiState("failure"));
  const pendingPull = reviewablePulls.find(hasCurrentCiState("pending"));
  const successfulPull = reviewablePulls.find(hasCurrentCiState("success"));
  const ciPull = failedPull ?? pendingPull ?? successfulPull;
  const { linkedRuns: _linkedRuns, ...fields } = story;
  return {
    ...fields,
    stageState,
    runState: null,
    currentRun: current
      ? { id: current.id, mode: current.mode, status: current.status, engine: current.engine }
      : null,
    attemptCount: runs.length,
    ciState: failedPull ? "failure" : pendingPull ? "pending" : successfulPull ? "success" : null,
    ciUrl: ciPull ? `${ciPull.url}/checks` : null,
    ciFailureNames: failedPull?.ciFailureNames ?? [],
  };
}

function hasCurrentCiState(state: "pending" | "success" | "failure") {
  return (pull: PipelinePullRequest) =>
    pull.ciState === state &&
    Boolean(pull.headSha) &&
    Boolean(pull.ciHeadSha) &&
    pull.headSha === pull.ciHeadSha;
}

function stageForMode(run: PipelineRun): PipelineStage {
  if (isMode(run, "builder")) return "building";
  if (isMode(run, "review") || ["address-review", "address_review"].includes(run.mode)) {
    return "review";
  }
  return "planning";
}

function isMode(run: { mode: string }, name: string) {
  return run.mode === name || run.mode === `codex-${name}`;
}

function pullRequestOf(pull: PipelinePullRequestRecord): PipelinePullRequest {
  return {
    number: pull.number,
    title: pull.title,
    url: pull.htmlUrl,
    state: pullRequestState(pull.state),
    draft: pull.draft,
    headSha: pull.headSha,
    ciState:
      pull.ciState === "pending" || pull.ciState === "success" || pull.ciState === "failure"
        ? pull.ciState
        : null,
    ciHeadSha: pull.ciHeadSha,
    ciFailureNames: pull.ciFailureNames,
    createdAt: pull.ghCreatedAt,
    closedAt: pull.closedAt,
    mergedAt: pull.mergedAt,
    closingIssues: pull.closingIssues,
  };
}

function pullRequestState(value: string): "open" | "closed" | "merged" {
  if (value === "merged") return "merged";
  if (value === "closed") return "closed";
  return "open";
}

function storyKey(repoId: string, type: "issue" | "pull_request", number: number) {
  return `${repoId}:${type}:${number}`;
}

function repoNumberKey(repoId: string, number: number) {
  return `${repoId}:${number}`;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}
