import { Eyebrow, StatusDot } from "@facility/ui";
import Link from "next/link";
import type { ReactNode } from "react";
import { ErrorNotice, Offline } from "@/components/offline";
import { DeliveryIntelligence } from "@/components/project/delivery-intelligence";
import { InFlightList } from "@/components/project/in-flight-list";
import { PipelineBoard } from "@/components/project/pipeline";
import { LiveRefresh } from "@/components/shell/live-refresh";
import { api } from "@/lib/api";
import { buildDeliveryIntelligence } from "@/lib/delivery-intelligence";
import { buildInFlightRows } from "@/lib/in-flight";
import type { PipelineStageState } from "@/lib/pipeline";
import { pipelineStories } from "@/lib/pipeline";

export const metadata = { title: "overview" };

const LIVE = new Set(["queued", "provisioning", "running"]);

type HealthSignal = {
  kind: string;
  severity: string;
  title: string;
  state: string;
  lastSeen: string;
};

function healthTone(status: string | undefined): "ok" | "bad" | "machine" {
  if (status === "ok") return "ok";
  if (status === "red") return "bad";
  return "machine";
}

function isHealthSignal(value: Record<string, unknown>): value is HealthSignal {
  return (
    typeof value.kind === "string" &&
    typeof value.severity === "string" &&
    typeof value.title === "string" &&
    typeof value.state === "string" &&
    typeof value.lastSeen === "string"
  );
}

function AttentionRow({
  href,
  tone,
  count,
  children,
  action,
}: {
  href: string;
  tone: "human" | "bad" | "agent";
  count: number;
  children: ReactNode;
  action: string;
}) {
  return (
    <Link
      href={href}
      className="group flex min-h-12 items-center gap-3 border-b border-(--line) px-4 py-3 transition-colors last:border-b-0 hover:bg-(--card) sm:px-5"
    >
      <StatusDot tone={tone} />
      <span className="w-7 text-right font-mono text-[12px] font-semibold text-(--ink)">
        {count}
      </span>
      <span className="text-[12.5px] text-(--mut) group-hover:text-(--ink)">{children}</span>
      <span className="ml-auto shrink-0 text-[11.5px] font-medium text-(--dim) group-hover:text-(--ink)">
        {action} →
      </span>
    </Link>
  );
}

