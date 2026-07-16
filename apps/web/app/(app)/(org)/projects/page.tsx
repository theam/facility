import { ButtonLink, Cell, Eyebrow, HairlineGrid, Metric, PillTag, StatusDot } from "@facility/ui";
import Link from "next/link";
import { ErrorNotice, Offline } from "@/components/offline";
import { LiveRefresh } from "@/components/shell/live-refresh";
import { api, summarizeSpend } from "@/lib/api";
import { fetchAllRuns, fmtCost } from "@/lib/runs";

export const metadata = { title: "projects" };

const LIVE = new Set(["queued", "provisioning", "running"]);
const DASH = "—";

export default async function ProjectsPage() {
  const [{ offline, error: runsError, projects, runs }, spend, inbox, overview] = await Promise.all(
    [fetchAllRuns(), api.spend("?groupBy=day"), api.inboxFull(), api.analyticsOverview()],
  );
  if (offline) return <Offline />;

  const liveByProject = new Map<string, number>();
  const blockedByProject = new Map<string, number>();
  for (const run of runs) {
    if (LIVE.has(run.status)) {
      liveByProject.set(run.project.id, (liveByProject.get(run.project.id) ?? 0) + 1);
    }
    if (run.status === "awaiting_human") {
      blockedByProject.set(run.project.id, (blockedByProject.get(run.project.id) ?? 0) + 1);
    }
  }
  const liveTotal = [...liveByProject.values()].reduce((a, b) => a + b, 0);
  const needsYou =
    (inbox.ok ? inbox.data.proposals.length + inbox.data.issues.length : 0) +
    [...blockedByProject.values()].reduce((a, b) => a + b, 0);
  const monthCents = spend.ok ? summarizeSpend(spend.data).totalCents : null;
  const outcomeTotals = overview.ok ? overview.data.outcomes30d : null;
  const evidenceCoverage =
    outcomeTotals && outcomeTotals.total > 0
      ? Math.round((100 * outcomeTotals.assessed) / outcomeTotals.total)
      : null;

  return (
    <div className="flex flex-col gap-8">
      <LiveRefresh seconds={30} />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Eyebrow>projects</Eyebrow>
          <h1 className="text-[clamp(22px,3vw,32px)] font-semibold tracking-tight">Projects</h1>
          <p className="text-[12.5px] text-(--dim)">
            {runsError
              ? `${projects.length} projects`
              : `${projects.length} projects · ${liveTotal} agents live · ${needsYou} need you`}
            {monthCents != null ? ` · ${fmtCost(monthCents)} mtd` : ""}
          </p>
        </div>
        <ButtonLink href="/projects/new" variant="primary">
          kickstart
        </ButtonLink>
      </div>

      {runsError ? <ErrorNotice message={`Couldn't load sessions — ${runsError}`} /> : null}
      {!overview.ok ? (
        <ErrorNotice message={`Couldn't load outcomes — ${overview.message}`} />
      ) : null}

      <section className="flex flex-col gap-4">
        <Eyebrow>outcomes · 30 days</Eyebrow>
        <HairlineGrid cols="grid-cols-2 lg:grid-cols-4">
          <Cell>
            <Metric
              label="acceptance"
              value={
                overview.ok && overview.data.acceptance30d != null
                  ? `${overview.data.acceptance30d}%`
                  : DASH
              }
              hint={
                outcomeTotals
                  ? `${outcomeTotals.accepted}/${outcomeTotals.assessed} assessed PRs accepted`
                  : "outcomes didn't load"
              }
            />
          </Cell>
          <Cell>
            <Metric
              label="evidence coverage"
              value={evidenceCoverage == null ? DASH : `${evidenceCoverage}%`}
              hint={
                outcomeTotals
                  ? `${outcomeTotals.assessed}/${outcomeTotals.total} terminal agent PRs assessed`
                  : "outcomes didn't load"
              }
            />
          </Cell>
          <Cell>
            <Metric
              label="one-shot"
              value={
                overview.ok && overview.data.oneShot30d != null
                  ? `${overview.data.oneShot30d}%`
                  : DASH
              }
              hint={
                outcomeTotals
                  ? `${outcomeTotals.oneShot}/${outcomeTotals.merged} merged PRs`
                  : "outcomes didn't load"
              }
            />
          </Cell>
          <Cell>
            <Metric
              label="accepted"
              value={outcomeTotals?.accepted ?? DASH}
              hint={outcomeTotals ? `${outcomeTotals.merged} merged` : "outcomes didn't load"}
            />
          </Cell>
        </HairlineGrid>
      </section>

      {projects.length === 0 ? (
        <p className="max-w-lg text-sm leading-relaxed text-(--dim)">
          No projects yet. Kickstart connects a GitHub repository and opens a PR with the full
          factory — workflows, guards, skills, the standard.
        </p>
      ) : (
        <HairlineGrid cols="sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => {
            const live = liveByProject.get(project.id) ?? 0;
            const blocked = blockedByProject.get(project.id) ?? 0;
            return (
              <Cell key={project.id} interactive className="p-0">
                <Link
                  href={`/projects/${project.id}`}
                  className="flex h-full flex-col gap-4 p-6 sm:p-8"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-[14px] font-medium text-(--ink)">
                      {project.slug}
                    </span>
                    {project.status === "archived" ? <PillTag>archived</PillTag> : null}
                  </div>
                  <p className="line-clamp-2 flex-1 text-[13px] leading-relaxed text-(--mut)">
                    {project.description ?? "—"}
                  </p>
                  <div className="flex items-center gap-4 text-[11px] font-medium">
                    <span className="inline-flex items-center gap-1.5 text-(--mut)">
                      <StatusDot tone={live > 0 ? "agent" : "machine"} pulse={live > 0} />
                      {live} live
                    </span>
                    {blocked > 0 ? (
                      <span className="inline-flex items-center gap-1.5 text-(--human)">
                        <StatusDot tone="human" />
                        {blocked} blocked
                      </span>
                    ) : null}
                    <span className="ml-auto text-(--dim)">
                      {project.systemVersion ?? "unpinned"}
                    </span>
                  </div>
                </Link>
              </Cell>
            );
          })}
        </HairlineGrid>
      )}
    </div>
  );
}
