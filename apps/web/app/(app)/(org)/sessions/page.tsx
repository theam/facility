import { Eyebrow, StatusDot, toneFor } from "@facility/ui";
import Link from "next/link";
import { ErrorNotice, Offline } from "@/components/offline";
import { LiveRefresh } from "@/components/shell/live-refresh";
import { fetchAllRuns, fmtAgo, fmtDuration } from "@/lib/runs";

export const metadata = { title: "fleet" };

const LIVE = new Set(["queued", "provisioning", "running", "awaiting_human"]);

/** The org fleet: every agent across every project, live ones first. */
export default async function FleetPage() {
  const { offline, error, runs } = await fetchAllRuns();
  if (offline) return <Offline />;

  const live = runs.filter((r) => LIVE.has(r.status));
  const recent = runs.filter((r) => !LIVE.has(r.status)).slice(0, 40);

  return (
    <div className="flex flex-col gap-8">
      <LiveRefresh seconds={20} />
      <div className="flex flex-col gap-2">
        <Eyebrow>fleet</Eyebrow>
        <h1 className="text-[clamp(22px,3vw,32px)] font-semibold tracking-tight">Sessions</h1>
        <p className="font-mono text-[11.5px] uppercase tracking-[0.14em] text-(--dim)">
          {live.length} live across the org · {runs.length} recorded
        </p>
      </div>

      {error ? <ErrorNotice message={`Couldn't load sessions — ${error}`} /> : null}

      {[
        { label: "live", items: live },
        { label: "recent", items: recent },
      ].map((section) =>
        section.items.length === 0 ? null : (
          <section key={section.label} className="flex flex-col gap-3">
            <Eyebrow>{section.label}</Eyebrow>
            <div className="flex flex-col border border-(--line)">
              {section.items.map((run) => (
                <Link
                  key={run.id}
                  href={`/projects/${run.project.id}/sessions/${run.id}`}
                  className="flex items-center gap-4 border-b border-(--line) px-5 py-3.5 transition-colors last:border-b-0 hover:bg-(--card)"
                >
                  <StatusDot tone={toneFor(run.status)} pulse={run.status === "running"} />
                  <span className="font-mono text-[12.5px] text-(--ink)">
                    {run.project.slug}/{run.mode}
                  </span>
                  <span className="hidden font-mono text-[11px] text-(--dim) sm:inline">
                    {run.engine}
                  </span>
                  <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-(--mut)">
                    {run.status}
                  </span>
                  <span className="ml-auto hidden font-mono text-[11px] text-(--mut) sm:inline">
                    {fmtDuration(run.startedAt, run.endedAt)}
                  </span>
                  <span className="font-mono text-[11px] text-(--dim)">{fmtAgo(run.queuedAt)}</span>
                </Link>
              ))}
            </div>
          </section>
        ),
      )}
    </div>
  );
}
