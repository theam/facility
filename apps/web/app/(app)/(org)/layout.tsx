import { MobileNav, Sidebar } from "@/components/shell/nav";
import { Topbar } from "@/components/shell/topbar";
import { api } from "@/lib/api";

export default async function OrgLayout({ children }: { children: React.ReactNode }) {
  const [me, projects] = await Promise.all([api.me(), api.projects()]);
  const projectList = projects.ok ? projects.data : [];

  return (
    <div className="flex min-h-dvh">
      <Sidebar />
      <div className="min-w-0 flex-1">
        <MobileNav />
        {me.ok ? <Topbar me={me.data} projects={projectList} /> : null}
        <main className="px-5 py-8 sm:px-8 lg:px-10">{children}</main>
      </div>
    </div>
  );
}
