import { redirect } from "next/navigation";
import { ErrorNotice, Offline } from "@/components/offline";
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
    // Only a real auth failure logs you out. A throttled or erroring control
    // plane (429/5xx) must degrade honestly, not bounce the session to /login.
    if (me.status === 401 || me.status === 403) redirect("/login");
    return (
      <div className="mx-auto flex min-h-dvh max-w-3xl items-center px-6">
        <ErrorNotice message={`The control plane answered ${me.status} — ${me.message}`} />
      </div>
    );
  }

  return children;
}
