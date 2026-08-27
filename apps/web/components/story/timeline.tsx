import { StatusDot, toneFor } from "@facility/ui";
import Link from "next/link";
import { CiStatusLink } from "@/components/ci-status";
import { ProposalCard } from "@/components/inbox/proposal-card";
import { type LinkReference, Markdown } from "@/components/markdown";
import { RunOutcome } from "@/components/story/run-outcome";
import type { Proposal } from "@/lib/api";
import { fmtCost, fmtDuration } from "@/lib/runs";
import type { StoryItem, StoryRun } from "@/lib/story";

const TERMINAL = new Set(["succeeded", "failed"]);

/**
 * The story timeline: everything that happened to a unit of work, in order,
 * with the next pending human decision actionable inline (embedded proposal
 * cards). Server component — the interactive pieces are client children.
 */
export function StoryTimeline({
  projectId,
  items,
  canDecide,
  linkReference,
}: {
  projectId: string;
  items: StoryItem[];
  canDecide: boolean;
  linkReference: LinkReference;
}) {
  if (items.length === 0) {
    return (
      <p className="text-[12.5px] text-(--dim)">
        Nothing recorded yet — dispatch an architect to start this story.
      </p>
    );
  }
  return (
    <ol className="flex flex-col gap-6 border-l border-(--line)">
      {items.map((item) => (
        <li key={keyOf(item)} className="relative pl-6">
          <span
            aria-hidden
            className="absolute top-1.5 -left-[3.5px] h-[7px] w-[7px] border border-(--line-strong) bg-(--bg)"
          />
          <TimelineItem
            projectId={projectId}
            item={item}
            canDecide={canDecide}
            linkReference={linkReference}
          />
        </li>
      ))}
    </ol>
  );
}

/** Stable identity per item — every source row appears at most once per kind. */
function keyOf(item: StoryItem): string {
  switch (item.kind) {
    case "run":
      return `run-${item.run.id}`;
    case "proposal":
      return `proposal-${item.proposal.id}`;
    case "proposal_decided":
      return `decided-${item.proposal.id}`;
    case "comment":
      return `comment-${item.comment.id}`;
    case "pr_opened":
      return `pr-open-${item.pr.number}`;
    case "pr_closed":
      return `pr-closed-${item.pr.number}`;
    case "ci":
      return `ci-${item.event.id}`;
    case "stage":
      return `stage-${item.stage}-${item.ts}`;
    default:
      return item.kind;
  }
}

function TimelineItem({
  projectId,
  item,
  canDecide,
  linkReference,
}: {
  projectId: string;
  item: StoryItem;
  canDecide: boolean;
  linkReference: LinkReference;
}) {
  switch (item.kind) {
    case "story_opened":
      return (
        <MilestoneLine
          ts={item.ts}
          text={`${item.storyType === "issue" ? "issue" : "PR"} opened${
            item.author ? ` by ${item.author}` : ""
          }`}
        />
      );
    case "issue_closed":
      return <MilestoneLine ts={item.ts} text="issue closed" tone="ok" />;
    case "stage":
      return (
        <div className="flex items-center gap-2.5">
          <span aria-hidden className="font-mono text-[11px] text-(--dim)">
            →
          </span>
          <span className="border border-(--line-strong) px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-[0.08em] text-(--mut)">
            {item.label}
          </span>
          <Stamp ts={item.ts} />
        </div>
      );
    case "run":
      return <RunItem projectId={projectId} ts={item.ts} run={item.run} />;
    case "comment":
      return (
        <div className="flex flex-col gap-2 border border-(--line) px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <StatusDot tone="human" />
            <span className="font-mono text-[12px] text-(--ink)">{item.comment.author}</span>
            <span className="text-[11.5px] text-(--dim)">commented on GitHub</span>
            <a
              href={item.comment.url}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[10.5px] text-(--dim) hover:text-(--ink)"
            >
              ↗
            </a>
            <span className="ml-auto">
              <Stamp ts={item.ts} />
            </span>
          </div>
          <div className="text-[12.5px]">
            <Markdown source={item.comment.bodyMd} linkReference={linkReference} />
          </div>
        </div>
      );
    case "proposal":
      return item.proposal.state === "open" ? (
        // The actionable beat: the pending gate, decidable right here.
        <div className="flex flex-col gap-2">
          <MilestoneLine ts={item.ts} text="waiting on you" tone="human" />
          {canDecide ? (
            <ProposalCard proposal={item.proposal} />
          ) : (
            <p className="text-[12px] text-(--dim)">
              {humanizeAction(item.proposal.actionType)} — awaiting a decision
            </p>
          )}
        </div>
      ) : (
        <MilestoneLine
          ts={item.ts}
          text={`${humanizeAction(item.proposal.actionType)} proposed`}
          tone="human"
        />
      );
    case "proposal_decided":
      return (
        <MilestoneLine
          ts={item.ts}
          text={`${humanizeAction(item.proposal.actionType)} ${decisionOf(item.proposal)}`}
          tone={item.proposal.state === "rejected" ? "bad" : "ok"}
        />
      );
    case "pr_opened":
      return (
        <div className="flex flex-col gap-2 border border-(--line) px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <StatusDot tone="agent" />
            <a
              href={item.pr.url}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[12.5px] text-(--ink) underline-offset-4 hover:underline"
            >
              PR #{item.pr.number} ↗
            </a>
            {item.pr.title ? (
              <span className="min-w-0 truncate text-[12.5px] text-(--mut)">{item.pr.title}</span>
            ) : null}
            <span className="text-[11.5px] text-(--dim)">
              opened · {item.outcome?.agentLane ?? item.pr.author}
            </span>
            <span className="ml-auto">
              <Stamp ts={item.ts} />
            </span>
          </div>
          {item.pr.bodyMd.trim() ? (
            <details>
              <summary className="cursor-pointer font-mono text-[10.5px] text-(--dim) hover:text-(--ink)">
                PR description
              </summary>
              <div className="mt-2 border-t border-(--line) pt-3 text-[12.5px]">
                <Markdown source={item.pr.bodyMd} linkReference={linkReference} />
              </div>
            </details>
          ) : null}
        </div>
      );
    case "pr_closed":
      return (
        <MilestoneLine
          ts={item.ts}
          text={`PR #${item.pr.number} ${item.pr.state}${
            (item.outcome?.reviewRounds ?? 0) > 0
              ? ` · ${item.outcome?.reviewRounds} review round${item.outcome?.reviewRounds === 1 ? "" : "s"}`
              : ""
          }`}
          tone={item.pr.state === "merged" ? "ok" : "machine"}
        />
      );
    case "ci":
      return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <CiStatusLink
            state={item.event.state}
            url={`${item.pr.url}/checks`}
            failureNames={item.event.failureNames}
          />
          <span className="font-mono text-[10.5px] text-(--dim)">PR #{item.pr.number}</span>
          <Stamp ts={item.ts} />
        </div>
      );
    default:
      return null;
  }
}

