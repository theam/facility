import { Eyebrow, Metric, StatusDot } from "@facility/ui";
import Link from "next/link";
import { ErrorNotice, Offline } from "@/components/offline";
import { LiveRefresh } from "@/components/shell/live-refresh";
import { api, type WorkspaceStory } from "@/lib/api";

export const metadata = { title: "overview" };

export default async function ProjectOverviewPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const [project, storiesResult, agentsResult, repos] = await Promise.all([
    api.project(projectId),
    api.workspaceStories(projectId),
    api.storyAgents(projectId),
    api.projectRepos(projectId),
  ]);
  if (!project.ok) {
    return project.offline ? <Offline /> : <ErrorNotice message={project.message} />;
  }

  const stories = storiesResult.ok ? storiesResult.data.stories : [];
  const working = stories.filter((story) => story.status === "working");
  const attention = stories.filter((story) => story.status === "attention");
  const retained = stories.filter((story) => story.deletedAt === null);
  const agents = agentsResult.ok ? agentsResult.data.agents : [];
  const activeAgents = agents.filter((agent) => agent.enabled);

  return (
    <div className="flex flex-col gap-10">
      <LiveRefresh seconds={10} />
      <header className="flex flex-col gap-3">
        <Eyebrow>workspace control</Eyebrow>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="text-[clamp(24px,3.2vw,36px)] font-semibold tracking-tight">
            {project.data.name}
          </h1>
          <span className="inline-flex items-center gap-2 text-[12px] text-(--mut)">
            <StatusDot tone={attention.length > 0 ? "bad" : "ok"} />
            {attention.length > 0 ? `${attention.length} need attention` : "ready"}
          </span>
        </div>
        {project.data.description ? (
          <p className="max-w-2xl text-sm leading-relaxed text-(--mut)">
            {project.data.description}
          </p>
        ) : null}
        {repos.ok ? (
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {repos.data.map((repo) => (
              <a
                key={repo.id}
                href={`https://github.com/${repo.owner}/${repo.name}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[11.5px] text-(--info) underline-offset-4 hover:underline"
              >
                {repo.owner}/{repo.name} ↗
              </a>
            ))}
          </div>
        ) : null}
      </header>

      <section className="grid gap-px border border-(--line) bg-(--line) sm:grid-cols-2 lg:grid-cols-4">
        <MetricCell label="working" value={working.length} hint="active story turns" />
        <MetricCell label="attention" value={attention.length} hint="errors or questions" />
        <MetricCell label="retained" value={retained.length} hint="durable workspaces" />
        <MetricCell label="agents" value={activeAgents.length} hint="enabled in .agents/" />
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between gap-4">
          <Eyebrow>recent stories</Eyebrow>
          <Link
            href={`/projects/${projectId}/stories`}
            className="text-[12px] text-(--mut) hover:text-(--ink)"
          >
            all stories →
          </Link>
        </div>
        {!storiesResult.ok ? (
          <ErrorNotice message={storiesResult.message} />
        ) : stories.length === 0 ? (
          <div className="border border-(--line) p-8 text-sm text-(--dim)">
            Start the first story from the Stories page or through MCP.
          </div>
        ) : (
          <div className="flex flex-col border border-(--line)">
            {stories.slice(0, 8).map((story) => (
              <RecentStory key={story.id} projectId={projectId} story={story} />
            ))}
          </div>
        )}
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="border border-(--line) bg-(--bg-subtle) p-6">
          <Eyebrow>runtime model</Eyebrow>
          <p className="mt-4 text-[13px] leading-relaxed text-(--mut)">
            Compute may sleep or be replaced. The volume, repository worktrees, conversation, and
            native Claude Code or Codex sessions remain until explicit deletion.
          </p>
        </div>
        <div className="border border-(--line) bg-(--bg-subtle) p-6">
          <Eyebrow>agent model</Eyebrow>
          <p className="mt-4 text-[13px] leading-relaxed text-(--mut)">
            Manual, GitHub, and scheduled triggers all enter the same serialized dispatcher. Every
            agent has full maintainer access to configured repositories and full workspace access.
          </p>
          <Link
            href={`/projects/${projectId}/agents`}
            className="mt-4 inline-block text-[12px] text-(--accent) hover:underline"
          >
            inspect .agents →
          </Link>
        </div>
      </section>
    </div>
  );
}

function MetricCell({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="bg-(--bg) p-5">
      <Metric label={label} value={String(value)} hint={hint} />
    </div>
  );
}

function RecentStory({ projectId, story }: { projectId: string; story: WorkspaceStory }) {
  return (
    <Link
      href={`/projects/${encodeURIComponent(projectId)}/stories/${encodeURIComponent(story.id)}`}
      className="flex items-center gap-3 border-b border-(--line) px-5 py-4 last:border-b-0 hover:bg-(--bg-subtle)"
    >
      <StatusDot
        tone={
          story.status === "attention"
            ? "bad"
            : story.status === "working"
              ? "agent"
              : story.status === "done"
                ? "ok"
                : "machine"
        }
        pulse={story.status === "working"}
      />
      <span className="min-w-0 flex-1 truncate text-[13px] text-(--ink)">{story.title}</span>
      {story.activeAgentName ? (
        <span className="font-mono text-[10.5px] text-(--accent)">{story.activeAgentName}</span>
      ) : null}
      <span className="text-[11px] text-(--dim)">{story.status}</span>
    </Link>
  );
}
