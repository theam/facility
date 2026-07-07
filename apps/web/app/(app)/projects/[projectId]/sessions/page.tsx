import { Eyebrow } from "@facility/ui";
import Link from "next/link";
import { ErrorNotice, Offline } from "@/components/offline";
import { SessionTable } from "@/components/sessions/session-table";
import { LiveRefresh } from "@/components/shell/live-refresh";
import { api } from "@/lib/api";
import { toSessionRows } from "@/lib/session-rows";

export const metadata = { title: "sessions" };

const LIVE = new Set(["queued", "provisioning", "running", "awaiting_human"]);

export default async function ProjectSessionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ agent?: string }>;
}) {
  const [{ projectId }, { agent }] = await Promise.all([params, searchParams]);
  const [runs, status] = await Promise.all([
    api.runs(projectId, "?limit=200"),
    api.agentsStatus(projectId),
  ]);
  if (!runs.ok) return runs.offline ? <Offline /> : <ErrorNotice message={runs.message} />;

  const agentNames = new Map((status.ok ? status.data : []).map((row) => [row.agentId, row.name]));
  const rows = toSessionRows(runs.data, agentNames);
  const liveCount = runs.data.filter((r) => LIVE.has(r.status)).length;

  return (
    <div className="flex flex-col gap-8">
      <LiveRefresh seconds={20} />
      <div className="flex flex-col gap-2">
        <Eyebrow>sessions</Eyebrow>
        <h1 className="text-[clamp(22px,3vw,32px)] font-semibold tracking-tight">Sessions</h1>
        <p className="font-mono text-[11.5px] uppercase tracking-[0.14em] text-(--dim)">
          {rows.length} recorded · {liveCount} live
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="max-w-lg text-sm leading-relaxed text-(--dim)">
          No sessions yet. Trigger an agent from{" "}
          <Link
            href={`/projects/${projectId}/issues`}
            className="text-(--ink) underline underline-offset-4"
          >
            issues
          </Link>{" "}
          or run one from{" "}
          <Link
            href={`/projects/${projectId}/agents`}
            className="text-(--ink) underline underline-offset-4"
          >
            agents
          </Link>{" "}
          — every session runs in an isolated sandbox and lands here with its receipt.
        </p>
      ) : (
        <SessionTable
          rows={rows}
          agents={(status.ok ? status.data : []).map((row) => ({
            id: row.agentId,
            name: row.name,
          }))}
          initialAgent={agent ?? ""}
        />
      )}
    </div>
  );
}
