import { Eyebrow, StatusDot } from "@facility/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Markdown } from "@/components/markdown";
import { ErrorNotice, Offline } from "@/components/offline";
import { LiveRefresh } from "@/components/shell/live-refresh";
import { AttentionActions } from "@/components/story/attention-actions";
import {
  CancelTurnButton,
  StoryComposer,
  WorkspaceControls,
} from "@/components/story/workspace-story-controls";
import { api, type StoryEnvironment, type StoryMessage, type WorkspaceStory } from "@/lib/api";
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
        <section
          className={`flex flex-col gap-3 border bg-(--bg-subtle) p-5 ${
            bundle.needs_attention ? "border-(--bad)/50" : "border-(--line)"
          }`}
        >
          <Eyebrow className={bundle.needs_attention ? "text-(--bad)" : undefined}>
            attention history
          </Eyebrow>
          {bundle.attention.map((item) => (
            <div
              key={item.id}
              className="border-t border-(--line) pt-3 first:border-t-0 first:pt-0"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[9.5px] uppercase text-(--dim)">{item.kind}</span>
                <span
                  className={
                    item.status === "open" ? "text-[10px] text-(--bad)" : "text-[10px] text-(--ok)"
                  }
                >
                  {item.status === "open" ? "open" : (item.resolution ?? "resolved")}
                </span>
              </div>
              <p className="mt-1 text-[13px] font-medium text-(--ink)">{item.title}</p>
              {item.detail ? <p className="mt-1 text-[12px] text-(--mut)">{item.detail}</p> : null}
              <p className="mt-1 text-[10px] text-(--dim)">
                {formatTime(item.createdAt)}
                {item.resolvedAt ? ` · resolved ${formatTime(item.resolvedAt)}` : ""}
              </p>
              {canExecute ? (
                <AttentionActions projectId={projectId} storyId={story.id} item={item} />
              ) : null}
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
              {environment.ok ? (
                <>
                  <dt className="text-(--dim)">compute</dt>
                  <dd>{environment.data.metrics.active_compute ? "active" : "not active"}</dd>
                  <dt className="text-(--dim)">storage</dt>
                  <dd>{environment.data.metrics.retained_storage ? "retained" : "deleted"}</dd>
                  <dt className="text-(--dim)">create / wake</dt>
                  <dd>
                    {formatDuration(environment.data.metrics.create_time_ms)} /{" "}
                    {formatDuration(environment.data.metrics.wake_time_ms)}
                  </dd>
                  <dt className="text-(--dim)">cost</dt>
                  <dd>{formatCost(environment.data.metrics.cost)}</dd>
                </>
              ) : null}
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

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-4">
          <Eyebrow>story timeline · {bundle.timeline.length}</Eyebrow>
          <span className="text-[11px] text-(--dim)">
            agent, workspace, Git and GitHub evidence
          </span>
        </div>
        <div className="flex flex-col border border-(--line)">
          {bundle.timeline.map((event) => (
            <article
              key={event.id}
              className="grid gap-2 border-b border-(--line) p-4 last:border-b-0 sm:grid-cols-[130px_minmax(0,1fr)]"
            >
              <div>
                <p className="font-mono text-[9.5px] uppercase text-(--accent)">{event.source}</p>
                <time className="text-[10px] text-(--dim)" dateTime={event.occurred_at}>
                  {formatTime(event.occurred_at)}
                </time>
              </div>
              <div className="min-w-0">
                <p className="font-mono text-[11px] text-(--ink)">{event.type}</p>
                <p className="mt-1 text-[11.5px] leading-relaxed text-(--mut)">
                  {timelineSummary(event.type, event.data)}
                </p>
                {event.turn_id ? (
                  <p className="mt-1 font-mono text-[9.5px] text-(--dim)">turn {event.turn_id}</p>
                ) : null}
              </div>
            </article>
          ))}
        </div>
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
                  {canExecute && ["queued", "running"].includes(turn.state) ? (
                    <CancelTurnButton projectId={projectId} storyId={story.id} turnId={turn.id} />
                  ) : null}
                </div>
              ))
            )}
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <Eyebrow>services and recent logs</Eyebrow>
          {!environment.ok ? (
            <ErrorNotice message={environment.message} />
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                {(environment.data.workspace.environment.ports ?? []).map((service) => (
                  <span
                    key={service.service}
                    className="border border-(--line) px-2 py-1 font-mono text-[10px] text-(--mut)"
                  >
                    {service.service}:{service.port} · {environment.data.inspection.state}
                  </span>
                ))}
              </div>
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

function timelineSummary(type: string, data: Record<string, unknown>) {
  const text = (key: string) => (typeof data[key] === "string" ? String(data[key]) : null);
  const count = (key: string) => (Array.isArray(data[key]) ? data[key].length : 0);
  if (type === "story.created") return text("title") ?? "Story created.";
  if (type === "turn.context_recorded") {
    return [text("agent"), text("model"), text("initialSha")?.slice(0, 10), text("branch")]
      .filter(Boolean)
      .join(" · ");
  }
  if (type === "git.changes_recorded") {
    return `${count("commits")} commits · ${count("changedFiles")} changed files · ${text("initialSha")?.slice(0, 10) ?? "unknown"} → ${text("finalSha")?.slice(0, 10) ?? "unknown"}`;
  }
  if (type === "github.branch_observed" || type === "github.branch_deleted") {
    return `${text("branch") ?? "branch"} · ${text("headSha")?.slice(0, 10) ?? "unknown"} · ${text("actor") ?? "external"}`;
  }
  if (type === "github.pull_request_observed") {
    return `PR #${String(data.number ?? "?")} · ${text("state") ?? "unknown"} · ${text("title") ?? ""}`;
  }
  if (type === "github.review_observed") {
    return `${text("author") ?? "unknown reviewer"} · ${text("state") ?? "reviewed"} · PR #${String(data.pullNumber ?? "?")}`;
  }
  if (type === "github.check_observed") {
    return `${text("name") ?? "check"} · ${text("conclusion") ?? text("status") ?? "unknown"}`;
  }
  if (type === "story.collision_detected") {
    const extra = Number(data.overlapCount ?? 0) - count("overlappingPaths");
    return `overlaps "${text("title") ?? "another story"}" on ${String(data.overlapCount ?? "?")} files · ${text("branch") ?? "unknown branch"}${extra > 0 ? ` · ${extra} not listed` : ""}`;
  }
  if (type === "artifact.recorded") return text("label") ?? "Artifact recorded.";
  if (type.startsWith("attention.")) return text("title") ?? type;
  if (type === "turn.failed") return text("error") ?? "Turn failed.";
  return type.replaceAll(".", " ");
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

function formatDuration(value: number | null) {
  return value === null ? "—" : `${value} ms`;
}

function formatCost(cost: StoryEnvironment["metrics"]["cost"]) {
  if (cost.active_compute_cents === null && cost.retained_storage_cents === null) {
    return "not reported by provider";
  }
  return `${cost.active_compute_cents ?? 0}¢ compute · ${cost.retained_storage_cents ?? 0}¢ storage`;
}

function safeExternalUrl(value: string | null) {
  if (!value) return null;
  try {
    return ["https:", "http:"].includes(new URL(value).protocol) ? value : null;
  } catch {
    return null;
  }
}
