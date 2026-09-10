import { redirect } from "next/navigation";

/** Pipeline was folded into Stories; old links land on the unified backlog. */
export default async function PipelinePage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  redirect(`/projects/${encodeURIComponent(projectId)}/stories`);
}
