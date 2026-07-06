import { notFound } from "next/navigation";
import { ErrorNotice, Offline } from "@/components/offline";
import { CommandPalette } from "@/components/shell/cmdk";
import { MobileNav, Sidebar } from "@/components/shell/nav";
import { RememberProject } from "@/components/shell/remember-project";
import { Topbar } from "@/components/shell/topbar";
import { api } from "@/lib/api";

/** The project world: everything under /projects/[projectId] is scoped to it. */
export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const [me, project, projects, inbox] = await Promise.all([
    api.me(),
    api.project(projectId),
    api.projects(),
    api.inboxFull(),
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
  const inboxCount = inbox.ok ? inbox.data.proposals.length + inbox.data.issues.length : undefined;
  const navProject = { id: p.id, slug: p.slug };

  return (
    <div className="flex min-h-dvh">
      <Sidebar project={navProject} inboxCount={inboxCount} />
      <div className="min-w-0 flex-1">
        <MobileNav project={navProject} inboxCount={inboxCount} />
        {me.ok ? <Topbar me={me.data} projects={projectList} current={p} /> : null}
        <main className="px-5 py-8 sm:px-8 lg:px-10">{children}</main>
      </div>
      <CommandPalette projects={projectList} currentProject={p} />
      <RememberProject projectId={p.id} />
    </div>
  );
}
