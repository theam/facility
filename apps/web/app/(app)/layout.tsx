import { redirect } from "next/navigation";
import { Offline } from "@/components/offline";
import { api } from "@/lib/api";

/**
 * Auth gate only. Chrome (sidebar/topbar) lives one level down: org pages get
 * the thin org shell, `/projects/[projectId]/*` gets the project world shell.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await api.me();

  if (!me.ok) {
    if (me.offline) {
      return (
        <div className="mx-auto flex min-h-dvh max-w-3xl items-center px-6">
          <Offline detail={me.message} />
        </div>
      );
    }
    redirect("/login");
  }

  return children;
}
