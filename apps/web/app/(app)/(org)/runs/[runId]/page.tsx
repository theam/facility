import { redirect } from "next/navigation";
import { ErrorNotice, Offline } from "@/components/offline";
import { api } from "@/lib/api";

/** Legacy path — sessions are project-scoped now. Old links keep working. */
export default async function LegacyRunRedirect({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  const run = await api.run(runId);
  if (!run.ok) {
    return run.offline ? (
      <Offline />
    ) : (
      <ErrorNotice message={`session not found (${run.status})`} />
    );
  }
  redirect(`/projects/${run.data.projectId}/sessions/${runId}`);
}
