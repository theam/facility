import { notFound } from "next/navigation";
import { AskBar } from "@/components/ask/ask-bar";
import { ErrorNotice, Offline } from "@/components/offline";
import { CommandPalette } from "@/components/shell/cmdk";
import { MobileNav, Sidebar } from "@/components/shell/nav";
import { RememberProject } from "@/components/shell/remember-project";
import { Topbar } from "@/components/shell/topbar";
import { api } from "@/lib/api";
import { pipelineStories } from "@/lib/pipeline";

/** The project world: everything under /projects/[projectId] is scoped to it. */
export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const [me, project, projects, inbox, pipeline] = await Promise.all([
    api.me(),
    api.project(projectId),
    api.projects(),
    api.inboxFull(),
    api.pipeline(projectId),
  ]);

  if (!project.ok) {
    if (project.offline) {
      return (
        <div className="mx-auto flex min-h-dvh max-w-3xl items-center px-6">
          <Offline detail={project.message} />
        </div>
      );
    }
    if (project.status === 404) notFound();
    return (
      <div className="mx-auto flex min-h-dvh max-w-3xl items-center px-6">
        <ErrorNotice message={`Couldn't load this project — ${project.message}`} />
      </div>
    );
  }

  const p = project.data;
  const projectList = projects.ok ? projects.data : [];
  // Approvals are a project surface — the badge counts only this project's.
  const inboxCount = inbox.ok
    ? inbox.data.proposals.filter((item) => item.projectId === p.id).length +
      inbox.data.issues.filter((item) => item.projectId === p.id).length
    : undefined;
  const navProject = { id: p.id, slug: p.slug, name: p.name };
  const stories = pipeline.ok ? pipelineStories(pipeline.data) : [];

  return (
    // App shell: the viewport is the frame; only the work area (main) scrolls,
    // so full-height tabs like Product can fill it edge to edge.
    <div className="flex h-dvh">
      <Sidebar project={navProject} inboxCount={inboxCount} />
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileNav project={navProject} inboxCount={inboxCount} />
        {me.ok ? <Topbar me={me.data} projects={projectList} current={p} /> : null}
        <main className="app-main min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
      <CommandPalette projects={projectList} currentProject={p} />
      <AskBar projectId={p.id} />
      <RememberProject projectId={p.id} />
    </div>
  );
}