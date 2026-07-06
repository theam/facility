import { Eyebrow, StatusDot, toneFor } from "@facility/ui";
import Link from "next/link";
import { ErrorNotice, Offline } from "@/components/offline";
import { LiveRefresh } from "@/components/shell/live-refresh";
import { api } from "@/lib/api";
import { fmtAgo, fmtCost, fmtDuration } from "@/lib/runs";

export const metadata = { title: "sessions" };

const LIVE = new Set(["queued", "provisioning", "running", "awaiting_human"]);

function usageCents(receipt: unknown): number | undefined {
  const usage =
    receipt && typeof receipt === "object" ? (receipt as { usage?: unknown }).usage : null;
  const cents =
    usage && typeof usage === "object" ? (usage as { cost_cents?: unknown }).cost_cents : null;
  return typeof cents === "number" ? cents : undefined;
}

export default async function ProjectSessionsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const runs = await api.runs(projectId);
  if (!runs.ok) return runs.offline ? <Offline /> : <ErrorNotice message={runs.message} />;

  const items = runs.data;
  const liveCount = items.filter((r) => LIVE.has(r.status)).length;

  return (
    <div className="flex flex-col gap-8">
      <LiveRefresh seconds={20} />
      <div className="flex flex-col gap-2">
        <Eyebrow>sessions</Eyebrow>
        <h1 className="text-[clamp(22px,3vw,32px)] font-semibold tracking-tight">Sessions</h1>
        <p className="font-mono text-[11.5px] uppercase tracking-[0.14em] text-(--dim)">
          {items.length} total · {liveCount} live
        </p>
      </div>

      {items.length === 0 ? (
        <p className="max-w-lg text-sm leading-relaxed text-(--dim)">
          No sessions yet. Trigger an agent from{" "}
          <Link
            href={`/projects/${projectId}/issues`}
            className="text-(--ink) underline underline-offset-4"
          >
            issues
          </Link>{" "}
          — every session runs in an isolated sandbox and lands here with its receipt.
        </p>
      ) : (
        <div className="overflow-x-auto border border-(--line)">
          <table className="w-full min-w-[720px] border-collapse text-left">
            <thead>
              <tr className="border-b border-(--line)">
                {["session", "engine", "status", "duration", "cost", "when"].map((h) => (
                  <th
                    key={h}
                    className="px-5 py-3 font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-(--dim)"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((run) => (
                <tr key={run.id} className="border-b border-(--line) last:border-b-0">
                  <td className="px-5 py-3">
                    <Link
                      href={`/projects/${projectId}/sessions/${run.id}`}
                      className="flex items-center gap-3 font-mono text-[12.5px] text-(--ink) hover:text-(--accent)"
                    >
                      <StatusDot tone={toneFor(run.status)} pulse={run.status === "running"} />
                      {run.mode}
                    </Link>
                  </td>
                  <td className="px-5 py-3 font-mono text-[11px] text-(--dim)">{run.engine}</td>
                  <td className="px-5 py-3 font-mono text-[11px] uppercase tracking-[0.12em] text-(--mut)">
                    {run.status}
                  </td>
                  <td className="px-5 py-3 font-mono text-[11px] text-(--mut)">
                    {fmtDuration(run.startedAt, run.endedAt)}
                  </td>
                  <td className="px-5 py-3 font-mono text-[11px] text-(--mut)">
                    {fmtCost(usageCents(run.receipt))}
                  </td>
                  <td className="px-5 py-3 font-mono text-[11px] text-(--dim)">
                    {fmtAgo(run.queuedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
