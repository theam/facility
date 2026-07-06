import { Eyebrow } from "@facility/ui";
import Link from "next/link";
import { AgentRow } from "@/components/harness/agent-editor";
import { ErrorNotice, Offline } from "@/components/offline";
import { api } from "@/lib/api";

export const metadata = { title: "agents" };

export default async function ProjectAgentsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const agents = await api.projectAgents(projectId);
  if (!agents.ok) return agents.offline ? <Offline /> : <ErrorNotice message={agents.message} />;

  const items = agents.data;
  const scheduled = items.filter((a) =>
    a.triggers.some((t) => (t as { type?: string }).type === "schedule"),
  ).length;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Eyebrow>agents</Eyebrow>
        <h1 className="text-[clamp(22px,3vw,32px)] font-semibold tracking-tight">Agents</h1>
        <p className="font-mono text-[11.5px] uppercase tracking-[0.14em] text-(--dim)">
          {items.length} configured · {items.filter((a) => a.enabled).length} enabled · {scheduled}{" "}
          scheduled
        </p>
      </div>

      {items.length === 0 ? (
        <p className="max-w-lg text-sm leading-relaxed text-(--dim)">
          No agents configured for this project. Kickstart seeds the standard set (architect,
          builder, project-owner, learning); custom ones can be created via the API/CLI for now.
        </p>
      ) : (
        <div className="flex flex-col border border-(--line)">
          {items.map((agent) => (
            <AgentRow key={agent.id} projectId={projectId} agent={agent} />
          ))}
        </div>
      )}

      <p className="max-w-xl text-[12.5px] leading-relaxed text-(--mut)">
        An agent's prompt is its contract — a versioned{" "}
        <Link href="/harness" className="text-(--ink) underline underline-offset-4">
          harness item
        </Link>
        : edit drafts and publish there; the next session picks up the active version.
      </p>
    </div>
  );
}