export default async function ProjectOverviewPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const monthStartIso = monthStart.toISOString();
  const runsRequest = api.runs(projectId, "?limit=200");
  const recentEventsRequest = runsRequest.then(async (result) => {
    if (!result.ok) return [];
    const visibleLive = result.data.filter((run) => LIVE.has(run.status)).slice(0, 6);
    return Promise.all(
      visibleLive.map(async (run) => [run.id, await api.recentRunEvents(run.id)] as const),
    );
  });
  const [
    project,
    runs,
    health,
    inbox,
    pipelineResult,
    repos,
    recentEventResults,
    spend,
    agentsStatus,
    outcomes,
    llmRequests,
    catalog,
  ] = await Promise.all([
    api.project(projectId),
    runsRequest,
    api.projectHealth(projectId),
    api.inboxFull(),
    api.pipeline(projectId),
    api.projectRepos(projectId),
    recentEventsRequest,
    api.spend(`?projectId=${projectId}&groupBy=agent&from=${encodeURIComponent(monthStartIso)}`),
    api.agentsStatus(projectId),
    api.outcomes(`?state=terminal&projectId=${projectId}&limit=50`),
    api.llmRequests(`?projectId=${projectId}&from=${encodeURIComponent(monthStartIso)}&limit=500`),
    api.catalog(),
  ]);

  if (!project.ok) {
    return project.offline ? (
      <Offline />
    ) : (
      <ErrorNotice message={`project not found (${project.status})`} />
    );
  }

  const p = project.data;
  const runsError = runs.ok ? null : runs.message;
  const items = runs.ok ? runs.data : [];
  const live = items.filter((run) => LIVE.has(run.status));
  const visibleLive = live.slice(0, 6);
  const eventsByRun = new Map(
    recentEventResults.map(([runId, result]) => [runId, result.ok ? result.data : []]),
  );
  const blocked = items.filter((run) => run.status === "awaiting_human");
  const proposals = inbox.ok
    ? inbox.data.proposals.filter(
        (proposal) => !proposal.projectId || proposal.projectId === projectId,
      )
    : [];
  const watchtower = inbox.ok
    ? inbox.data.issues.filter((issue) => !issue.projectId || issue.projectId === projectId)
    : [];
  const pipeline = pipelineResult.ok ? pipelineResult.data : null;
  const pipelineError = pipelineResult.ok ? null : pipelineResult.message;
  const inFlightRows = buildInFlightRows({
    projectId,
    runs: visibleLive,
    pipeline,
    eventsByRun,
  });
  const stories = pipeline ? pipelineStories(pipeline) : [];
  const stateCount = (state: PipelineStageState) =>
    stories.filter((story) => story.stageState === state).length;
  const planReviewCount = stateCount("needs_review");
  const prReviewCount = stateCount("awaiting_review");
  const readyToPlanCount = stateCount("ready_to_plan");
  const proposalRunIds = new Set(proposals.map((proposal) => proposal.runId).filter(Boolean));
  const unrepresentedBlocked = blocked.filter((run) => !proposalRunIds.has(run.id));
  const otherProposals = proposals.filter((proposal) => proposal.actionType !== "plan_acceptance");
  const needsYou =
    planReviewCount +
    prReviewCount +
    unrepresentedBlocked.length +
    otherProposals.length +
    watchtower.length;

  const healthData = health.ok ? health.data : null;
  const signals = (healthData?.signals ?? []).filter(isHealthSignal);
  const leadSignal = signals.find((signal) => signal.severity !== "info") ?? signals.at(0) ?? null;
  const healthSummary =
    healthData?.status === "ok"
      ? "systems healthy"
      : (leadSignal?.title ??
        (healthData?.status === "red"
          ? "project health requires attention"
          : "health unavailable"));
  const repoList = repos.ok ? repos.data : [];
  const delivery = buildDeliveryIntelligence({
    projectId,
    periodStart: monthStartIso,
    spend: spend.ok ? spend.data : [],
    agents: agentsStatus.ok ? agentsStatus.data : [],
    runs: items,
    outcomes: outcomes.ok ? outcomes.data : [],
    requests: llmRequests.ok ? llmRequests.data.items : [],
    pipeline,
    catalog: catalog.ok ? catalog.data : null,
  });

  return (
    <div className="flex flex-col gap-10">
      <LiveRefresh seconds={15} />

      <div className="flex flex-col gap-2">
        <Eyebrow>overview</Eyebrow>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
          <h1 className="text-[clamp(22px,3.2vw,34px)] font-semibold tracking-tight">{p.name}</h1>
          <span className="inline-flex items-center gap-2 text-[12.5px] text-(--mut)">
            <StatusDot tone={healthTone(healthData?.status)} />
            {healthSummary}
          </span>
          <span className="text-[12.5px] text-(--dim)">
            {runsError ? "activity unavailable" : `${live.length} in flight · ${needsYou} need you`}
          </span>
        </div>
        {p.description ? (
          <p className="max-w-xl text-sm leading-relaxed text-(--mut)">{p.description}</p>
        ) : null}
        {repoList.length > 0 ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            {repoList.map((repo) => (
              <a
                key={repo.id}
                href={`https://github.com/${repo.owner}/${repo.name}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[12px] text-(--info) underline-offset-4 hover:underline"
                title={`Open ${repo.owner}/${repo.name} on GitHub`}
              >
                {repo.owner}/{repo.name} ↗
              </a>
            ))}
            <Link
              href={`/projects/${projectId}/settings`}
              className="text-[11.5px] text-(--dim) hover:text-(--ink)"
            >
              manage repositories →
            </Link>
          </div>
        ) : null}
      </div>

      <section className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between gap-4">
          <div className="flex items-baseline gap-3">
            <Eyebrow>story flow</Eyebrow>
            <span className="text-[11.5px] text-(--dim)">select a status to act on it</span>
          </div>
          <Link
            href={`/projects/${projectId}/stories`}
            className="text-[12px] font-medium text-(--mut) hover:text-(--ink)"
          >
            all stories →
          </Link>
        </div>
        {pipeline ? (
          <PipelineBoard stages={pipeline.stages} projectId={projectId} />
        ) : (
          <ErrorNotice message={`Couldn't load the story pipeline — ${pipelineError}`} />
        )}
      </section>

      <DeliveryIntelligence projectId={projectId} data={delivery} />

      {needsYou > 0 ? (
        <section className="flex flex-col gap-4">
          <div className="flex items-baseline justify-between gap-4">
            <Eyebrow className="text-(--human)">needs you · {needsYou}</Eyebrow>
            <Link
              href={`/projects/${projectId}/approvals`}
              className="text-[12px] font-medium text-(--mut) hover:text-(--ink)"
            >
              all approvals →
            </Link>
          </div>
          <div className="flex flex-col border border-(--line)">
            {watchtower.slice(0, 3).map((issue) => (
              <AttentionRow
                key={issue.id}
                href={`/projects/${projectId}/approvals`}
                tone="bad"
                count={1}
                action="Investigate"
              >
                {issue.title}
              </AttentionRow>
            ))}
            {planReviewCount > 0 ? (
              <AttentionRow
                href={`/projects/${projectId}/stories?stage=planning&status=needs_review`}
                tone="human"
                count={planReviewCount}
                action="Review plans"
              >
                {planReviewCount === 1
                  ? "Plan awaiting your decision"
                  : "Plans awaiting your decision"}
              </AttentionRow>
            ) : null}
            {prReviewCount > 0 ? (
              <AttentionRow
                href={`/projects/${projectId}/stories?stage=review&status=awaiting_review`}
                tone="human"
                count={prReviewCount}
                action="Review PRs"
              >
                {prReviewCount === 1
                  ? "Pull request awaiting review"
                  : "Pull requests awaiting review"}
              </AttentionRow>
            ) : null}
            {unrepresentedBlocked.length > 0 ? (
              <AttentionRow
                href={`/projects/${projectId}/sessions`}
                tone="human"
                count={unrepresentedBlocked.length}
                action="Respond"
              >
                {unrepresentedBlocked.length === 1
                  ? "Agent waiting for your input"
                  : "Agents waiting for your input"}
              </AttentionRow>
            ) : null}
            {otherProposals.length > 0 ? (
              <AttentionRow
                href={`/projects/${projectId}/approvals`}
                tone="human"
                count={otherProposals.length}
                action="Decide"
              >
                {otherProposals.length === 1
                  ? "Proposal awaiting a decision"
                  : "Proposals awaiting a decision"}
              </AttentionRow>
            ) : null}
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between">
          <Eyebrow>in flight · {live.length}</Eyebrow>
          <Link
            href={`/projects/${projectId}/sessions`}
            className="text-[12px] font-medium text-(--mut) hover:text-(--ink)"
          >
            all sessions →
          </Link>
        </div>
        {runsError ? (
          <ErrorNotice message={`Couldn't load sessions — ${runsError}`} />
        ) : live.length === 0 ? (
          <p className="text-sm text-(--dim)">
            No agents running.{" "}
            {planReviewCount > 0 ? (
              <Link
                href={`/projects/${projectId}/stories?stage=planning&status=needs_review`}
                className="text-(--ink) underline underline-offset-4"
              >
                {planReviewCount} {planReviewCount === 1 ? "plan is" : "plans are"} waiting for
                review →
              </Link>
            ) : readyToPlanCount > 0 ? (
              <Link
                href={`/projects/${projectId}/stories?stage=backlog&status=ready_to_plan`}
                className="text-(--ink) underline underline-offset-4"
              >
                {readyToPlanCount} {readyToPlanCount === 1 ? "story is" : "stories are"} ready to
                plan →
              </Link>
            ) : null}
          </p>
        ) : (
          <InFlightList projectId={projectId} rows={inFlightRows} total={live.length} />
        )}
      </section>
    </div>
  );
}
