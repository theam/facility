import { notFound, redirect } from "next/navigation";
import { ErrorNotice, Offline } from "@/components/offline";
import { RunCockpit } from "@/components/run/cockpit";
import { api } from "@/lib/api";

export const metadata = { title: "session" };

export default async function SessionPage({
  params,
}: {
  params: Promise<{ projectId: string; runId: string }>;
}) {
  const { projectId, runId } = await params;
  const [run, me, events] = await Promise.all([api.run(runId), api.me(), api.runEvents(runId)]);

  if (!run.ok) {
    if (run.offline) return <Offline />;
    if (run.status === 404) notFound();
    return <ErrorNotice message={`session not found (${run.status})`} />;
  }

  // Canonicalize: a session belongs to exactly one project world.
  if (run.data.projectId !== projectId) {
    redirect(`/projects/${run.data.projectId}/sessions/${runId}`);
  }

  const r = run.data;
  const [project, agents] = await Promise.all([
    api.project(r.projectId),
    api.projectAgents(r.projectId),
  ]);
  const agentDisplayName = agents.ok
    ? agents.data.find((agent) => agent.id === r.agentDefId)?.name
    : undefined;

  return (
    <RunCockpit
      run={r}
      project={project.ok ? project.data : null}
      agentDisplayName={agentDisplayName}
      permissions={me.ok ? me.data.permissions : []}
      initialEvents={events.ok ? events.data : []}
      initialEventsError={!events.ok}
    />
  );
}
