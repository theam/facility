import { AgentDetail } from "@/components/agents/agent-detail";
import { ErrorNotice, Offline } from "@/components/offline";
import { LiveRefresh } from "@/components/shell/live-refresh";
import { api } from "@/lib/api";

export const metadata = { title: "agent" };

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ projectId: string; agentId: string }>;
}) {
  const { projectId, agentId } = await params;
  const [agents, status, catalog, me, profiles, project] = await Promise.all([
    api.projectAgents(projectId),
    api.agentsStatus(projectId),
    api.catalog(),
    api.me(),
    api.sandboxProfiles(),
    api.project(projectId),
  ]);

  if (!agents.ok) return agents.offline ? <Offline /> : <ErrorNotice message={agents.message} />;
  const agent = agents.data.find((a) => a.id === agentId);
  if (!agent) return <ErrorNotice message="This agent doesn't exist in this project." />;
  if (!catalog.ok) return catalog.offline ? <Offline /> : <ErrorNotice message={catalog.message} />;

  const [item, runs] = await Promise.all([
    api.registryItem(agent.contractItemId),
    api.runs(projectId, `?agentDefId=${agent.id}&limit=15`),
  ]);
  if (!item.ok) return item.offline ? <Offline /> : <ErrorNotice message={item.message} />;

  return (
    <>
      <LiveRefresh seconds={20} />
      <AgentDetail
        projectId={projectId}
        agent={agent}
        status={status.ok ? (status.data.find((s) => s.agentId === agentId) ?? null) : null}
        item={item.data}
        catalog={catalog.data}
        myPermissions={me.ok ? me.data.permissions : []}
        sandboxProfiles={profiles.ok ? profiles.data.map((p) => ({ id: p.id, name: p.name })) : []}
        recentRuns={runs.ok ? runs.data : []}
        builderPlanPolicy={project.ok ? project.data.builderPlanPolicy : "required"}
      />
    </>
  );
}
