import { Divider, Eyebrow, StatusDot, toneFor } from "@facility/ui";
import Link from "next/link";
import { ErrorNotice, Offline } from "@/components/offline";
import { OwnerConversation } from "@/components/owner/conversation";
import { type KbEntry, KbReader, type KbSpace } from "@/components/owner/kb-reader";
import { LiveRefresh } from "@/components/shell/live-refresh";
import { api } from "@/lib/api";
import { fmtAgo } from "@/lib/runs";

export const metadata = { title: "owner" };

const OWNER_NAMES = new Set(["project-owner", "learning"]);

type ScheduleTrigger = { type?: string; config?: { cron?: string } };

export default async function OwnerPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const [space, entries, agents, runs, me] = await Promise.all([
    api.kbSpace(projectId),
    api.kbEntries(projectId),
    api.projectAgents(projectId),
    api.runs(projectId),
    api.me(),
  ]);

  if (!space.ok && space.offline) return <Offline />;

  const canWriteKb =
    me.ok && me.data.permissions.some((p) => p === "*" || p === "kb:write" || p === "kb:*");

  const ownerAgents = (agents.ok ? agents.data : []).filter((a) => OWNER_NAMES.has(a.name));
  const ownerAgent = ownerAgents.find((a) => a.name === "project-owner");
  const ownerIds = new Set(ownerAgents.map((a) => a.id));
  const ownerRuns = (runs.ok ? runs.data : [])
    .filter((r) => r.agentDefId && ownerIds.has(r.agentDefId))
    .slice(0, 6);
  const cron = ownerAgent?.triggers
    .map((t) => t as ScheduleTrigger)
    .find((t) => t.type === "schedule")?.config?.cron;

  const kbSpace = (space.ok ? space.data : { charterMd: "", activeMd: "" }) as KbSpace;
  const kbEntries = (entries.ok ? entries.data : []) as unknown as KbEntry[];

  return (
    <div className="flex flex-col gap-8">
      <LiveRefresh seconds={30} />
      <div className="flex flex-col gap-2">
        <Eyebrow>owner</Eyebrow>
        <h1 className="text-[clamp(22px,3vw,32px)] font-semibold tracking-tight">Project Owner</h1>
        <p className="font-mono text-[11.5px] uppercase tracking-[0.14em] text-(--dim)">
          {ownerAgent
            ? `${ownerAgent.engine}${cron ? ` · runs at cron ${cron}` : " · manual"} · ${
                ownerAgent.enabled ? "enabled" : "disabled"
              }`
            : "no project-owner agent configured"}{" "}
          · {kbEntries.length} kb entr{kbEntries.length === 1 ? "y" : "ies"}
        </p>
      </div>

      <section className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Eyebrow>knowledge base</Eyebrow>
          {!space.ok || !entries.ok ? (
            <ErrorNotice
              message={`Couldn't load the knowledge base — ${!space.ok ? space.message : entries.ok ? "" : entries.message}`}
            />
          ) : (
            <KbReader
              space={kbSpace}
              entries={kbEntries}
              projectId={projectId}
              canWrite={canWriteKb}
            />
          )}
        </div>

        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-4">
            <Eyebrow>conversation</Eyebrow>
            <OwnerConversation projectId={projectId} />
          </div>

          <Divider />

          <div className="flex flex-col gap-4">
            <Eyebrow>owner activity</Eyebrow>
            {ownerRuns.length === 0 ? (
              <p className="text-sm text-(--dim)">
                No Owner sessions yet{cron ? ` — next scheduled window is cron ${cron}` : ""}.
              </p>
            ) : (
              <div className="flex flex-col border border-(--line)">
                {ownerRuns.map((run) => (
                  <Link
                    key={run.id}
                    href={`/projects/${projectId}/sessions/${run.id}`}
                    className="flex items-center gap-3 border-b border-(--line) px-4 py-3 transition-colors last:border-b-0 hover:bg-(--card)"
                  >
                    <StatusDot tone={toneFor(run.status)} pulse={run.status === "running"} />
                    <span className="font-mono text-[12px] text-(--ink)">{run.mode}</span>
                    <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-(--mut)">
                      {run.status}
                    </span>
                    <span className="ml-auto font-mono text-[10.5px] text-(--dim)">
                      {fmtAgo(run.queuedAt)}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