function RunItem({ projectId, ts, run }: { projectId: string; ts: string | null; run: StoryRun }) {
  const cost = costOf(run);
  const failed = run.status === "failed";
  return (
    <div className="flex flex-col gap-2 border border-(--line) bg-(--bg-subtle) px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StatusDot tone={toneFor(run.status)} pulse={run.status === "running"} />
        <Link
          href={`/projects/${projectId}/sessions/${run.id}`}
          className="font-mono text-[12.5px] text-(--ink) underline-offset-4 hover:underline"
        >
          {run.mode}
        </Link>
        <span className={`text-[12px] ${failed ? "text-(--bad)" : "text-(--mut)"}`}>
          {run.status}
        </span>
        <span className="font-mono text-[10.5px] text-(--dim)">{run.engine}</span>
        {run.triggeredBy ? (
          <span className="font-mono text-[10.5px] text-(--dim)">by {run.triggeredBy}</span>
        ) : null}
        {run.startedAt ? (
          <span className="font-mono text-[10.5px] text-(--dim)">
            {fmtDuration(String(run.startedAt), run.endedAt ? String(run.endedAt) : null)}
          </span>
        ) : null}
        {cost ? <span className="font-mono text-[10.5px] text-(--dim)">{cost}</span> : null}
        <span className="ml-auto">
          <Stamp ts={ts} fallback="queued" />
        </span>
      </div>
      {TERMINAL.has(run.status) ? <RunOutcome runId={run.id} /> : null}
    </div>
  );
}

function MilestoneLine({
  ts,
  text,
  tone = "machine",
}: {
  ts: string | null;
  text: string;
  tone?: "ok" | "bad" | "human" | "machine";
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <StatusDot tone={tone} />
      <span className="text-[12.5px] text-(--mut)">{text}</span>
      <Stamp ts={ts} />
    </div>
  );
}

function Stamp({ ts, fallback = "" }: { ts: string | null; fallback?: string }) {
  if (!ts)
    return fallback ? (
      <span className="font-mono text-[10.5px] text-(--dim)">{fallback}</span>
    ) : null;
  return (
    <time dateTime={ts} className="font-mono text-[10.5px] text-(--dim)">
      {ts.slice(0, 16).replace("T", " ")}
    </time>
  );
}

function humanizeAction(actionType: string | undefined): string {
  if (!actionType) return "proposal";
  if (actionType === "plan_acceptance") return "plan approval";
  return actionType.replaceAll("_", " ");
}

function decisionOf(proposal: Proposal): string {
  if (proposal.state === "rejected") return "rejected";
  if (proposal.state === "execution_failed") {
    return proposal.executionError
      ? `approved · blocked (${proposal.executionError})`
      : "approved · execution failed";
  }
  return proposal.state === "approved" ? "approved" : proposal.state;
}

function costOf(run: StoryRun): string | null {
  const receipt = run.receipt as { usage?: { cost_cents?: number } } | null;
  const cents = receipt?.usage?.cost_cents;
  return typeof cents === "number" && cents > 0 ? fmtCost(cents) : null;
}
