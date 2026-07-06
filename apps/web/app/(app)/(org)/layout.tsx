import { CommandPalette } from "@/components/shell/cmdk";
import { MobileNav, Sidebar } from "@/components/shell/nav";
import { Topbar } from "@/components/shell/topbar";
import { api } from "@/lib/api";

export default async function OrgLayout({ children }: { children: React.ReactNode }) {
  const [me, projects, inbox] = await Promise.all([api.me(), api.projects(), api.inboxFull()]);
  const projectList = projects.ok ? projects.data : [];
  const inboxCount = inbox.ok ? inbox.data.proposals.length + inbox.data.issues.length : undefined;

  return (
    <div className="flex min-h-dvh">
      <Sidebar inboxCount={inboxCount} />
      <div className="min-w-0 flex-1">
        <MobileNav inboxCount={inboxCount} />
        {me.ok ? <Topbar me={me.data} projects={projectList} /> : null}
        <main className="px-5 py-8 sm:px-8 lg:px-10">{children}</main>
      </div>
      <CommandPalette projects={projectList} />
    </div>
  );
}
