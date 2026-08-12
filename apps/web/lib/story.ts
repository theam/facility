import type { Outcome, PipelineStageKey, Proposal, StoryDetail, StoryGithubActivity } from "./api";

/** A story is its mirrored GitHub life, Facility runs, and human gates in one chronology. */
export type StoryRun = StoryDetail["runs"][number];
export type StoryComment = StoryGithubActivity["comments"][number];
export type StoryPr = StoryGithubActivity["prs"][number];
export type StoryCiEvent = StoryGithubActivity["ciEvents"][number];

// Timeline replay is intentionally not the current-state classifier, but it
// must acknowledge every server-published stage when the generated union grows.
const TIMELINE_STAGES: Record<PipelineStageKey, PipelineStageKey> = {
  backlog: "backlog",
  planning: "planning",
  building: "building",
  validating: "validating",
  review: "review",
  shipped: "shipped",
};

export type StoryItem =
  | {
      kind: "story_opened";
      ts: string;
      author: string | null;
      storyType: StoryDetail["storyType"];
    }
  | { kind: "run"; ts: string | null; run: StoryRun }
  | { kind: "proposal"; ts: string; proposal: Proposal }
  | { kind: "proposal_decided"; ts: string; proposal: Proposal }
  | { kind: "comment"; ts: string; comment: StoryComment }
  | { kind: "pr_opened"; ts: string; outcome: Outcome | null; pr: StoryPr }
  | { kind: "pr_closed"; ts: string; outcome: Outcome | null; pr: StoryPr }
  | { kind: "ci"; ts: string; event: StoryCiEvent; pr: StoryPr }
  | { kind: "issue_closed"; ts: string }
  | { kind: "stage"; ts: string; stage: PipelineStageKey; label: string };

function stamp(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return null;
}

/**
 * Old proposals only carry an issue number. Associate those only when that
 * number is unique in the project; new proposal payloads may carry repoId.
 */
export function proposalsForStory(
  proposals: Proposal[],
  detail: StoryDetail,
  allowLegacyNumber: boolean,
): Proposal[] {
  const runIds = new Set(detail.runs.map((run) => run.id));
  return proposals.filter((proposal) => {
    if (proposal.runId && runIds.has(proposal.runId)) return true;
    // Number-only and repo-qualified payloads describe issue mutations. A PR
    // story can still own a human gate through the run that opened it.
    if (detail.storyType !== "issue") return false;
    const payload = proposal.payload as { issueNumber?: number; repoId?: string } | null;
    if (payload?.issueNumber !== detail.number) return false;
    return payload.repoId ? payload.repoId === detail.repoId : allowLegacyNumber;
  });
}

function isMode(mode: string, name: string) {
  return mode === name || mode === `codex-${name}`;
}

function stageEntered(item: StoryItem): PipelineStageKey | null {
  switch (item.kind) {
    case "story_opened":
      return TIMELINE_STAGES.backlog;
    case "run": {
      if (isMode(item.run.mode, "builder")) return TIMELINE_STAGES.building;
      if (
        isMode(item.run.mode, "review") ||
        item.run.mode === "address-review" ||
        item.run.mode === "address_review"
      ) {
        return TIMELINE_STAGES.review;
      }
      if (isMode(item.run.mode, "architect")) return TIMELINE_STAGES.planning;
      return null;
    }
    case "proposal":
      return item.proposal.actionType === "plan_acceptance" ? TIMELINE_STAGES.planning : null;
    case "pr_opened":
      if (item.pr.draft) return TIMELINE_STAGES.building;
      return item.pr.ciState === "pending" ? TIMELINE_STAGES.validating : TIMELINE_STAGES.review;
    case "pr_closed":
      return item.pr.state === "merged" ? TIMELINE_STAGES.shipped : null;
    case "ci":
      return item.event.state === "pending" ? TIMELINE_STAGES.validating : TIMELINE_STAGES.review;
    case "issue_closed":
      return TIMELINE_STAGES.shipped;
    default:
      return null;
  }
}

