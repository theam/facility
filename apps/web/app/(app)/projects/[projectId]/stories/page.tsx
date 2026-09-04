import { cx, Eyebrow, StatusDot } from "@facility/ui";
import Link from "next/link";
import { ErrorNotice, Offline } from "@/components/offline";
import { LiveRefresh } from "@/components/shell/live-refresh";
import { StartWorkspaceStory } from "@/components/story/start-workspace-story";
import { api, type WorkspaceStory } from "@/lib/api";
import { can } from "@/lib/permissions";

export const metadata = { title: "stories" };

const STATES: Array<{ value: WorkspaceStory["status"] | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "working", label: "Working" },
  { value: "attention", label: "Needs attention" },
  { value: "review", label: "Review" },
  { value: "done", label: "Done" },
  { value: "archived", label: "Archived" },
];

export default async function ProjectStoriesPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  const selected = STATES.find((state) => state.value === query.status)?.value ?? "all";
  const [storiesResult, agentsResult, me] = await Promise.all([
    api.workspaceStories(
      projectId,
      selected === "all" ? undefined : (selected as WorkspaceStory["status"]),
    ),
    api.storyAgents(projectId),
    api.me(),
  ]);

  if (!storiesResult.ok && storiesResult.offline) return <Offline />;
  const stories = storiesResult.ok ? storiesResult.data.stories : [];
  const agents = agentsResult.ok ? agentsResult.data.agents : [];
  const canStart = me.ok && can(me.data.permissions, "runs:execute");

  return (
    <div className="flex flex-col gap-8">
      <LiveRefresh seconds={10} />
      <header className="flex flex-col gap-2">
        <Eyebrow>persistent work</Eyebrow>
        <h1 className="text-[clamp(22px,3vw,32px)] font-semibold tracking-tight">Stories</h1>
        <p className="max-w-2xl text-[13px] leading-relaxed text-(--dim)">
          One conversation, worktree, and native Claude or Codex session for the full life of the
          work. Nothing expires automatically.
        </p>
      </header>

      {canStart && agents.length > 0 ? (
        <section className="flex flex-col gap-3">
          <Eyebrow>start a story</Eyebrow>
          <StartWorkspaceStory projectId={projectId} agents={agents} />
        </section>
      ) : !agentsResult.ok ? (
        <ErrorNotice message={`Couldn't load .agents — ${agentsResult.message}`} />
      ) : null}

      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <Eyebrow>{stories.length} stories</Eyebrow>
          <nav aria-label="Story status" className="flex flex-wrap gap-2">
            {STATES.map((state) => (
              <Link
                key={state.value}
                href={
                  state.value === "all"
                    ? `/projects/${projectId}/stories`
                    : `/projects/${projectId}/stories?status=${state.value}`
                }
                aria-current={selected === state.value ? "page" : undefined}
                className={cx(
                  "border px-3 py-1.5 text-[12px] transition-colors",
                  selected === state.value
                    ? "border-(--line-strong) text-(--ink)"
                    : "border-(--line) text-(--mut) hover:text-(--ink)",
                )}
              >
                {state.label}
              </Link>
            ))}
          </nav>
        </div>

        {!storiesResult.ok ? (
          <ErrorNotice message={`Couldn't load stories — ${storiesResult.message}`} />
        ) : stories.length === 0 ? (
          <div className="border border-(--line) p-8 text-sm text-(--dim)">
            No stories match this view.
          </div>
        ) : (
          <div className="flex flex-col border border-(--line)">
            {stories.map((story) => (
              <StoryRow key={story.id} projectId={projectId} story={story} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function StoryRow({ projectId, story }: { projectId: string; story: WorkspaceStory }) {
  const active = story.status === "working";
  return (
    <Link
      href={`/projects/${encodeURIComponent(projectId)}/stories/${encodeURIComponent(story.id)}`}
      className="group grid gap-3 border-b border-(--line) px-4 py-4 last:border-b-0 hover:bg-(--bg-subtle) sm:grid-cols-[minmax(0,1fr)_auto] sm:px-5"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <StatusDot tone={storyTone(story.status)} pulse={active} />
          <span className="truncate text-[13.5px] font-medium text-(--ink)">{story.title}</span>
        </div>
        <p className="mt-1.5 truncate font-mono text-[10.5px] text-(--dim)">
          {story.provider}:{story.externalId}
          {story.branch ? ` · ${story.branch}` : ""}
        </p>
      </div>
      <div className="flex items-center gap-4 text-[11.5px] text-(--dim)">
        {story.activeAgentName ? (
          <span className="font-mono text-(--accent)">{story.activeAgentName}</span>
        ) : null}
        <span>{story.status}</span>
        <span aria-hidden className="group-hover:text-(--ink)">
          →
        </span>
      </div>
    </Link>
  );
}

function storyTone(status: WorkspaceStory["status"]) {
  if (status === "working") return "agent" as const;
  if (status === "attention") return "bad" as const;
  if (status === "done") return "ok" as const;
  if (status === "review") return "human" as const;
  return "machine" as const;
}
