import { Eyebrow } from "@facility/ui";
import { CreateAgent } from "@/components/agents/create-agent";
import { ErrorNotice, Offline } from "@/components/offline";
import { api } from "@/lib/api";

export const metadata = { title: "new agent" };

export default async function NewAgentPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const [catalog, me] = await Promise.all([api.catalog(), api.me()]);
  if (!catalog.ok) return catalog.offline ? <Offline /> : <ErrorNotice message={catalog.message} />;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Eyebrow>agents / new</Eyebrow>
        <h1 className="text-[clamp(22px,3vw,32px)] font-semibold tracking-tight">New agent</h1>
        <p className="max-w-xl text-sm leading-relaxed text-(--mut)">
          Name it, give it a contract, choose when it wakes up. It runs governed from the first
          session: sandboxed, metered, audited.
        </p>
      </div>
      <CreateAgent
        projectId={projectId}
        catalog={catalog.data}
        myPermissions={me.ok ? me.data.permissions : []}
      />
    </div>
  );
}