export function deriveStoryTimeline(input: {
  detail: StoryDetail;
  proposals: Proposal[];
  outcomes: Outcome[];
  comments?: StoryComment[];
  prs?: StoryPr[];
  ciEvents?: StoryCiEvent[];
  allowLegacyProposalNumber: boolean;
  stageLabels: ReadonlyMap<PipelineStageKey, string>;
}): StoryItem[] {
  const { detail } = input;
  const items: StoryItem[] = [];

  const opened = stamp(detail.ghCreatedAt);
  if (opened) {
    items.push({
      kind: "story_opened",
      ts: opened,
      author: detail.author,
      storyType: detail.storyType,
    });
  }

  for (const run of detail.runs) items.push({ kind: "run", ts: stamp(run.startedAt), run });

  for (const proposal of proposalsForStory(
    input.proposals,
    detail,
    input.allowLegacyProposalNumber,
  )) {
    const created = stamp(proposal.createdAt);
    if (created) items.push({ kind: "proposal", ts: created, proposal });
    const decided = stamp(proposal.decidedAt);
    if (decided) items.push({ kind: "proposal_decided", ts: decided, proposal });
  }

  for (const comment of input.comments ?? []) {
    items.push({ kind: "comment", ts: comment.createdAt, comment });
  }

  const outcomesByPull = new Map(
    input.outcomes
      .filter(
        (outcome) =>
          outcome.repo.toLowerCase() === `${detail.repoOwner}/${detail.repoName}`.toLowerCase(),
      )
      .map((outcome) => [outcome.prNumber, outcome]),
  );
  const detailPulls = new Map(detail.prs.map((pull) => [pull.number, pull]));
  const timelinePulls =
    input.prs ??
    detail.prs.map((pull) => ({
      number: pull.number,
      title: pull.title,
      bodyMd: "",
      author: "unknown",
      url: pull.url,
      state: pull.state,
      draft: pull.draft,
      createdAt: stamp(pull.createdAt),
      closedAt: stamp(pull.closedAt),
      mergedAt: stamp(pull.mergedAt),
      ciState: pull.ciState,
      ciFailureNames: pull.ciFailureNames,
    }));
  const ciEventPullNumbers = new Set((input.ciEvents ?? []).map((event) => event.pullNumber));
  const timelinePullsByNumber = new Map(timelinePulls.map((pull) => [pull.number, pull]));
  for (const pr of timelinePulls) {
    const outcome = outcomesByPull.get(pr.number) ?? null;
    const detailPull = detailPulls.get(pr.number);
    const currentCiState = detailPull
      ? detailPull.headSha && detailPull.ciHeadSha && detailPull.headSha === detailPull.ciHeadSha
        ? detailPull.ciState
        : null
      : pr.ciState;
    const timelinePr = {
      ...pr,
      ciState: ciEventPullNumbers.has(pr.number) ? null : currentCiState,
    };
    if (pr.createdAt) {
      items.push({ kind: "pr_opened", ts: pr.createdAt, outcome, pr: timelinePr });
    }
    const terminalAt = pr.mergedAt ?? pr.closedAt;
    if (terminalAt) items.push({ kind: "pr_closed", ts: terminalAt, outcome, pr: timelinePr });
  }

  for (const event of input.ciEvents ?? []) {
    const pr = timelinePullsByNumber.get(event.pullNumber);
    if (pr) items.push({ kind: "ci", ts: event.observedAt, event, pr });
  }

  const closed = stamp(detail.closedAt);
  if (detail.storyType === "issue" && detail.state === "closed" && closed) {
    items.push({ kind: "issue_closed", ts: closed });
  }

  items.sort((a, b) => {
    if (a.ts === null) return 1;
    if (b.ts === null) return -1;
    return Date.parse(a.ts) - Date.parse(b.ts);
  });

  const withStages: StoryItem[] = [];
  let stage: PipelineStageKey | null = null;
  for (const item of items) {
    const entered = item.ts === null ? null : stageEntered(item);
    if (entered && entered !== stage) {
      if (stage !== null) {
        withStages.push({
          kind: "stage",
          ts: item.ts as string,
          stage: entered,
          label: input.stageLabels.get(entered) ?? entered,
        });
      }
      stage = entered;
    }
    withStages.push(item);
  }
  return withStages;
}
