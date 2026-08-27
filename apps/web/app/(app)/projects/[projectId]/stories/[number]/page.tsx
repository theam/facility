import { Eyebrow, PillTag, StatusDot } from "@facility/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CiStatusLink } from "@/components/ci-status";
import { Markdown } from "@/components/markdown";
import { ErrorNotice, Offline } from "@/components/offline";
import { LiveRefresh } from "@/components/shell/live-refresh";
import { PullRequestLinks } from "@/components/story/pull-request-links";
import { StoryTimeline } from "@/components/story/timeline";
import { StoryTriggerButtons } from "@/components/story/trigger-buttons";
import { api } from "@/lib/api";
import { pipelineStories } from "@/lib/pipeline";
import {
  detachablePullRequests,
  linkableIssues,
  linkablePullRequests,
} from "@/lib/pull-request-links";
import { deriveStoryTimeline, proposalsForStory } from "@/lib/story";
import { createStoryReferenceLink } from "@/lib/story-reference";

export async function generateMetadata({ params }: { params: Promise<{ number: string }> }) {
  const { number } = await params;
  return { title: `story #${number}` };
}

export default async function StoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; number: string }>;
  searchParams: Promise<{ repoId?: string; storyType?: string }>;
}) {
  const [{ projectId, number: rawNumber }, identity] = await Promise.all([params, searchParams]);
  const number = Number.parseInt(rawNumber, 10);
  if (!Number.isFinite(number)) notFound();
  const storyType =
    identity.storyType === "issue" || identity.storyType === "pull_request"
      ? identity.storyType
      : undefined;
  const query: { repoId?: string; storyType?: "issue" | "pull_request" } = {
    ...(identity.repoId ? { repoId: identity.repoId } : {}),
    ...(storyType ? { storyType } : {}),
  };

  const [detail, inbox, outcomes, activity, pipeline, me, project] = await Promise.all([
    api.story(projectId, number, query),
    api.inboxAll(),
    api.outcomes(`?state=all&projectId=${projectId}&limit=200`),
    api.storyGithubActivity(projectId, number, query),
    api.pipeline(projectId),
    api.me(),
    api.project(projectId),
  ]);

  if (!detail.ok) {
    if (detail.offline) return <Offline />;
    if (detail.status === 404) notFound();
    if (detail.status === 409) {
      return (
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          <Eyebrow>story</Eyebrow>
          <h1 className="text-[clamp(20px,3vw,30px)] font-semibold tracking-tight">
            Choose the repository for story #{number}
          </h1>
          <p className="max-w-xl text-sm leading-relaxed text-(--dim)">
            More than one connected repository uses this story number. Open the story from the
            repository-qualified list so Facility can select the right one.
          </p>
          <Link
            href={`/projects/${projectId}/stories`}
            className="w-fit font-mono text-[11px] text-(--mut) underline-offset-4 hover:text-(--ink) hover:underline"
          >
            ← all stories
          </Link>
        </div>
      );
    }
    return <ErrorNotice message={`Couldn't load this story — ${detail.message}`} />;
  }

  const story = detail.data;
  const linkReference = createStoryReferenceLink({
    projectId,
    currentStory: story,
    stories: pipeline.ok ? pipelineStories(pipeline.data) : [],
  });
  const proposals = (inbox.ok ? inbox.data : []).filter(
    (proposal) => proposal.projectId === projectId,
  );
  const allowLegacyProposalNumber = story.allowLegacyProposalNumber;
  const storyProposals = proposalsForStory(proposals, story, allowLegacyProposalNumber);
  const comments = activity.ok ? activity.data.comments : [];
  const activityPrs = activity.ok ? activity.data.prs : [];
  const stageLabels = new Map(story.pipelineStages.map((stage) => [stage.key, stage.label]));
  const timeline = deriveStoryTimeline({
    detail: story,
    proposals,
    outcomes: outcomes.ok ? outcomes.data : [],
    comments,
    prs: activity.ok ? activityPrs : undefined,
    ciEvents: activity.ok ? activity.data.ciEvents : undefined,
    allowLegacyProposalNumber,
    stageLabels,
  });
  const stage = story.stage;

  const prLinks = new Map<number, string>();
  for (const pr of story.prs) prLinks.set(pr.number, pr.url);
  for (const pr of activityPrs) prLinks.set(pr.number, pr.url);

  const permissions = me.ok ? me.data.permissions : [];
  const has = (permission: string) =>
    permissions.some(
      (candidate) =>
        candidate === "*" ||
        candidate === permission ||
        candidate === `${permission.split(":")[0]}:*`,
    );
  const stories = pipeline.ok ? pipelineStories(pipeline.data) : [];
  const issueCandidates = linkableIssues(stories, story.repoId);
  const pullCandidates = linkablePullRequests(stories, story.repoId);
  const detachablePulls =
    story.storyType === "issue" ? detachablePullRequests(story.number, story.prs) : [];

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-8">
      <LiveRefresh seconds={15} />

      <div className="flex flex-col gap-3">
        <Eyebrow>story</Eyebrow>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <h1 className="flex min-w-0 items-baseline gap-3 text-[clamp(18px,2.4vw,26px)] font-semibold tracking-tight">
            <span className="shrink-0 font-mono text-[0.72em] font-normal text-(--dim)">
              {story.repoOwner}/{story.repoName}#{story.number}
            </span>
            <span className="min-w-0">{story.title}</span>
          </h1>
          {has("runs:trigger") && story.storyType === "issue" && story.state === "open" ? (
            <StoryTriggerButtons
              projectId={projectId}
              issueNumber={story.number}
              repoId={story.repoId}
              builderPlanRequired={!project.ok || project.data.builderPlanPolicy === "required"}
            />
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="flex items-center gap-2">
            <StatusDot
              tone={story.state === "open" ? "human" : story.state === "merged" ? "ok" : "machine"}
            />
            <span className="text-[12px] font-medium text-(--mut)">{story.state}</span>
          </span>
          {stage ? <PillTag>{stage.label}</PillTag> : null}
          {story.ciState && story.ciUrl ? (
            <CiStatusLink
              state={story.ciState}
              url={story.ciUrl}
              failureNames={story.ciFailureNames}
            />
          ) : null}
          {story.labels.slice(0, 4).map((label) => (
            <span
              key={label}
              className="border border-(--line) px-1.5 py-0.5 font-mono text-[10px] text-(--dim)"
            >
              {label}
            </span>
          ))}
          <a
            href={story.htmlUrl}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[11px] text-(--mut) underline-offset-4 hover:text-(--ink) hover:underline"
          >
            {story.storyType === "issue" ? "issue" : "PR"} #{story.number} ↗
          </a>
          {[...prLinks.entries()]
            .sort(([a], [b]) => a - b)
            .map(([prNumber, url]) =>
              story.storyType === "pull_request" && prNumber === story.number ? null : (
                <a
                  key={prNumber}
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-[11px] text-(--mut) underline-offset-4 hover:text-(--ink) hover:underline"
                >
                  PR #{prNumber} ↗
                </a>
              ),
            )}
          {storyProposals.some((proposal) => proposal.state === "open") ? (
            <span className="font-mono text-[11px] text-(--human)">waiting on you</span>
          ) : null}
        </div>
      </div>

      {has("repos:write") ? (
        <PullRequestLinks
          projectId={projectId}
          repoId={story.repoId}
          storyType={story.storyType}
          storyNumber={story.number}
          issueCandidates={issueCandidates}
          pullCandidates={pullCandidates}
          detachablePulls={detachablePulls}
        />
      ) : null}

      {story.bodyMd?.trim() ? (
        <details open className="border border-(--line) bg-(--bg-subtle)">
          <summary className="cursor-pointer px-4 py-2.5 font-mono text-[11px] text-(--dim) hover:text-(--ink)">
            {story.storyType === "issue" ? "issue" : "PR"} body
          </summary>
          <div className="border-t border-(--line) px-5 py-4">
            <Markdown source={story.bodyMd} linkReference={linkReference} />
          </div>
        </details>
      ) : null}

      <div className="flex flex-col gap-4">
        <Eyebrow>timeline</Eyebrow>
        <StoryTimeline
          projectId={projectId}
          items={timeline}
          canDecide={has("hitl:decide")}
          linkReference={linkReference}
        />
      </div>

      <p className="text-[11.5px] text-(--dim)">
        <Link
          href={`/projects/${projectId}/stories`}
          className="underline-offset-4 hover:underline"
        >
          ← all stories
        </Link>
      </p>
    </div>
  );
}
