import { Eyebrow } from "@facility/ui";
import { ErrorNotice, Offline } from "@/components/offline";
import { SessionTable } from "@/components/sessions/session-table";
import { LiveRefresh } from "@/components/shell/live-refresh";
import { fetchAllRuns } from "@/lib/runs";
import { toSessionRows } from "@/lib/session-rows";

export const metadata = { title: "fleet" };

const LIVE = new Set(["queued", "provisioning", "running", "awaiting_human"]);

/** The org fleet: every agent session across every project, one workspace. */
export default async function FleetPage() {
  const { offline, error, runs } = await fetchAllRuns("?limit=200");
  if (offline) return <Offline />;

  const live = runs.filter((r) => LIVE.has(r.status)).length;
  const rows = toSessionRows(runs);

  return (
    <div className="flex flex-col gap-8">
      <LiveRefresh seconds={20} />
      <div className="flex flex-col gap-2">
        <Eyebrow>fleet</Eyebrow>
        <h1 className="text-[clamp(22px,3vw,32px)] font-semibold tracking-tight">Sessions</h1>
        <p className="font-mono text-[11.5px] uppercase tracking-[0.14em] text-(--dim)">
          {live} live across the org · {rows.length} recorded
        </p>
      </div>

      {error ? <ErrorNotice message={`Couldn't load sessions — ${error}`} /> : null}

      <SessionTable rows={rows} showProject />
    </div>
  );
}
