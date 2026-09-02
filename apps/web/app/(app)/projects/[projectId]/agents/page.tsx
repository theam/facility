import { Eyebrow, StatusDot } from "@facility/ui";
import { ErrorNotice, Offline } from "@/components/offline";
import { LiveRefresh } from "@/components/shell/live-refresh";
import { api, type StoryAgent } from "@/lib/api";

export const metadata = { title: "agents" };

export default async function ProjectAgentsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const result = await api.storyAgents(projectId);
  if (!result.ok) return result.offline ? <Offline /> : <ErrorNotice message={result.message} />;

  return (
    <div className="flex flex-col gap-8">
      <LiveRefresh seconds={30} />
      <header className="flex flex-col gap-2">
        <Eyebrow>agents as code</Eyebrow>
        <h1 className="text-[clamp(22px,3vw,32px)] font-semibold tracking-tight">Agents</h1>
        <p className="max-w-2xl text-[13px] leading-relaxed text-(--dim)">
          This catalog is read directly from{" "}
          <code className="font-mono text-(--ink)">.agents/</code> in the primary repository. Change
          prompts, engine, model, or triggers in Git and commit them like any other project
          configuration.
        </p>
      </header>

      <div className="grid gap-px border border-(--line) bg-(--line) lg:grid-cols-2">
        {result.data.agents.map((agent) => (
          <AgentCard key={agent.name} agent={agent} />
        ))}
      </div>

      <div className="border border-(--line) bg-(--bg-subtle) p-5 text-[12px] leading-relaxed text-(--mut)">
        Every agent receives the same full workspace, Docker, browser, network, and GitHub
        maintainer access. Per-agent permissions and tool allowlists are intentionally not part of
        the manifest.
      </div>
    </div>
  );
}

function AgentCard({ agent }: { agent: StoryAgent }) {
  return (
    <article className="flex flex-col gap-5 bg-(--bg) p-5 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <StatusDot tone={agent.enabled ? "agent" : "muted"} />
            <h2 className="font-mono text-[14px] font-semibold text-(--ink)">{agent.name}</h2>
          </div>
          <p className="mt-2 text-[12.5px] leading-relaxed text-(--mut)">{agent.description}</p>
        </div>
        <span className="font-mono text-[10px] text-(--dim)">
          {agent.enabled ? "enabled" : "disabled"}
        </span>
      </div>

      <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-2 text-[11.5px]">
        <dt className="text-(--dim)">engine</dt>
        <dd className="font-mono text-(--ink)">
          {agent.engine === "claude_code" ? "Claude Code" : "Codex"}
        </dd>
        <dt className="text-(--dim)">model</dt>
        <dd className="break-all font-mono text-(--ink)">{agent.model}</dd>
        <dt className="text-(--dim)">source</dt>
        <dd className="break-all font-mono text-(--mut)">{agent.file}</dd>
      </dl>

      <div className="flex flex-wrap gap-2">
        {agent.triggers.map((trigger, index) => (
          <span
            key={`${trigger.type}:${String(trigger.name ?? index)}`}
            className="border border-(--line) px-2 py-1 font-mono text-[10px] text-(--mut)"
          >
            {triggerLabel(trigger)}
          </span>
        ))}
      </div>
      <p className="font-mono text-[9.5px] text-(--dim)">
        {agent.commit_sha.slice(0, 10)} · {agent.hash.slice(0, 10)}
      </p>
    </article>
  );
}

function triggerLabel(trigger: StoryAgent["triggers"][number]) {
  if (trigger.type === "manual") return "manual";
  if (trigger.type === "schedule") {
    return `schedule · ${String(trigger.cron ?? "")} · ${String(trigger.timezone ?? "UTC")}`;
  }
  const action = Array.isArray(trigger.actions) ? ` · ${trigger.actions.join(",")}` : "";
  return `github · ${String(trigger.event ?? "event")}${action}`;
}
