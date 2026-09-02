import { Eyebrow, StatusDot } from "@facility/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Markdown } from "@/components/markdown";
import { ErrorNotice, Offline } from "@/components/offline";
import { LiveRefresh } from "@/components/shell/live-refresh";
import { StoryComposer, WorkspaceControls } from "@/components/story/workspace-story-controls";
import { api, type StoryMessage, type WorkspaceStory } from "@/lib/api";
import { can } from "@/lib/permissions";

export async function generateMetadata({ params }: { params: Promise<{ number: string }> }) {
  const { number } = await params;
  return { title: `story ${number}` };
}

export default async function StoryPage({
  params,
}: {
  params: Promise<{ projectId: string; number: string }>;
}) {
  const { projectId, number: storyId } = await params;
  const [detail, conversation, environment, agents, me] = await Promise.all([
    api.workspaceStory(projectId, storyId),
    api.workspaceStoryConversation(projectId, storyId),
    api.workspaceStoryEnvironment(projectId, storyId),
    api.storyAgents(projectId),
    api.me(),
  ]);

  if (!detail.ok) {
    if (detail.offline) return <Offline />;
    if (detail.status === 404) notFound();
    return <ErrorNotice message={`Couldn't load this story — ${detail.message}`} />;
  }

  const bundle = detail.data;
  const story = bundle.story;
  const pullRequestUrl = safeExternalUrl(story.pullRequestUrl);
  const messages = conversation.ok ? conversation.data.messages : [];
  const agentRows = agents.ok ? agents.data.agents : [];
  const permissions = me.ok ? me.data.permissions : [];
  const canExecute = can(permissions, "workspaces:execute");
  const canWrite = can(permissions, "projects:write");

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8">
      <LiveRefresh seconds={8} />
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Eyebrow>
            {story.provider}:{story.externalId}
          </Eyebrow>
          <Link
            href={`/projects/${encodeURIComponent(projectId)}/stories`}
            className="text-[11.5px] text-(--dim) hover:text-(--ink)"
          >
            ← all stories
          </Link>
        </div>
        <h1 className="text-[clamp(22px,3vw,32px)] font-semibold tracking-tight">{story.title}</h1>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11.5px] text-(--mut)">
          <span className="inline-flex items-center gap-2">
            <StatusDot tone={storyTone(story.status)} pulse={story.status === "working"} />
            {story.status}
          </span>
          {story.activeAgentName ? (
            <span className="font-mono text-(--accent)">{story.activeAgentName} active</span>
          ) : null}
          {story.branch ? <span className="font-mono">{story.branch}</span> : null}
          {pullRequestUrl ? (
            <a
              href={pullRequestUrl}
              target="_blank"
              rel="noreferrer"
              className="text-(--info) underline-offset-4 hover:underline"
            >
              PR #{story.pullRequestNumber} ↗
            </a>
          ) : null}
        </div>
      </header>

      {bundle.attention.length > 0 ? (
        <section className="flex flex-col gap-3 border border-(--bad)/50 bg-(--bg-subtle) p-5">
          <Eyebrow className="text-(--bad)">needs attention</Eyebrow>
          {bundle.attention.map((item) => (
            <div key={item.id}>
              <p className="text-[13px] font-medium text-(--ink)">{item.title}</p>
              {item.detail ? <p className="mt-1 text-[12px] text-(--mut)">{item.detail}</p> : null}
            </div>
          ))}
        </section>
      ) : null}

      <section className="grid gap-6 border border-(--line) p-5 lg:grid-cols-[minmax(0,1fr)_300px] lg:p-6">
        <div className="flex min-w-0 flex-col gap-4">
          <Eyebrow>workspace</Eyebrow>
          {bundle.workspace ? (
            <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-2 text-[11.5px]">
              <dt className="text-(--dim)">state</dt>
              <dd>{bundle.workspace.state}</dd>
              <dt className="text-(--dim)">provider</dt>
              <dd className="font-mono">{bundle.workspace.provider}</dd>
              <dt className="text-(--dim)">image</dt>
              <dd className="break-all font-mono">{bundle.workspace.environment.image ?? "—"}</dd>
              <dt className="text-(--dim)">volume</dt>
              <dd className="break-all font-mono text-(--mut)">{bundle.workspace.volumeRef}</dd>
              <dt className="text-(--dim)">last active</dt>
              <dd>{formatTime(bundle.workspace.lastActivityAt)}</dd>
            </dl>
          ) : (
            <p className="text-sm text-(--dim)">Workspace has not been created.</p>
          )}
        </div>
        <WorkspaceControls
          projectId={projectId}
          story={story}
          workspace={bundle.workspace}
          canExecute={canExecute}
          canWrite={canWrite}
        />
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between gap-4">
          <Eyebrow>conversation · {messages.length}</Eyebrow>
          <span className="text-[11px] text-(--dim)">shared by every agent on this story</span>
        </div>
        {!conversation.ok ? (
          <ErrorNotice message={`Couldn't load conversation — ${conversation.message}`} />
        ) : messages.length === 0 ? (
          <p className="border border-(--line) p-6 text-sm text-(--dim)">No messages yet.</p>
        ) : (
          <div className="flex flex-col gap-px border border-(--line) bg-(--line)">
            {messages.map((message) => (
              <Message key={message.id} message={message} />
            ))}
          </div>
        )}
        {canExecute && story.deletedAt === null && agentRows.length > 0 ? (
          <StoryComposer projectId={projectId} storyId={story.id} agents={agentRows} />
        ) : null}
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <Eyebrow>turns</Eyebrow>
          <div className="flex flex-col border border-(--line)">
            {bundle.turns.length === 0 ? (
              <p className="p-5 text-[12px] text-(--dim)">No turns yet.</p>
            ) : (
              bundle.turns.map((turn) => (
                <div key={turn.id} className="border-b border-(--line) p-4 last:border-b-0">
                  <div className="flex items-center justify-between gap-3 text-[11.5px]">
                    <span className="font-mono text-(--ink)">{turn.agentName}</span>
                    <span className={turn.state === "failed" ? "text-(--bad)" : "text-(--mut)"}>
                      {turn.state}
                    </span>
                  </div>
                  <p className="mt-1 font-mono text-[10px] text-(--dim)">
                    {turn.engine} · {turn.model}
                  </p>
                  {turn.error ? (
                    <p className="mt-2 text-[11.5px] text-(--bad)">{turn.error}</p>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <Eyebrow>environment events</Eyebrow>
          {!environment.ok ? (
            <ErrorNotice message={environment.message} />
          ) : (
            <div className="max-h-96 overflow-auto border border-(--line) bg-(--bg-subtle) p-4 font-mono text-[10.5px] leading-relaxed">
              {environment.data.events.length === 0 ? (
                <p className="text-(--dim)">No environment events yet.</p>
              ) : (
                environment.data.events.map((event) => (
                  <div key={event.seq} className="mb-3 last:mb-0">
                    <p className="text-(--accent)">
                      {event.seq} · {event.type}
                    </p>
                    <pre className="mt-1 whitespace-pre-wrap break-words text-(--mut)">
                      {JSON.stringify(event.data, null, 2)}
                    </pre>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </section>

      {bundle.artifacts.length > 0 ? (
        <section className="flex flex-col gap-3">
          <Eyebrow>artifacts</Eyebrow>
          <div className="flex flex-col border border-(--line)">
            {bundle.artifacts.map((artifact) => (
              <div
                key={artifact.id}
                className="flex items-center gap-3 border-b border-(--line) p-4 last:border-b-0"
              >
                <span className="font-mono text-[10px] text-(--dim)">{artifact.kind}</span>
                {safeExternalUrl(artifact.uri) ? (
                  <a
                    href={artifact.uri}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[12px] text-(--info) hover:underline"
                  >
                    {artifact.label} ↗
                  </a>
                ) : (
                  <span className="text-[12px] text-(--mut)">
                    {artifact.label} · {artifact.uri}
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function Message({ message }: { message: StoryMessage }) {
  const isAgent = message.role === "agent";
  return (
    <article className="bg-(--bg) p-5 sm:p-6">
      <div className="mb-3 flex flex-wrap items-center gap-3 text-[10.5px]">
        <span className={`font-mono ${isAgent ? "text-(--accent)" : "text-(--human)"}`}>
          {isAgent ? "agent" : (message.actor?.id ?? message.role)}
        </span>
        {message.requestedAgentName ? (
          <span className="font-mono text-(--dim)">→ {message.requestedAgentName}</span>
        ) : null}
        <time className="ml-auto text-(--dim)" dateTime={message.createdAt}>
          {formatTime(message.createdAt)}
        </time>
      </div>
      <Markdown source={message.body} />
    </article>
  );
}

function storyTone(status: WorkspaceStory["status"]) {
  if (status === "working") return "agent" as const;
  if (status === "attention") return "bad" as const;
  if (status === "done") return "ok" as const;
  if (status === "review") return "human" as const;
  return "machine" as const;
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date)
    : value;
}

function safeExternalUrl(value: string | null) {
  if (!value) return null;
  try {
    return ["https:", "http:"].includes(new URL(value).protocol) ? value : null;
  } catch {
    return null;
  }
}
