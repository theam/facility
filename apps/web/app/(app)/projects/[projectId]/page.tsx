import { Cell, Divider, Eyebrow, HairlineGrid, Metric, StatusDot, toneFor } from "@facility/ui";
import Link from "next/link";
import { EngineLoop } from "@/components/agents/engine-loop";
import { ErrorNotice, Offline } from "@/components/offline";
import { LiveRefresh } from "@/components/shell/live-refresh";
import { api, summarizeSpend } from "@/lib/api";
import { fmtAgo, fmtCost, fmtDuration } from "@/lib/runs";

export const metadata = { title: "overview" };

const LIVE = new Set(["queued", "provisioning", "running"]);
const OWNER_AGENT_NAMES = new Set(["project-owner", "learning"]);

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

function prLink(gh: Record<string, unknown> | null | undefined): string | null {
  const pr = gh && typeof gh === "object" ? (gh as { pr?: unknown }).pr : null;
  if (pr && typeof pr === "object" && typeof (pr as { url?: unknown }).url === "string") {
    return (pr as { url: string }).url;
  }
  return null;
}

export default async function ProjectOverviewPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const [project, runs, spend, health, inbox, agentsStatus, outcomes, allOutcomes] =
    await Promise.all([
      api.project(projectId),
      api.runs(projectId),
      api.spend(`?projectId=${projectId}&groupBy=agent`),
      api.projectHealth(projectId),
      api.inboxFull(),
      api.agentsStatus(projectId),
      api.outcomes(`?state=open&projectId=${projectId}&limit=10`),
      api.outcomes(`?state=all&projectId=${projectId}&limit=6`),
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
  const live = items.filter((r) => LIVE.has(r.status));
  const blocked = items.filter((r) => r.status === "awaiting_human");
  const proposals = inbox.ok
    ? inbox.data.proposals.filter((x) => !x.projectId || x.projectId === projectId)
    : [];
  const watchtower = inbox.ok
    ? inbox.data.issues.filter((x) => !x.projectId || x.projectId === projectId)
    : [];
  const openPrs = outcomes.ok ? outcomes.data : [];
  const needsYou = blocked.length + proposals.length + openPrs.length;

  const healthData = health.ok
    ? (health.data as { status?: string; signals?: HealthSignal[] })
    : null;
  const signals = healthData?.signals ?? [];

  const agentRows = agentsStatus.ok ? agentsStatus.data : [];
  const agentNameById = new Map(agentRows.map((row) => [row.agentId, row.name]));
  const ownerAgentIds = new Set(
    agentRows.filter((row) => OWNER_AGENT_NAMES.has(row.name)).map((row) => row.agentId),
  );
  const ownerRuns = items.filter((r) => r.agentDefId && ownerAgentIds.has(r.agentDefId));
  const lastOwnerRun = ownerRuns[0];

  const recent = items.slice(0, 8);
  const spendSummary = spend.ok ? summarizeSpend(spend.data) : null;
  const shipped = allOutcomes.ok
    ? allOutcomes.data.filter((outcome) => outcome.terminalAt).slice(0, 5)
    : [];

  return (
    <div className="flex flex-col gap-10">
      <LiveRefresh seconds={15} />

      <div className="flex flex-col gap-2">
        <Eyebrow>overview</Eyebrow>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
          <h1 className="font-mono text-[clamp(22px,3.2vw,34px)] font-semibold tracking-tight">
            {p.slug}
          </h1>
          <span className="inline-flex items-center gap-2 font-mono text-[11.5px] uppercase tracking-[0.14em] text-(--mut)">
            <StatusDot tone={healthTone(healthData?.status)} />
            {healthData ? `health ${healthData.status}` : "health —"}
          </span>
          <span className="font-mono text-[11.5px] uppercase tracking-[0.14em] text-(--dim)">
            {runsError
              ? "sessions —"
              : `${live.length} running · ${blocked.length} blocked · ${needsYou} need you`}
          </span>
        </div>
        {p.description ? (
          <p className="max-w-xl text-sm leading-relaxed text-(--mut)">{p.description}</p>
        ) : null}
      </div>

      {needsYou > 0 || watchtower.length > 0 ? (
        <section className="flex flex-col gap-4">
          <Eyebrow className="text-(--human)">needs you · {needsYou + watchtower.length}</Eyebrow>
          <div className="flex flex-col border border-(--line)">
            {blocked.map((run) => (
              <Link
                key={run.id}
                href={`/projects/${projectId}/sessions/${run.id}`}
                className="flex items-center gap-4 border-b border-(--line) px-5 py-3.5 transition-colors last:border-b-0 hover:bg-(--card)"
              >
                <StatusDot tone="human" />
                <span className="font-mono text-[13px] text-(--ink)">{run.mode}</span>
                <span className="text-[12.5px] text-(--mut)">session is waiting on a human</span>
                <span className="ml-auto font-mono text-[11px] text-(--dim)">
                  {fmtAgo(run.queuedAt)}
                </span>
              </Link>
            ))}
            {openPrs.slice(0, 5).map((outcome) => (
              <a
                key={outcome.id}
                href={`https://github.com/${outcome.repo}/pull/${outcome.prNumber}`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-4 border-b border-(--line) px-5 py-3.5 transition-colors last:border-b-0 hover:bg-(--card)"
              >
                <StatusDot tone="human" />
                <span className="font-mono text-[13px] text-(--ink)">
                  {outcome.repo}#{outcome.prNumber}
                </span>
                <span className="text-[12.5px] text-(--mut)">PR awaiting your review ↗</span>
              </a>
            ))}
            {proposals.slice(0, 5).map((proposal) => (
              <Link
                key={proposal.id}
                href={`/inbox?focus=${proposal.id}&projectId=${projectId}`}
                className="flex items-center gap-4 border-b border-(--line) px-5 py-3.5 transition-colors last:border-b-0 hover:bg-(--card)"
              >
                <StatusDot tone="human" />
                <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-(--human)">
                  {proposal.actionType}
                </span>
                <span className="truncate text-[12.5px] text-(--mut)">
                  gate waiting for a decision
                </span>
                <span className="ml-auto font-mono text-[11px] text-(--dim)">
                  {fmtAgo(proposal.createdAt)}
                </span>
              </Link>
            ))}
            {watchtower.slice(0, 5).map((issue) => (
              <Link
                key={issue.id}
                href="/inbox"
                className="flex items-center gap-4 border-b border-(--line) px-5 py-3.5 transition-colors last:border-b-0 hover:bg-(--card)"
              >
                <StatusDot tone="bad" />
                <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-(--bad)">
                  {issue.severity}
                </span>
                <span className="truncate text-[12.5px] text-(--mut)">{issue.title}</span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between">
          <Eyebrow>running now</Eyebrow>
          <Link
            href={`/projects/${projectId}/sessions`}
            className="font-mono text-[10.5px] uppercase tracking-[0.2em] text-(--mut) hover:text-(--ink)"
          >
            all sessions →
          </Link>
        </div>
        {runsError ? (
          <ErrorNotice message={`Couldn't load sessions — ${runsError}`} />
        ) : live.length === 0 ? (
          <p className="text-sm text-(--dim)">
            No agent is working right now. Trigger one from{" "}
            <Link
              href={`/projects/${projectId}/issues`}
              className="text-(--ink) underline underline-offset-4"
            >
              issues
            </Link>
            .
          </p>
        ) : (
          <div className="flex flex-col border border-(--line)">
            {live.map((run) => (
              <Link
                key={run.id}
                href={`/projects/${projectId}/sessions/${run.id}`}
                className="flex items-center gap-4 border-b border-(--line) px-5 py-4 transition-colors last:border-b-0 hover:bg-(--card)"
              >
                <StatusDot tone={toneFor(run.status)} pulse={run.status === "running"} />
                <span className="font-mono text-[13px] text-(--ink)">{run.mode}</span>
                <span className="hidden font-mono text-[11px] text-(--dim) sm:inline">
                  {run.engine}
                </span>
                <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-(--mut)">
                  {run.status}
                </span>
                <span className="ml-auto font-mono text-[11px] text-(--mut)">
                  {fmtDuration(run.startedAt, null)}
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between">
          <Eyebrow>the engine</Eyebrow>
          <Link
            href={`/projects/${projectId}/agents`}
            className="font-mono text-[10.5px] uppercase tracking-[0.2em] text-(--mut) hover:text-(--ink)"
          >
            all agents →
          </Link>
        </div>
        {agentRows.length === 0 ? (
          <p className="text-sm text-(--dim)">
            No agents configured yet —{" "}
            <Link
              href={`/projects/${projectId}/agents/new`}
              className="text-(--ink) underline underline-offset-4"
            >
              create the first one
            </Link>
            .
          </p>
        ) : (
          <EngineLoop projectId={projectId} rows={agentRows} compact />
        )}
      </section>

      <Divider />

      <HairlineGrid cols="lg:grid-cols-2">
        <Cell className="p-0">
          <div className="flex h-full flex-col">
            <div className="border-b border-(--line) px-5 py-3">
              <Eyebrow>the owner</Eyebrow>
            </div>
            <div className="flex flex-1 flex-col gap-3 px-5 py-4">
              {ownerAgentIds.size === 0 ? (
                <p className="text-sm text-(--dim)">
                  No Project Owner agent is configured for this project yet.
                </p>
              ) : lastOwnerRun ? (
                <Link
                  href={`/projects/${projectId}/sessions/${lastOwnerRun.id}`}
                  className="flex items-center gap-3 hover:text-(--ink)"
                >
                  <StatusDot tone={toneFor(lastOwnerRun.status)} />
                  <span className="font-mono text-[12.5px] text-(--ink)">{lastOwnerRun.mode}</span>
                  <span className="font-mono text-[11px] text-(--dim)">
                    {fmtAgo(lastOwnerRun.queuedAt)} · {lastOwnerRun.status}
                  </span>
                </Link>
              ) : (
                <p className="text-sm text-(--dim)">
                  The Project Owner hasn't run yet. It runs on its schedule or on demand.
                </p>
              )}
              <p className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-(--dim)">
                knowledge base + conversation land with the Owner surface
              </p>
            </div>
          </div>
        </Cell>
        <Cell className="p-0">
          <div className="flex h-full flex-col">
            <div className="border-b border-(--line) px-5 py-3">
              <Eyebrow>system health</Eyebrow>
            </div>
            <div className="flex flex-1 flex-col gap-2 px-5 py-4">
              {signals.length === 0 ? (
                <p className="text-sm text-(--dim)">
                  No open signals. Workflows, canary, and fingerprints are quiet.
                </p>
              ) : (
                signals.slice(0, 5).map((signal) => (
                  <div key={`${signal.kind}-${signal.title}`} className="flex items-center gap-3">
                    <StatusDot tone={signal.severity === "info" ? "machine" : "bad"} />
                    <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-(--dim)">
                      {signal.kind}
                    </span>
                    <span className="truncate text-[12.5px] text-(--mut)">{signal.title}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </Cell>
      </HairlineGrid>

      <section className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Eyebrow>recent sessions</Eyebrow>
          {recent.length === 0 ? (
            <p className="text-sm text-(--dim)">No sessions in this project yet.</p>
          ) : (
            <div className="flex flex-col border border-(--line)">
              {recent.map((run) => {
                const pr = prLink(run.gh as Record<string, unknown>);
                return (
                  <div
                    key={run.id}
                    className="flex items-center gap-4 border-b border-(--line) px-5 py-3.5 last:border-b-0"
                  >
                    <StatusDot tone={toneFor(run.status)} />
                    <Link
                      href={`/projects/${projectId}/sessions/${run.id}`}
                      className="font-mono text-[13px] text-(--ink) hover:text-(--accent)"
                    >
                      {run.mode}
                    </Link>
                    <span className="hidden font-mono text-[11px] text-(--dim) sm:inline">
                      {run.engine}
                    </span>
                    {pr ? (
                      <a
                        href={pr}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-[11px] text-(--info) underline-offset-4 hover:underline"
                      >
                        PR ↗
                      </a>
                    ) : null}
                    <span className="ml-auto hidden font-mono text-[11px] text-(--mut) sm:inline">
                      {fmtDuration(run.startedAt, run.endedAt)}
                    </span>
                    <span className="font-mono text-[11px] text-(--dim)">
                      {fmtAgo(run.queuedAt)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-4">
            <Eyebrow>spend · mtd</Eyebrow>
            <div className="flex flex-col gap-3 border border-(--line) p-5">
              <Metric
                label="total"
                value={spendSummary ? fmtCost(spendSummary.totalCents) : "—"}
                hint="straight from the gateway"
              />
              {spendSummary?.groups.slice(0, 4).map((group) => (
                <div key={group.key} className="flex justify-between gap-4 font-mono text-[12px]">
                  <span className="truncate text-(--dim)">
                    {agentNameById.get(group.key) ?? group.key}
                  </span>
                  <span className="text-(--code)">{fmtCost(group.cents)}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-4">
            <Eyebrow>shipped</Eyebrow>
            {shipped.length === 0 ? (
              <p className="text-sm text-(--dim)">No terminal PRs recorded yet.</p>
            ) : (
              <div className="flex flex-col border border-(--line)">
                {shipped.map((outcome) => (
                  <a
                    key={outcome.id}
                    href={`https://github.com/${outcome.repo}/pull/${outcome.prNumber}`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-3 border-b border-(--line) px-4 py-3 transition-colors last:border-b-0 hover:bg-(--card)"
                  >
                    <StatusDot tone={outcome.fate === "merged" ? "ok" : "machine"} />
                    <span className="font-mono text-[11.5px] text-(--ink)">
                      #{outcome.prNumber}
                    </span>
                    <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-(--mut)">
                      {outcome.fate ?? "open"}
                    </span>
                    {outcome.fate === "merged" && outcome.fixupCommits === 0 ? (
                      <span
                        className="border border-(--line) px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-(--ok)"
                        title="merged with zero fixup commits"
                      >
                        one-shot
                      </span>
                    ) : outcome.fixupCommits > 0 ? (
                      <span className="font-mono text-[10px] text-(--dim)">
                        {outcome.fixupCommits} fixup{outcome.fixupCommits === 1 ? "" : "s"}
                      </span>
                    ) : null}
                    <span className="ml-auto font-mono text-[10px] text-(--dim)">
                      {outcome.terminalAt ? fmtAgo(outcome.terminalAt) : ""}
                    </span>
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
