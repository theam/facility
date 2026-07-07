import { ButtonLink, Eyebrow, Metric } from "@facility/ui";
import { EngineLoop } from "@/components/agents/engine-loop";
import { ErrorNotice, Offline } from "@/components/offline";
import { LiveRefresh } from "@/components/shell/live-refresh";
import { api } from "@/lib/api";
import { fmtIn } from "@/lib/schedule";

export const metadata = { title: "agents" };

export default async function ProjectAgentsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const status = await api.agentsStatus(projectId);
  if (!status.ok) return status.offline ? <Offline /> : <ErrorNotice message={status.message} />;

  const rows = status.data;
  const enabled = rows.filter((r) => r.enabled);
  const working = rows.filter(
    (r) => r.liveRun && (r.liveRun.status === "running" || r.liveRun.status === "provisioning"),
  );
  const queued = rows.filter((r) => r.liveRun?.status === "queued");
  const waiting = rows.filter((r) => r.liveRun?.status === "awaiting_human");
  const totals = rows.reduce(
    (acc, r) => {
      acc.sessions += r.counts14d.total;
      acc.ok += r.counts14d.succeeded;
      acc.prs += r.prCount14d;
      return acc;
    },
    { sessions: 0, ok: 0, prs: 0 },
  );
  const nextUp = rows
    .filter((r) => r.enabled && r.nextRunAt && !r.liveRun)
    .sort((a, b) => new Date(a.nextRunAt ?? 0).getTime() - new Date(b.nextRunAt ?? 0).getTime())[0];
  const successPct = totals.sessions > 0 ? Math.round((totals.ok / totals.sessions) * 100) : null;

  return (
    <div className="flex flex-col gap-8">
      <LiveRefresh seconds={30} />

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex flex-col gap-2">
            <Eyebrow>agents</Eyebrow>
            <h1 className="text-[clamp(22px,3vw,32px)] font-semibold tracking-tight">Agents</h1>
          </div>
          <span className="ml-auto">
            <ButtonLink
              href={`/projects/${projectId}/agents/new`}
              size="sm"
              variant="primary"
              tone="agent"
            >
              new agent
            </ButtonLink>
          </span>
        </div>
        <p className="text-[12.5px] text-(--dim)">
          {enabled.length} of {rows.length} enabled · {working.length} working
          {queued.length > 0 ? ` · ${queued.length} queued` : ""}
          {waiting.length > 0 ? ` · ${waiting.length} waiting on you` : ""}
          {nextUp ? ` · next: ${nextUp.name} ${fmtIn(nextUp.nextRunAt)}` : ""}
        </p>
      </div>

      {rows.length > 0 ? (
        <div className="grid gap-px border border-(--line) bg-(--line) sm:grid-cols-2 lg:grid-cols-4">
          <div className="bg-(--bg) p-5">
            <Metric
              label="working now"
              value={String(working.length)}
              hint={
                working.map((r) => r.name).join(" · ") ||
                (queued.length > 0 ? `${queued.length} queued for a worker` : "engine idle")
              }
            />
          </div>
          <div className="bg-(--bg) p-5">
            <Metric
              label="14d sessions"
              value={String(totals.sessions)}
              hint={successPct !== null ? `${successPct}% succeeded` : "no sessions yet"}
            />
          </div>
          <div className="bg-(--bg) p-5">
            <Metric
              label="14d prs shipped"
              value={String(totals.prs)}
              hint="sessions that opened a pull request"
            />
          </div>
          <div className="bg-(--bg) p-5">
            <Metric
              label="next scheduled"
              value={nextUp ? (fmtIn(nextUp.nextRunAt) ?? "—") : "—"}
              hint={nextUp ? nextUp.name : "nothing on the clock"}
            />
          </div>
        </div>
      ) : null}

      <section className="flex flex-col gap-4">
        <Eyebrow>the loop</Eyebrow>
        <EngineLoop projectId={projectId} rows={rows} />
      </section>
    </div>
  );
}
